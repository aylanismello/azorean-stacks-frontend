#!/usr/bin/env bun
/**
 * The Stacks — Realtime Seed Watcher
 *
 * Subscribes to Supabase Realtime INSERT events on the `seeds` table.
 * When a new seed is inserted, immediately runs the discover+enrich+download
 * pipeline for that seed — no waiting for the next engine cycle.
 *
 * Usage: bun run watcher
 */
import { getSupabase } from "../lib/supabase";
import {
  log, elapsed, sleep,
  ntsSearch, ntsTracklist, ntsEpisodeArtwork,
  isSameTrack,
  enrichTrack, downloadTrack,
  spotifyLookup,
  logEngineEvent,
} from "../lib/pipeline";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";

const db = getSupabase();
const STATUS_FILE = `${process.env.HOME}/.openclaw/data/azorean-engine-status.json`;

const ENRICH_CONCURRENCY = 5;
const NTS_MAX_EPISODES = 10;
const GARBAGE_TITLES = new Set(["unknown track", "untitled", "id", "?", "unknown", ""]);

// ─── STATUS TRACKING ────────────────────────────────────────

let watcherConnectedAt: string | null = null;
let lastEventAt: string | null = null;

function updateStatusFile() {
  try {
    if (!existsSync(STATUS_FILE)) return;
    const raw = readFileSync(STATUS_FILE, "utf-8");
    const status = JSON.parse(raw);
    status.watcher_connected_at = watcherConnectedAt;
    status.last_event_at = lastEventAt;
    writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
  } catch {
    // Non-critical — don't crash
  }
}

// ─── SEED PIPELINE ──────────────────────────────────────────

async function processSeed(seedId: string) {
  const t0 = Date.now();

  // Read seed record
  const { data: seed, error: seedErr } = await db.from("seeds")
    .select("*").eq("id", seedId).single();

  if (seedErr || !seed) {
    log("fail", `Could not read seed ${seedId}: ${seedErr?.message ?? "not found"}`);
    await logEngineEvent("error", "failed", {
      seedId,
      message: `Could not read seed: ${seedErr?.message ?? "not found"}`,
    });
    return;
  }

  const seedLabel = `${seed.artist} – ${seed.title}`;
  console.log(`\n━━━ WATCHER: New seed detected ━━━`);
  console.log(`  ${seedLabel}`);

  await logEngineEvent("seed_detected", "info", {
    seedId,
    message: seedLabel,
    metadata: { artist: seed.artist, title: seed.title },
  });

  // ── Phase 1: NTS Discovery (first matching episode only) ──
  await logEngineEvent("discover_started", "started", { seedId, message: seedLabel });

  const query = `${seed.artist} ${seed.title}`;
  let episodes: Awaited<ReturnType<typeof ntsSearch>>;
  try {
    episodes = await ntsSearch(query);
  } catch (err) {
    log("fail", `NTS search failed for ${seedLabel}: ${err instanceof Error ? err.message : err}`);
    await logEngineEvent("error", "failed", {
      seedId,
      message: `NTS search failed: ${err instanceof Error ? err.message : err}`,
    });
    return;
  }

  if (episodes.length === 0) {
    log("warn", `No NTS episodes found for ${seedLabel}`);
    await logEngineEvent("discover_completed", "completed", {
      seedId,
      message: "No episodes found",
      metadata: { episodes_found: 0 },
    });
    return;
  }

  // Process the FIRST matching episode only
  let tracksAdded = 0;
  let episodeProcessed: string | null = null;

  for (const ep of episodes.slice(0, NTS_MAX_EPISODES)) {
    await sleep(1000); // NTS rate limit

    const episodeUrl = `https://www.nts.live${ep.path}`;
    const context = `${ep.title}${ep.date ? ` (${ep.date.split("T")[0]})` : ""}`;

    // Check if already crawled with tracks
    const { data: existingEp } = await db.from("episodes")
      .select("id").eq("url", episodeUrl).limit(1).single();

    let episodeId: string;

    if (existingEp) {
      episodeId = existingEp.id;
      await db.from("episode_seeds").upsert(
        { episode_id: episodeId, seed_id: seedId },
        { onConflict: "episode_id,seed_id" },
      );

      const { count } = await db.from("tracks")
        .select("*", { count: "exact", head: true })
        .eq("episode_id", episodeId);

      if (count && count > 0) {
        log("skip", `Already crawled (${count} tracks): ${context}`);
        continue;
      }
    } else {
      const artworkUrl = await ntsEpisodeArtwork(ep.path);
      const { data: newEp, error: epErr } = await db.from("episodes").insert({
        url: episodeUrl,
        title: ep.title || null,
        source: "nts",
        aired_date: ep.date ? ep.date.split("T")[0] : null,
        artwork_url: artworkUrl,
      }).select("id").single();

      if (!newEp) {
        log("fail", `Episode insert failed: ${context} — ${epErr?.message}`);
        continue;
      }
      episodeId = newEp.id;
    }

    await db.from("episode_seeds").upsert(
      { episode_id: episodeId, seed_id: seedId },
      { onConflict: "episode_id,seed_id" },
    );

    const tracks = await ntsTracklist(ep.path);
    if (tracks.length === 0) {
      log("fail", `Empty tracklist: ${context}`);
      continue;
    }

    // Insert candidate tracks from this episode
    const insertedTracks: any[] = [];
    for (let pos = 0; pos < tracks.length; pos++) {
      const track = tracks[pos];
      if (isSameTrack(track, { artist: seed.artist, title: seed.title })) continue;

      const lTitle = track.title.toLowerCase().trim();
      const lArtist = track.artist.toLowerCase().trim();
      if (GARBAGE_TITLES.has(lTitle) || lTitle.length <= 1 || lArtist.length <= 1) continue;

      // Dedup against DB
      const { data: existing } = await db.from("tracks")
        .select("id").ilike("artist", track.artist.trim()).ilike("title", track.title.trim()).limit(1);
      if (existing && existing.length > 0) continue;

      const { data: inserted, error } = await db.from("tracks").insert({
        artist: track.artist.trim(),
        title: track.title.trim(),
        source: "nts",
        source_url: episodeUrl,
        source_context: context,
        metadata: { co_occurrence: 1, seed_artist: seed.artist, seed_title: seed.title },
        status: "pending",
        episode_id: episodeId,
        seed_track_id: seed.track_id || null,
      }).select("*").single();

      if (error || !inserted) continue;

      await db.from("episode_tracks").upsert(
        { episode_id: episodeId, track_id: inserted.id, position: pos },
        { onConflict: "episode_id,track_id" },
      );

      insertedTracks.push(inserted);
      tracksAdded++;
    }

    episodeProcessed = context;
    log("ok", `${context} — ${tracks.length} tracks, ${insertedTracks.length} new`);

    // Log discovery run
    await db.from("discovery_runs").insert({
      started_at: new Date(t0).toISOString(),
      completed_at: new Date().toISOString(),
      seed_id: seedId,
      seed_track_id: seed.track_id || null,
      sources_searched: ["nts"],
      tracks_found: tracks.length,
      tracks_added: insertedTracks.length,
      notes: `Watcher: processed first episode "${context}"`,
    });

    await logEngineEvent("discover_completed", "completed", {
      seedId,
      message: `${context}: ${insertedTracks.length} tracks added`,
      metadata: { episode: context, tracks_found: tracks.length, tracks_added: insertedTracks.length },
    });

    // ── Phase 2: Enrich tracks from this episode ──
    if (insertedTracks.length > 0) {
      await logEngineEvent("enrich_started", "started", {
        seedId,
        message: `Enriching ${insertedTracks.length} tracks`,
      });

      let enriched = 0;
      let enrichFailed = 0;

      for (let i = 0; i < insertedTracks.length; i += ENRICH_CONCURRENCY) {
        const batch = insertedTracks.slice(i, i + ENRICH_CONCURRENCY);
        const results = await Promise.allSettled(batch.map(enrichTrack));
        for (const r of results) {
          if (r.status === "fulfilled" && r.value) enriched++;
          else enrichFailed++;
        }
      }

      await logEngineEvent("enrich_completed", "completed", {
        seedId,
        message: `Enriched: ${enriched}, Failed: ${enrichFailed}`,
        metadata: { enriched, failed: enrichFailed },
      });

      // ── Phase 3: Download audio for enriched tracks ──
      const { data: downloadable } = await db.from("tracks")
        .select("*")
        .in("id", insertedTracks.map((t) => t.id))
        .not("youtube_url", "is", null)
        .is("storage_path", null);

      if (downloadable?.length) {
        log("info", `Downloading audio for ${downloadable.length} tracks...`);
        let downloaded = 0;
        for (const track of downloadable) {
          try {
            const ok = await downloadTrack(track);
            if (ok) downloaded++;
            log(ok ? "ok" : "fail", `DL: ${track.artist} – ${track.title}`);
          } catch (err) {
            log("fail", `DL error: ${track.artist} – ${track.title}: ${err instanceof Error ? err.message : err}`);
          }
        }
        log("info", `Downloaded ${downloaded}/${downloadable.length} tracks`);
      }
    }

    // Only process the first episode with tracks
    break;
  }

  // ── Phase 4: Populate seed cover art if missing ──
  if (!seed.cover_art_url) {
    try {
      const spot = await spotifyLookup(seed.artist, seed.title);
      if (spot?.cover_art_url) {
        await db.from("seeds").update({ cover_art_url: spot.cover_art_url }).eq("id", seedId);
        log("ok", `Set seed cover art for ${seedLabel}`);
      }
    } catch (err) {
      log("fail", `Seed cover art lookup failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(`\n  Watcher pipeline done for ${seedLabel} (${elapsed(t0)})`);
  console.log(`  Tracks added: ${tracksAdded}, Episode: ${episodeProcessed || "none"}\n`);
}

// ─── REALTIME SUBSCRIPTION ──────────────────────────────────

let processing = false;
const seedQueue: string[] = [];
const trackQueue: string[] = [];

function enqueueSeed(seedId: string) {
  if (!seedId) return;
  if (seedQueue.includes(seedId)) return;
  seedQueue.push(seedId);
}

function enqueueTrack(trackId: string) {
  if (!trackId) return;
  if (trackQueue.includes(trackId)) return;
  trackQueue.push(trackId);
}

async function enqueueBacklogSeeds() {
  const { data: seeds, error: seedErr } = await db.from("seeds")
    .select("id, artist, title, created_at")
    .eq("active", true)
    .order("created_at", { ascending: true });

  if (seedErr || !seeds?.length) {
    if (seedErr) log("fail", `Backlog seed scan failed: ${seedErr.message}`);
    return;
  }

  const seedIds = seeds.map((seed) => seed.id);
  const [{ data: episodeLinks, error: episodeErr }, { data: runLinks, error: runErr }] = await Promise.all([
    db.from("episode_seeds").select("seed_id").in("seed_id", seedIds),
    db.from("discovery_runs").select("seed_id").in("seed_id", seedIds),
  ]);

  if (episodeErr || runErr) {
    log("fail", `Backlog scan failed: ${episodeErr?.message || runErr?.message}`);
    return;
  }

  const seedsWithEpisodes = new Set((episodeLinks || []).map((link: any) => link.seed_id));
  const seedsWithRuns = new Set((runLinks || []).map((link: any) => link.seed_id));
  const freshSeeds = seeds.filter((seed) => !seedsWithEpisodes.has(seed.id) && !seedsWithRuns.has(seed.id));

  if (freshSeeds.length === 0) {
    log("info", "No backlog seeds to recover");
    return;
  }

  for (const seed of freshSeeds) {
    enqueueSeed(seed.id);
  }

  log("info", `Recovered ${freshSeeds.length} fresh seed(s) missed before watcher startup`);
}

async function enqueueBacklogTracks() {
  const { data: tracks, error } = await db.from("tracks")
    .select("id, status, spotify_url, youtube_url, storage_path, created_at")
    .in("status", ["pending", "approved"])
    .is("storage_path", null)
    .order("created_at", { ascending: true })
    .limit(500);

  if (error) {
    log("fail", `Backlog track scan failed: ${error.message}`);
    return;
  }

  const incomplete = (tracks || []).filter((track) =>
    !track.youtube_url || (track.status === "pending" && !track.spotify_url)
  );

  if (incomplete.length === 0) {
    log("info", "No backlog tracks to recover");
    return;
  }

  for (const track of incomplete) {
    enqueueTrack(track.id);
  }

  log("info", `Recovered ${incomplete.length} incomplete track(s) for enrich/download repair`);
}

async function processTrack(trackId: string) {
  const { data: track, error } = await db.from("tracks")
    .select("*")
    .eq("id", trackId)
    .single();

  if (error || !track) {
    log("fail", `Could not read track ${trackId}: ${error?.message ?? "not found"}`);
    return;
  }

  const label = `${track.artist} – ${track.title}`;
  const shouldEnrich =
    track.status === "pending" &&
    (!track.spotify_url || (!track.youtube_url && !track.storage_path));
  const canDownload =
    ["pending", "approved"].includes(track.status) &&
    !!track.youtube_url &&
    !track.storage_path;

  if (!shouldEnrich && !canDownload) {
    return;
  }

  log("info", `Repairing track: ${label}`);
  await logEngineEvent("repair_started", "started", {
    message: label,
    metadata: {
      track_id: trackId,
      should_enrich: shouldEnrich,
      can_download: canDownload,
    },
  });

  if (shouldEnrich) {
    await enrichTrack(track);
  }

  const { data: refreshed } = await db.from("tracks")
    .select("*")
    .eq("id", trackId)
    .single();

  if (!refreshed) return;

  if (
    ["pending", "approved"].includes(refreshed.status) &&
    refreshed.youtube_url &&
    !refreshed.storage_path
  ) {
    const ok = await downloadTrack(refreshed);
    log(ok ? "ok" : "fail", `Repair DL: ${label}`);
    await logEngineEvent(ok ? "repair_completed" : "error", ok ? "completed" : "failed", {
      message: ok ? label : `Repair download failed: ${label}`,
      metadata: {
        track_id: trackId,
        downloaded: ok,
      },
    });
    return;
  }

  await logEngineEvent("repair_completed", "completed", {
    message: label,
    metadata: {
      track_id: trackId,
      downloaded: false,
    },
  });
}

// ─── SUPER LIKE PIPELINE ────────────────────────────────────

const SUPER_LIKE_DIR = `${process.env.HOME}/Music/PicoDrops/AzoreanStacks`;

function sanitizeFilename(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s\-.,()&+]/g, "").replace(/\s+/g, " ").trim().slice(0, 100) || "unknown";
}

async function processSuperLike(trackId: string) {
  const { data: track, error } = await db.from("tracks")
    .select("*")
    .eq("id", trackId)
    .single();

  if (error || !track) {
    log("fail", `Super Like: could not read track ${trackId}: ${error?.message ?? "not found"}`);
    await logEngineEvent("error", "failed", {
      message: `Super Like: could not read track: ${error?.message ?? "not found"}`,
      metadata: { track_id: trackId },
    });
    return;
  }

  const label = `${track.artist} – ${track.title}`;
  console.log(`\n━━━ SUPER LIKE: Local download triggered ━━━`);
  console.log(`  ${label}`);

  await logEngineEvent("super_like_detected", "started", {
    message: label,
    metadata: { track_id: trackId },
  });

  // Ensure YouTube URL is available — enrich first if needed
  let ytUrl = track.youtube_url;
  if (!ytUrl) {
    log("info", `Super Like: no YouTube URL yet, enriching ${label}`);
    await enrichTrack(track);
    const { data: refreshed } = await db.from("tracks").select("*").eq("id", trackId).single();
    ytUrl = refreshed?.youtube_url ?? null;
  }

  if (!ytUrl) {
    log("warn", `Super Like: no YouTube URL found for ${label} — skipping local download`);
    await logEngineEvent("error", "failed", {
      message: `Super Like: no YouTube URL for ${label}`,
      metadata: { track_id: trackId },
    });
    return;
  }

  // Ensure output directory exists
  if (!existsSync(SUPER_LIKE_DIR)) {
    mkdirSync(SUPER_LIKE_DIR, { recursive: true });
    log("info", `Created PicoDrops dir: ${SUPER_LIKE_DIR}`);
  }

  const safeArtist = sanitizeFilename(track.artist);
  const safeTitle = sanitizeFilename(track.title);
  const outFilename = `${safeArtist} - ${safeTitle}.mp3`;
  const outPath = `${SUPER_LIKE_DIR}/${outFilename}`;
  const outTemplate = `${SUPER_LIKE_DIR}/${safeArtist} - ${safeTitle}.%(ext)s`;

  const YT_DLP_BIN =
    process.env.YT_DLP_BIN ||
    Bun.which("yt-dlp") ||
    "/opt/homebrew/bin/yt-dlp";

  log("info", `Super Like: downloading "${outFilename}" via yt-dlp`);

  const dlProc = Bun.spawn(
    [YT_DLP_BIN, "-x", "--audio-format", "mp3", "--audio-quality", "0",
     "--no-playlist", "--no-warnings", "-o", outTemplate, ytUrl],
    { stdout: "ignore", stderr: "ignore" },
  );

  let exitCode: number;
  try {
    exitCode = await Promise.race([
      dlProc.exited,
      new Promise<number>((_, reject) =>
        setTimeout(() => reject(new Error("Timeout after 120s")), 120_000)
      ),
    ]);
  } catch (err) {
    log("fail", `Super Like: yt-dlp timed out for ${label}`);
    await logEngineEvent("error", "failed", {
      message: `Super Like: download timeout for ${label}`,
      metadata: { track_id: trackId },
    });
    return;
  }

  if (exitCode !== 0) {
    log("fail", `Super Like: yt-dlp exited with ${exitCode} for ${label}`);
    await logEngineEvent("error", "failed", {
      message: `Super Like: yt-dlp failed (exit ${exitCode}) for ${label}`,
      metadata: { track_id: trackId },
    });
    return;
  }

  log("ok", `Super Like: downloaded → ${outPath}`);
  await logEngineEvent("super_like_completed", "completed", {
    message: `${label} → ${outFilename}`,
    metadata: { track_id: trackId, path: outPath },
  });
}

const superLikeQueue: string[] = [];

function enqueueSuperLike(trackId: string) {
  if (!trackId) return;
  if (superLikeQueue.includes(trackId)) return;
  superLikeQueue.push(trackId);
}

async function processQueue() {
  if (processing) return;
  processing = true;

  while (seedQueue.length > 0 || trackQueue.length > 0 || superLikeQueue.length > 0) {
    lastEventAt = new Date().toISOString();
    updateStatusFile();

    if (seedQueue.length > 0) {
      const seedId = seedQueue.shift()!;
      try {
        await processSeed(seedId);
      } catch (err) {
        log("fail", `Pipeline error for seed ${seedId}: ${err instanceof Error ? err.message : err}`);
        await logEngineEvent("error", "failed", {
          seedId,
          message: `Pipeline error: ${err instanceof Error ? err.message : err}`,
        });
      }
      continue;
    }

    if (superLikeQueue.length > 0) {
      const trackId = superLikeQueue.shift()!;
      try {
        await processSuperLike(trackId);
      } catch (err) {
        log("fail", `Super Like error for track ${trackId}: ${err instanceof Error ? err.message : err}`);
        await logEngineEvent("error", "failed", {
          message: `Super Like error: ${err instanceof Error ? err.message : err}`,
          metadata: { track_id: trackId },
        });
      }
      continue;
    }

    const trackId = trackQueue.shift()!;
    try {
      await processTrack(trackId);
    } catch (err) {
      log("fail", `Repair error for track ${trackId}: ${err instanceof Error ? err.message : err}`);
    }
  }

  processing = false;
}

function startWatcher() {
  log("info", "Connecting to Supabase Realtime...");

  const channel = db.channel("seeds-watcher")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "seeds" },
      (payload) => {
        const seedId = payload.new?.id;
        if (!seedId) {
          log("warn", "Received INSERT event without seed ID");
          return;
        }
        log("ok", `Seed INSERT detected: ${payload.new?.artist} – ${payload.new?.title} (${seedId})`);
        enqueueSeed(seedId);
        processQueue();
      },
    )
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "user_tracks" },
      (payload) => {
        const trackId = payload.new?.track_id;
        if (!trackId) {
          log("warn", "Received user_track INSERT without track_id");
          return;
        }
        log("ok", `user_track INSERT detected for track ${trackId}`);
        enqueueTrack(trackId);
        processQueue();
      },
    )
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "user_tracks", filter: "super_liked=eq.true" },
      (payload) => {
        const trackId = payload.new?.track_id;
        if (!trackId) {
          log("warn", "Received super_liked UPDATE without track_id");
          return;
        }
        log("ok", `Super Like detected for track ${trackId} — queuing local download`);
        enqueueSuperLike(trackId);
        processQueue();
      },
    )
    .subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        watcherConnectedAt = new Date().toISOString();
        log("ok", "Realtime subscription active — watching for new seeds");
        logEngineEvent("watcher_connected", "info", {
          message: "Watcher connected to Supabase Realtime",
        });
        updateStatusFile();
        await enqueueBacklogSeeds();
        await enqueueBacklogTracks();
        processQueue();
      } else if (status === "CLOSED" || status === "CHANNEL_ERROR") {
        log("warn", `Realtime channel ${status} — will attempt reconnect`);
        logEngineEvent("watcher_disconnected", "info", {
          message: `Channel ${status}`,
        });
        // Manual reconnect fallback after 5s
        setTimeout(() => {
          log("info", "Attempting manual reconnect...");
          channel.subscribe();
        }, 5_000);
      }
    });
}

// ─── GRACEFUL SHUTDOWN ──────────────────────────────────────

let shuttingDown = false;

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    if (shuttingDown) { console.log("\n  Force quit."); process.exit(1); }
    shuttingDown = true;
    console.log(`\n  ${sig} received — shutting down watcher...`);
    await logEngineEvent("watcher_disconnected", "info", {
      message: `Watcher stopped (${sig})`,
    });
    watcherConnectedAt = null;
    updateStatusFile();
    // Give pending operations a moment to complete
    setTimeout(() => process.exit(0), 2_000);
  });
}

// ─── MAIN ───────────────────────────────────────────────────

console.log(`\n  The Stacks — Realtime Seed Watcher`);
console.log(`  ${new Date().toISOString()}\n`);

startWatcher();

// Keep process alive
setInterval(() => {}, 60_000);
