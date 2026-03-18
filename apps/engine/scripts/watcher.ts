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
  isSameTrack,
  enrichTrack, downloadTrack,
  spotifyLookup,
  logEngineEvent,
} from "../lib/pipeline";
import { SOURCES } from "../lib/sources/index";
import { runCuratorRadar } from "./radar-curator";
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from "fs";

const db = getSupabase();
const STATUS_FILE = `${process.env.HOME}/.openclaw/data/azorean-engine-status.json`;

// ─── CONCURRENCY LIMITS ─────────────────────────────────────
// Tuned for M4 Mac Mini — all bottlenecks are network I/O
const CONCURRENCY = {
  enrich: 25,         // Spotify + YouTube lookups per batch
  download: 8,        // yt-dlp audio downloads per batch
  repair: 20,         // Background track repair tasks
  superLike: 2,       // Simultaneous super-like downloads
  ntsMaxEpisodes: 10, // Max episodes to check per source per seed
} as const;

const PRIORITY_DOWNLOAD_CONCURRENCY = 15; // Max concurrent downloads for priority pipeline
const PRIORITY_ENRICH_CONCURRENCY = 40;   // Max concurrent enrichments for priority pipeline

const GARBAGE_TITLES = new Set(["unknown track", "untitled", "id", "?", "unknown", ""]);

// ─── STATUS TRACKING ────────────────────────────────────────

let watcherConnectedAt: string | null = null;
let lastEventAt: string | null = null;
let lastRealtimeEventAt: string | null = null;
let currentChannel: ReturnType<typeof db.channel> | null = null;
let intervalsStarted = false;

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

// ─── USER HELPERS ────────────────────────────────────────────

// Returns the first user ID found in user_tracks — used to scope engine runs
// to the primary user in single-user setups. Returns null if no users found.
async function getPrimaryUserId(): Promise<string | null> {
  try {
    const { data } = await db
      .from("user_tracks")
      .select("user_id")
      .not("user_id", "is", null)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    return data?.user_id ?? null;
  } catch {
    return null;
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

  // ── Phase 1: Multi-source Discovery (first matching episode per source) ──
  await logEngineEvent("discover_started", "started", { seedId, message: seedLabel });

  let tracksAdded = 0;
  let episodeProcessed: string | null = null;
  let totalEpisodesFound = 0;

  for (const source of SOURCES) {
    let sourceEpisodes: Array<{ url: string; title: string; date: string | null }> = [];

    if (source.name === "lotradio") {
      // Lot Radio: tracklist matching ONLY — find episodes where a DJ played the seed track
      try {
        const seedArtistLower = seed.artist.toLowerCase().trim();
        const seedTitleLower = seed.title.toLowerCase().trim();
        const { data: dbEpisodes } = await db
          .from("episodes")
          .select("url, title, aired_date, metadata")
          .eq("source", "lotradio")
          .not("metadata", "is", null);

        if (dbEpisodes) {
          for (const ep of dbEpisodes as any[]) {
            const tracklist: Array<{ artist: string; title: string }> = ep.metadata?.tracklist || [];
            if (tracklist.length === 0) continue;
            const hasMatch = tracklist.some((t) =>
              t.artist?.toLowerCase().trim() === seedArtistLower &&
              t.title?.toLowerCase().trim() === seedTitleLower
            );
            if (hasMatch) {
              sourceEpisodes.push({ url: ep.url, title: ep.title || ep.url, date: ep.aired_date || null });
            }
          }
        }
        log("info", `Lot Radio: ${sourceEpisodes.length} tracklist matches for ${seedLabel}`);
      } catch (err) {
        log("fail", `Lot Radio tracklist search error for ${seedLabel}: ${err instanceof Error ? err.message : err}`);
      }
    } else {
      try {
        const results = await source.searchForSeed(seed.artist, seed.title);
        sourceEpisodes = results.map((e) => ({ url: e.url, title: e.title, date: e.date }));
      } catch (err) {
        log("fail", `${source.name} search failed for ${seedLabel}: ${err instanceof Error ? err.message : err}`);
        continue;
      }
    }

    if (sourceEpisodes.length === 0) {
      log("warn", `No ${source.name} episodes found for ${seedLabel}`);
      continue;
    }

    totalEpisodesFound += sourceEpisodes.length;
    log("info", `${source.name}: ${sourceEpisodes.length} episodes found`);

    for (const ep of sourceEpisodes.slice(0, CONCURRENCY.ntsMaxEpisodes)) {
      await sleep(1000);

      const episodeUrl = ep.url;
      const context = `${ep.title}${ep.date ? ` (${ep.date})` : ""}`;

      const { data: existingEp } = await db.from("episodes")
        .select("id").eq("url", episodeUrl).limit(1).single();

      let episodeId: string;

      if (existingEp) {
        episodeId = existingEp.id;

        const { count } = await db.from("tracks")
          .select("*", { count: "exact", head: true })
          .eq("episode_id", episodeId);

        if (count && count > 0) {
          log("skip", `Already crawled (${count} tracks): ${context}`);
          continue;
        }
      } else {
        const artworkUrl = await source.getArtwork(episodeUrl);
        const { data: newEp, error: epErr } = await db.from("episodes").insert({
          url: episodeUrl,
          title: ep.title || null,
          source: source.name,
          aired_date: ep.date || null,
          artwork_url: artworkUrl,
        }).select("id").single();

        if (!newEp) {
          log("fail", `Episode insert failed: ${context} — ${epErr?.message}`);
          continue;
        }
        episodeId = newEp.id;
      }

      const rawTracks = await source.getTracklist(episodeUrl);
      if (rawTracks.length === 0) {
        log("fail", `Empty tracklist: ${context}`);
        continue;
      }

      // Verify the seed track actually appears in this episode's tracklist before
      // treating it as a valid co-occurrence source. Without this check, NTS full-text
      // search can return false-positive episodes (matching tags/descriptions) whose
      // tracklists have no relation to the seed — producing tracks with no meaningful
      // artist/title connection to the seed.
      const hasFullMatch = rawTracks.some((t) => isSameTrack(t, { artist: seed.artist, title: seed.title }));
      const hasArtistMatch = !hasFullMatch && rawTracks.some(
        (t) => t.artist.toLowerCase().trim() === seed.artist.toLowerCase().trim()
      );
      const matchType = hasFullMatch ? "full" : hasArtistMatch ? "artist" : null;
      if (!matchType) {
        log("skip", `No match for seed "${seed.artist} - ${seed.title}" in ${context} — skipping`);
        continue;
      }

      await db.from("episode_seeds").upsert(
        { episode_id: episodeId, seed_id: seedId, match_type: matchType },
        { onConflict: "episode_id,seed_id" },
      );

      // Insert candidate tracks from this episode
      const insertedTracks: any[] = [];
      for (let pos = 0; pos < rawTracks.length; pos++) {
        const track = rawTracks[pos];
        if (isSameTrack(track, { artist: seed.artist, title: seed.title })) continue;

        const lTitle = track.title.toLowerCase().trim();
        const lArtist = track.artist.toLowerCase().trim();
        if (GARBAGE_TITLES.has(lTitle) || lTitle.length <= 1 || lArtist.length <= 1) continue;

        const { data: existing } = await db.from("tracks")
          .select("id").ilike("artist", track.artist.trim()).ilike("title", track.title.trim()).limit(1);
        if (existing && existing.length > 0) continue;

        const { data: inserted, error } = await db.from("tracks").insert({
          artist: track.artist.trim(),
          title: track.title.trim(),
          source: source.name,
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

      if (episodeProcessed === null) episodeProcessed = context;
      log("ok", `${context} — ${rawTracks.length} tracks, ${insertedTracks.length} new`);

      // Log discovery run
      await db.from("discovery_runs").insert({
        started_at: new Date(t0).toISOString(),
        completed_at: new Date().toISOString(),
        seed_id: seedId,
        seed_track_id: seed.track_id || null,
        sources_searched: [source.name],
        tracks_found: rawTracks.length,
        tracks_added: insertedTracks.length,
        notes: `Watcher: processed first episode "${context}" from ${source.name}`,
      });

      await logEngineEvent("discover_completed", "completed", {
        seedId,
        message: `${context}: ${insertedTracks.length} tracks added`,
        metadata: { episode: context, source: source.name, tracks_found: rawTracks.length, tracks_added: insertedTracks.length },
      });

      // ── Phase 2: Enrich tracks from this episode ──
      if (insertedTracks.length > 0) {
        await logEngineEvent("enrich_started", "started", {
          seedId,
          message: `Enriching ${insertedTracks.length} tracks`,
        });

        let enriched = 0;
        let enrichFailed = 0;

        for (let i = 0; i < insertedTracks.length; i += CONCURRENCY.enrich) {
          const batch = insertedTracks.slice(i, i + CONCURRENCY.enrich);
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
          for (let i = 0; i < downloadable.length; i += CONCURRENCY.download) {
            const batch = downloadable.slice(i, i + CONCURRENCY.download);
            const results = await Promise.allSettled(batch.map(async (track) => {
              const ok = await downloadTrack(track);
              log(ok ? "ok" : "fail", `DL: ${track.artist} – ${track.title}`);
              return ok;
            }));
            downloaded += results.filter(r => r.status === "fulfilled" && r.value).length;
          }
          log("info", `Downloaded ${downloaded}/${downloadable.length} tracks`);
        }
      }

      // Only process the first episode with tracks per source
      break;
    }
  }

  if (totalEpisodesFound === 0) {
    log("warn", `No episodes found across all sources for ${seedLabel}`);
    await logEngineEvent("discover_completed", "completed", {
      seedId,
      message: "No episodes found",
      metadata: { episodes_found: 0 },
    });
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
  const MAX_DL_ATTEMPTS = 3;
  const { data: tracks, error } = await db.from("tracks")
    .select("id, status, spotify_url, youtube_url, storage_path, created_at, dl_attempts")
    .in("status", ["pending", "approved"])
    .is("storage_path", null)
    .lt("dl_attempts", MAX_DL_ATTEMPTS)
    .order("created_at", { ascending: true })
    .limit(500);

  if (error) {
    log("fail", `Backlog track scan failed: ${error.message}`);
    return;
  }

  // Only enrich tracks that truly need it:
  // - spotify_url is null (not empty string — empty string = already tried, found nothing)
  // - OR no youtube_url and no storage_path
  const incomplete = (tracks || []).filter((track) =>
    !track.youtube_url || (track.status === "pending" && track.spotify_url === null)
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

async function enqueueBacklogSuperLikes() {
  const { data: superLiked, error } = await db.from("user_tracks")
    .select("track_id, tracks(artist, title)")
    .eq("super_liked", true);

  if (error) {
    log("fail", `Backlog super-like scan failed: ${error.message}`);
    return;
  }

  if (!superLiked || superLiked.length === 0) {
    log("info", "No backlog super likes to recover");
    return;
  }

  let existingFiles: Set<string>;
  try {
    existingFiles = new Set(readdirSync(SUPER_LIKE_DIR));
  } catch {
    existingFiles = new Set();
  }

  let enqueued = 0;
  for (const row of superLiked) {
    const track = Array.isArray(row.tracks) ? row.tracks[0] : row.tracks;
    if (!track?.artist || !track?.title) continue;
    const expected = `${sanitizeFilename(track.artist)} - ${sanitizeFilename(track.title)}.mp3`;
    if (!existingFiles.has(expected)) {
      enqueueSuperLike(row.track_id);
      enqueued++;
    }
  }

  if (enqueued === 0) {
    log("info", "All super-liked tracks already downloaded");
  } else {
    log("info", `Recovered ${enqueued} super-liked track(s) missing from local directory`);
  }
}

async function pollForMissingSuperLikes() {
  try {
    const { data: superLiked, error } = await db.from("user_tracks")
      .select("track_id, tracks(artist, title)")
      .eq("super_liked", true);

    if (error || !superLiked?.length) return;

    let existingFiles: Set<string>;
    try {
      existingFiles = new Set(readdirSync(SUPER_LIKE_DIR));
    } catch {
      existingFiles = new Set();
    }

    let enqueued = 0;
    for (const row of superLiked) {
      const track = Array.isArray(row.tracks) ? row.tracks[0] : row.tracks;
      if (!track?.artist || !track?.title) continue;
      const expected = `${sanitizeFilename(track.artist)} - ${sanitizeFilename(track.title)}.mp3`;
      if (!existingFiles.has(expected)) {
        enqueueSuperLike(row.track_id);
        enqueued++;
      }
    }

    if (enqueued > 0) {
      log("info", `[Poll] ${enqueued} super-like(s) missing locally — enqueuing`);
      processSuperLikeQueue();
    }
  } catch (err) {
    log("fail", `pollForMissingSuperLikes error: ${err instanceof Error ? err.message : err}`);
  }
}

async function processTrack(trackId: string, prefetched?: any) {
  const { data: track, error } = prefetched
    ? { data: prefetched, error: null }
    : await db.from("tracks").select("*").eq("id", trackId).single();

  if (error || !track) {
    log("fail", `Could not read track ${trackId}: ${error?.message ?? "not found"}`);
    return;
  }

  const label = `${track.artist} – ${track.title}`;
  const MAX_DL_ATTEMPTS = 3;
  // Only consider Spotify missing if it's truly null (not empty string — empty string means
  // enrichment already ran and found nothing, so don't re-enrich repeatedly).
  const spotifyMissing = track.spotify_url === null || track.spotify_url === undefined;
  const shouldEnrich =
    track.status === "pending" &&
    (spotifyMissing || (!track.youtube_url && !track.storage_path));
  const canDownload =
    ["pending", "approved"].includes(track.status) &&
    !!track.youtube_url &&
    !track.storage_path &&
    (track.dl_attempts || 0) < MAX_DL_ATTEMPTS;

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
    !refreshed.storage_path &&
    (refreshed.dl_attempts || 0) < MAX_DL_ATTEMPTS
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

// ─── PRIORITY PIPELINE ──────────────────────────────────────

async function updatePipelineStatus(
  seedId: string,
  updates: Record<string, unknown>,
  logMsg?: string,
) {
  try {
    const { data: seed } = await db.from("seeds").select("pipeline_status").eq("id", seedId).single();
    const current = (seed?.pipeline_status as Record<string, unknown>) || {};
    const timeStr = new Date().toTimeString().slice(0, 8);
    const newLogs = logMsg
      ? [...((current.log as unknown[]) || []), { t: timeStr, msg: logMsg }]
      : (current.log as unknown[]) || [];
    const newStatus = { ...current, ...updates, log: newLogs };
    await db.from("seeds").update({ pipeline_status: newStatus }).eq("id", seedId);
  } catch (err) {
    log("fail", `updatePipelineStatus failed for ${seedId}: ${err instanceof Error ? err.message : err}`);
  }
}

async function processPrioritySeed(seedId: string) {
  const startTime = Date.now();
  const { data: seed, error: seedErr } = await db.from("seeds").select("*").eq("id", seedId).single();
  if (seedErr || !seed) {
    log("fail", `Priority: could not read seed ${seedId}`);
    return;
  }

  const seedLabel = `${seed.artist} – ${seed.title}`;
  log("info", `\n━━━ PRIORITY: Pipeline starting for ${seedLabel} ━━━`);

  await updatePipelineStatus(seedId, { state: "discovering" }, `searching for "${seedLabel}"`);

  type Candidate = {
    url: string;
    title: string;
    date: string | null;
    sourceName: string;
    existingEpisodeId: string | null;
    trackCount: number;
    rawTracklist: Array<{ artist: string; title: string }>;
  };

  const candidates: Candidate[] = [];

  for (const source of SOURCES) {
    let sourceEpisodes: Array<{ url: string; title: string; date: string | null }> = [];

    if (source.name === "lotradio") {
      const seedArtistLower = seed.artist.toLowerCase().trim();
      const seedTitleLower = seed.title.toLowerCase().trim();

      // Paginated scan of all lotradio episodes in DB
      let page = 0;
      const pageSize = 1000;
      while (true) {
        const { data: dbEpisodes } = await db.from("episodes")
          .select("url, title, aired_date, metadata")
          .eq("source", "lotradio")
          .not("metadata", "is", null)
          .range(page * pageSize, (page + 1) * pageSize - 1);

        if (!dbEpisodes || dbEpisodes.length === 0) break;

        for (const ep of dbEpisodes as any[]) {
          const tracklist: Array<{ artist: string; title: string }> = ep.metadata?.tracklist || [];
          if (tracklist.length === 0) continue;
          const hasMatch = tracklist.some((t) =>
            t.artist?.toLowerCase().trim() === seedArtistLower &&
            t.title?.toLowerCase().trim() === seedTitleLower
          );
          if (hasMatch) {
            sourceEpisodes.push({ url: ep.url, title: ep.title || ep.url, date: ep.aired_date || null });
          }
        }

        if (dbEpisodes.length < pageSize) break;
        page++;
      }

      await updatePipelineStatus(seedId, {}, `lot radio: ${sourceEpisodes.length} matches`);
    } else {
      try {
        const results = await source.searchForSeed(seed.artist, seed.title);
        sourceEpisodes = results.map((e) => ({ url: e.url, title: e.title, date: e.date }));
        await updatePipelineStatus(seedId, {}, `${source.name}: ${sourceEpisodes.length} episodes found`);
      } catch (err) {
        log("fail", `Priority: ${source.name} search error: ${err instanceof Error ? err.message : err}`);
        continue;
      }
    }

    // Score episodes by track count
    for (const ep of sourceEpisodes.slice(0, CONCURRENCY.ntsMaxEpisodes)) {
      const { data: existingEp } = await db.from("episodes")
        .select("id").eq("url", ep.url).limit(1).maybeSingle();

      let trackCount = 0;
      let rawTracklist: Array<{ artist: string; title: string }> = [];
      const existingEpisodeId = existingEp?.id || null;

      if (existingEp) {
        const { count } = await db.from("tracks")
          .select("*", { count: "exact", head: true })
          .eq("episode_id", existingEp.id);
        trackCount = count || 0;
      }

      if (trackCount === 0) {
        try {
          rawTracklist = await source.getTracklist(ep.url);
          trackCount = rawTracklist.length;
        } catch {
          continue;
        }
      }

      if (trackCount > 0) {
        candidates.push({
          url: ep.url,
          title: ep.title,
          date: ep.date,
          sourceName: source.name,
          existingEpisodeId,
          trackCount,
          rawTracklist,
        });
      }
    }
  }

  if (candidates.length === 0) {
    await updatePipelineStatus(
      seedId,
      { state: "done", completed_at: new Date().toISOString() },
      "no episodes found",
    );
    log("warn", `Priority: no episodes found for ${seedLabel}`);
    return;
  }

  // Pick best: most tracks
  const best = candidates.sort((a, b) => b.trackCount - a.trackCount)[0];
  await updatePipelineStatus(seedId, { episode_title: best.title }, `best episode: "${best.title}" (${best.trackCount} tracks)`);

  const sourceObj = SOURCES.find((s) => s.name === best.sourceName)!;
  let episodeId = best.existingEpisodeId;

  // Create episode if it doesn't exist
  if (!episodeId) {
    const artworkUrl = await sourceObj.getArtwork(best.url);
    const { data: newEp, error: epErr } = await db.from("episodes").insert({
      url: best.url,
      title: best.title || null,
      source: best.sourceName,
      aired_date: best.date || null,
      artwork_url: artworkUrl,
    }).select("id").single();

    if (!newEp) {
      await updatePipelineStatus(
        seedId,
        { state: "error", error: `Episode insert failed: ${epErr?.message}` },
        "episode insert failed",
      );
      return;
    }
    episodeId = newEp.id;
  }

  // Determine match type: full if seed track appears in the tracklist, artist if only artist matches
  let priorityMatchType: "full" | "artist" | "unknown" = "unknown";
  if (best.rawTracklist.length > 0) {
    const hasFullMatch = best.rawTracklist.some((t) => isSameTrack(t, { artist: seed.artist, title: seed.title }));
    const hasArtistMatch = !hasFullMatch && best.rawTracklist.some(
      (t) => t.artist.toLowerCase().trim() === seed.artist.toLowerCase().trim()
    );
    priorityMatchType = hasFullMatch ? "full" : hasArtistMatch ? "artist" : "unknown";
  }

  await db.from("episode_seeds").upsert(
    { episode_id: episodeId, seed_id: seedId, match_type: priorityMatchType },
    { onConflict: "episode_id,seed_id" },
  );

  // Insert new tracks (skip if episode already has tracks in DB)
  let tracksToProcess: any[] = [];

  if (best.rawTracklist.length > 0) {
    const context = `${best.title}${best.date ? ` (${best.date})` : ""}`;
    for (let pos = 0; pos < best.rawTracklist.length; pos++) {
      const track = best.rawTracklist[pos];
      if (isSameTrack(track, { artist: seed.artist, title: seed.title })) continue;
      const lTitle = track.title.toLowerCase().trim();
      const lArtist = track.artist.toLowerCase().trim();
      if (GARBAGE_TITLES.has(lTitle) || lTitle.length <= 1 || lArtist.length <= 1) continue;

      const { data: existing } = await db.from("tracks")
        .select("id").ilike("artist", track.artist.trim()).ilike("title", track.title.trim()).limit(1);
      if (existing && existing.length > 0) continue;

      const { data: inserted } = await db.from("tracks").insert({
        artist: track.artist.trim(),
        title: track.title.trim(),
        source: best.sourceName,
        source_url: best.url,
        source_context: context,
        metadata: { co_occurrence: 1, seed_artist: seed.artist, seed_title: seed.title },
        status: "pending",
        episode_id: episodeId,
        seed_track_id: seed.track_id || null,
      }).select("*").single();

      if (!inserted) continue;

      await db.from("episode_tracks").upsert(
        { episode_id: episodeId, track_id: inserted.id, position: pos },
        { onConflict: "episode_id,track_id" },
      );
      tracksToProcess.push(inserted);
    }
  } else {
    // Episode already existed — fetch pending (un-enriched) tracks AND enriched-but-not-downloaded tracks
    const { data: pendingTracks } = await db.from("tracks")
      .select("*")
      .eq("episode_id", episodeId)
      .eq("status", "pending");
    const { data: needsDownload } = await db.from("tracks")
      .select("*")
      .eq("episode_id", episodeId)
      .not("youtube_url", "is", null)
      .is("storage_path", null);
    const allTracks = [...(pendingTracks || []), ...(needsDownload || [])];
    // Deduplicate by id
    const seen = new Set<string>();
    tracksToProcess = allTracks.filter((t) => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });
  }

  if (tracksToProcess.length === 0) {
    await updatePipelineStatus(
      seedId,
      { state: "done", completed_at: new Date().toISOString() },
      "no tracks to enrich",
    );
    return;
  }

  // Phase 2: Enrich all tracks
  await updatePipelineStatus(
    seedId,
    { state: "enriching", progress: `0/${tracksToProcess.length}` },
    `enriching ${tracksToProcess.length} tracks`,
  );

  let enriched = 0;
  for (let i = 0; i < tracksToProcess.length; i += PRIORITY_ENRICH_CONCURRENCY) {
    const batch = tracksToProcess.slice(i, i + PRIORITY_ENRICH_CONCURRENCY);
    const results = await Promise.allSettled(batch.map(enrichTrack));
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) enriched++;
    }
    await updatePipelineStatus(seedId, { progress: `${Math.min(i + PRIORITY_ENRICH_CONCURRENCY, tracksToProcess.length)}/${tracksToProcess.length}` });
  }

  await updatePipelineStatus(seedId, {}, `enriched ${enriched}/${tracksToProcess.length} tracks`);

  // Phase 3: Download ALL tracks with YouTube URLs (no limit)
  const { data: downloadable } = await db.from("tracks")
    .select("*")
    .in("id", tracksToProcess.map((t) => t.id))
    .not("youtube_url", "is", null)
    .is("storage_path", null);

  let downloaded = 0;
  if (downloadable && downloadable.length > 0) {
    await updatePipelineStatus(
      seedId,
      { state: "downloading", progress: `0/${downloadable.length}` },
      `downloading ${downloadable.length} tracks`,
    );

    for (let i = 0; i < downloadable.length; i += PRIORITY_DOWNLOAD_CONCURRENCY) {
      const batch = downloadable.slice(i, i + PRIORITY_DOWNLOAD_CONCURRENCY);
      const results = await Promise.allSettled(batch.map(async (track) => {
        const ok = await downloadTrack(track);
        log(ok ? "ok" : "fail", `Priority DL: ${track.artist} – ${track.title}`);
        return ok;
      }));
      downloaded += results.filter((r) => r.status === "fulfilled" && r.value).length;
      await updatePipelineStatus(seedId, { progress: `${Math.min(i + PRIORITY_DOWNLOAD_CONCURRENCY, downloadable.length)}/${downloadable.length}` });
    }

    await updatePipelineStatus(seedId, {}, `downloaded ${downloaded}/${downloadable.length} tracks`);
  }

  // Phase 4: Cleanup — mark dangling pending tracks (no spotify_url AND no youtube_url) as skipped
  const trackIds = tracksToProcess.map((t) => t.id);
  if (trackIds.length > 0) {
    const { data: dangling } = await db.from("tracks")
      .select("id")
      .in("id", trackIds)
      .eq("status", "pending")
      .is("spotify_url", null)
      .is("youtube_url", null);

    if (dangling && dangling.length > 0) {
      // Update each track individually to preserve existing metadata
      for (const t of dangling) {
        const { data: existing } = await db.from("tracks").select("metadata").eq("id", t.id).single();
        await db.from("tracks")
          .update({ status: "skipped", metadata: { ...(existing?.metadata || {}), skip_reason: "no_spotify_or_youtube_match" } })
          .eq("id", t.id);
      }
      await updatePipelineStatus(seedId, {}, `skipped ${dangling.length} tracks with no match`);
      log("info", `Priority: skipped ${dangling.length} dangling tracks for ${seedLabel}`);
    }
  }

  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
  await updatePipelineStatus(
    seedId,
    { state: "done", completed_at: new Date().toISOString() },
    `pipeline complete — ${tracksToProcess.length} tracks processed, ${enriched} enriched, ${downloaded} downloaded in ${elapsedSec}s`,
  );

  log("ok", `Priority pipeline done for ${seedLabel} — ${tracksToProcess.length} tracks, ${enriched} enriched, ${downloaded} downloaded in ${elapsedSec}s`);
}

async function processPriorityQueue() {
  while (true) {
    if (shuttingDown) break;
    await sleep(3000);
    if (shuttingDown) break;

    try {
      const { data: queuedSeeds } = await db.from("seeds")
        .select("id")
        .filter("pipeline_status->>state", "eq", "queued")
        .limit(1);

      if (!queuedSeeds || queuedSeeds.length === 0) continue;

      const seedId = queuedSeeds[0].id;
      log("info", `Priority queue: picked up seed ${seedId}`);

      // Mark as in-progress (CAS on 'queued' to avoid double-processing)
      const timeStr = new Date().toTimeString().slice(0, 8);
      const { data: updated } = await db.from("seeds")
        .update({
          pipeline_status: {
            state: "discovering",
            started_at: new Date().toISOString(),
            log: [{ t: timeStr, msg: "pipeline started" }],
          },
        })
        .eq("id", seedId)
        .filter("pipeline_status->>state", "eq", "queued")
        .select("id")
        .maybeSingle();

      if (!updated) {
        // Another processor may have grabbed it already
        continue;
      }

      try {
        await processPrioritySeed(seedId);
      } catch (err) {
        await updatePipelineStatus(
          seedId,
          { state: "error", error: err instanceof Error ? err.message : String(err) },
          `error: ${err instanceof Error ? err.message : err}`,
        );
        log("fail", `Priority pipeline error for ${seedId}: ${err instanceof Error ? err.message : err}`);
      }
    } catch (err) {
      log("fail", `Priority queue loop error: ${err instanceof Error ? err.message : err}`);
    }
  }
}

async function resetStalePipelineStatuses() {
  // Use 30 minutes — priority pipeline can take 10-20+ min for large episode sets
  const fiveMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  try {
    const { data: stale } = await db.from("seeds")
      .select("id, pipeline_status")
      .not("pipeline_status", "is", null)
      .not("pipeline_status->>state", "eq", "done")
      .not("pipeline_status->>state", "eq", "error")
      .lt("pipeline_status->>started_at", fiveMinutesAgo);

    if (!stale || stale.length === 0) return;

    for (const seed of stale) {
      await db.from("seeds").update({
        pipeline_status: { state: "queued" },
      }).eq("id", seed.id);
    }

    log("info", `Reset ${stale.length} stale pipeline status(es) to "queued"`);
  } catch (err) {
    log("fail", `resetStalePipelineStatuses error: ${err instanceof Error ? err.message : err}`);
  }
}

// ─── INDEPENDENT QUEUE PROCESSORS ───────────────────────────

let seedProcessing = false;
async function processSeedQueue() {
  if (seedProcessing) return;
  seedProcessing = true;
  while (seedQueue.length > 0) {
    lastEventAt = new Date().toISOString();
    updateStatusFile();
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
  }
  seedProcessing = false;
}

let superLikeProcessing = false;
async function processSuperLikeQueue() {
  if (superLikeProcessing) return;
  superLikeProcessing = true;
  while (superLikeQueue.length > 0) {
    lastEventAt = new Date().toISOString();
    updateStatusFile();
    const batch = superLikeQueue.splice(0, CONCURRENCY.superLike);
    await Promise.allSettled(
      batch.map(async (trackId) => {
        try {
          await processSuperLike(trackId);
        } catch (err) {
          log("fail", `Super Like error for track ${trackId}: ${err instanceof Error ? err.message : err}`);
          await logEngineEvent("error", "failed", {
            message: `Super Like error: ${err instanceof Error ? err.message : err}`,
            metadata: { track_id: trackId },
          });
        }
      }),
    );
  }
  superLikeProcessing = false;
}

let repairProcessing = false;
async function processRepairQueue() {
  if (repairProcessing) return;
  repairProcessing = true;
  while (trackQueue.length > 0) {
    lastEventAt = new Date().toISOString();
    updateStatusFile();
    const batchIds = trackQueue.splice(0, CONCURRENCY.repair);
    const { data: batchTracks } = await db.from("tracks")
      .select("*")
      .in("id", batchIds);
    const trackMap = new Map((batchTracks || []).map((t: any) => [t.id, t]));
    await Promise.allSettled(
      batchIds.map(async (trackId) => {
        try {
          await processTrack(trackId, trackMap.get(trackId));
        } catch (err) {
          log("fail", `Repair error for track ${trackId}: ${err instanceof Error ? err.message : err}`);
        }
      }),
    );
  }
  repairProcessing = false;
}

function startWatcher() {
  log("info", "Connecting to Supabase Realtime...");

  currentChannel = db.channel("seeds-watcher")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "seeds" },
      (payload) => {
        lastRealtimeEventAt = new Date().toISOString();
        const seedId = payload.new?.id;
        if (!seedId) {
          log("warn", "Received INSERT event without seed ID");
          return;
        }
        log("ok", `Seed INSERT detected: ${payload.new?.artist} – ${payload.new?.title} (${seedId})`);
        enqueueSeed(seedId);
        processSeedQueue();
      },
    )
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "user_tracks" },
      async (payload) => {
        lastRealtimeEventAt = new Date().toISOString();
        const trackId = payload.new?.track_id;
        const userId = payload.new?.user_id;
        if (!trackId) {
          log("warn", "Received user_track INSERT without track_id");
          return;
        }
        log("ok", `user_track INSERT detected for track ${trackId}`);
        enqueueTrack(trackId);
        processRepairQueue();

        // Re-seed: when a track is approved, auto-create a seed for it so
        // the pipeline discovers co-occurring tracks. The seed is scoped to
        // the approving user so results stay isolated per-user.
        if (payload.new?.status === "approved" && userId) {
          try {
            const { data: track } = await db
              .from("tracks")
              .select("artist, title")
              .eq("id", trackId)
              .maybeSingle();

            if (track?.artist && track?.title) {
              // Only create seed if one doesn't already exist for this user + track
              const { data: existingSeed } = await db
                .from("seeds")
                .select("id")
                .or(`user_id.eq.${userId},user_id.is.null`)
                .ilike("artist", track.artist.replace(/[%_\\]/g, (c: string) => `\\${c}`))
                .ilike("title", track.title.replace(/[%_\\]/g, (c: string) => `\\${c}`))
                .limit(1)
                .maybeSingle();

              if (!existingSeed) {
                const now = new Date();
                const timeStr = now.toTimeString().slice(0, 8);
                await db.from("seeds").insert({
                  artist: track.artist,
                  title: track.title,
                  user_id: userId,
                  source: "auto:approved",
                  pipeline_status: {
                    state: "queued",
                    started_at: now.toISOString(),
                    log: [{ t: timeStr, msg: "seed auto-created from approved track" }],
                  },
                });
                log("ok", `Re-seed queued for approved track: ${track.artist} – ${track.title} (user: ${userId})`);
              }
            }
          } catch (err) {
            log("fail", `Re-seed on approve failed for track ${trackId}: ${err instanceof Error ? err.message : err}`);
          }
        }
      },
    )
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "user_tracks", filter: "super_liked=eq.true" },
      (payload) => {
        lastRealtimeEventAt = new Date().toISOString();
        const trackId = payload.new?.track_id;
        if (!trackId) {
          log("warn", "Received super_liked INSERT without track_id");
          return;
        }
        log("ok", `Super Like INSERT detected for track ${trackId} — queuing local download`);
        enqueueSuperLike(trackId);
        processSuperLikeQueue();
      },
    )
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "user_tracks", filter: "super_liked=eq.true" },
      (payload) => {
        lastRealtimeEventAt = new Date().toISOString();
        const trackId = payload.new?.track_id;
        if (!trackId) {
          log("warn", "Received super_liked UPDATE without track_id");
          return;
        }
        log("ok", `Super Like detected for track ${trackId} — queuing local download`);
        enqueueSuperLike(trackId);
        processSuperLikeQueue();
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
        await resetStalePipelineStatuses();
        await enqueueBacklogSeeds();
        await enqueueBacklogTracks();
        await enqueueBacklogSuperLikes();
        processSeedQueue();
        processRepairQueue();
        processSuperLikeQueue();
        processPriorityQueue();

        // Start polling + health-check intervals only once (survive reconnects)
        if (!intervalsStarted) {
          intervalsStarted = true;

          // Poll every 60s for super-likes missing from local directory
          setInterval(async () => {
            if (shuttingDown) return;
            await pollForMissingSuperLikes();
          }, 60_000);

          // Every 6 hours: run the curator affinity radar to discover new tracks
          // from trusted NTS shows based on voting patterns
          const SIX_HOURS = 6 * 60 * 60 * 1000;
          setInterval(async () => {
            if (shuttingDown) return;
            log("info", "[Radar] Starting scheduled curator affinity run");
            await logEngineEvent("radar_curator_run", "started", {
              message: "Scheduled curator radar run",
            });
            try {
              // Pass primary user ID so curator affinity scores are user-scoped
              const primaryUserId = await getPrimaryUserId();
              await runCuratorRadar(primaryUserId);
              await logEngineEvent("radar_curator_run", "completed", {
                message: "Scheduled curator radar run complete",
              });
            } catch (err) {
              log("fail", `[Radar] Curator radar failed: ${err instanceof Error ? err.message : err}`);
              await logEngineEvent("radar_curator_run", "failed", {
                message: `Curator radar error: ${err instanceof Error ? err.message : err}`,
              });
            }
          }, SIX_HOURS);

          // Every 2 min: drain pending-enrichment backlog from DB
          setInterval(async () => {
            if (shuttingDown) return;
            if (trackQueue.length > 0) return;
            // Only queue tracks that truly need enrichment:
            // - spotify_url IS NULL (not empty string — empty string means we already tried and found nothing)
            // - OR no youtube_url AND no storage_path (need YouTube lookup still)
            // Also exclude tracks with too many failed download attempts (dl_attempts >= 3)
            const { data: pending, error } = await db.from("tracks")
              .select("id, dl_attempts")
              .eq("status", "pending")
              .or("spotify_url.is.null,and(youtube_url.is.null,storage_path.is.null)")
              .lt("dl_attempts", 3)
              .order("created_at", { ascending: true })
              .limit(100);
            if (error) {
              log("fail", `[Drain] Pending track scan failed: ${error.message}`);
              return;
            }
            const toQueue = (pending || []).filter((t: any) => !trackQueue.includes(t.id));
            if (toQueue.length === 0) return;
            for (const t of toQueue) enqueueTrack(t.id);
            log("info", `[Drain] Queued ${toQueue.length} pending tracks for enrichment`);
            processRepairQueue();
          }, 2 * 60_000);

          // Every 10 min: warn + resubscribe if no Realtime events received
          setInterval(() => {
            if (shuttingDown) return;
            const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
            if (!lastRealtimeEventAt || new Date(lastRealtimeEventAt).getTime() < tenMinutesAgo) {
              log("warn", "[Health] No Realtime events in 10 min — attempting resubscribe");
              logEngineEvent("watcher_reconnect", "info", {
                message: "Proactive resubscribe: no Realtime events in 10 minutes",
              });
              if (currentChannel) {
                db.removeChannel(currentChannel);
                currentChannel = null;
              }
              startWatcher();
            }
          }, 10 * 60 * 1000);
        }
      } else if (status === "CLOSED" || status === "CHANNEL_ERROR") {
        log("warn", `Realtime channel ${status} — will attempt reconnect`);
        logEngineEvent("watcher_disconnected", "info", {
          message: `Channel ${status}`,
        });
        // Manual reconnect fallback after 5s
        setTimeout(() => {
          log("info", "Attempting manual reconnect...");
          currentChannel?.subscribe();
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
