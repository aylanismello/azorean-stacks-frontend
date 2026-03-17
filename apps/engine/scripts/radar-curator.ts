#!/usr/bin/env bun
/**
 * The Stacks — Curator Affinity Engine (Radar)
 *
 * Identifies trusted curators (NTS shows, Lot Radio shows) based on voting
 * patterns, then auto-follows them to pull in new tracks.
 *
 * Step 1: Compute curator affinity scores from approved/rejected votes on episode tracks
 * Step 2: Determine auto-follow tier (high/medium affinity)
 * Step 3: Fetch new episodes — NTS via API, Lot Radio via DB
 * Step 4: Insert tracks with discovery_method: "radar:curator" metadata
 *
 * Usage: bun run radar-curator
 */
import { getSupabase } from "../lib/supabase";
import { log, sleep, logEngineEvent } from "../lib/pipeline";
import { ntsSource } from "../lib/sources/nts";

const db = getSupabase();
const NTS_API = "https://www.nts.live/api/v2";

// ─── CONCURRENCY LIMITS ─────────────────────────────────────
const CONCURRENCY = {
  shows: 3,    // Max parallel show fetches
  episodes: 2, // Max parallel episodes per show
} as const;

const GARBAGE_TITLES = new Set(["unknown track", "untitled", "id", "?", "unknown", ""]);

// ─── TYPES ──────────────────────────────────────────────────

interface CuratorAffinity {
  curatorKey: string;    // canonical key: "nts:show-slug" or "lotradio:show-title"
  source: string;        // "nts" or "lotradio"
  showSlug: string;      // display identifier (slug for NTS, title for Lot Radio)
  approved: number;
  rejected: number;
  total: number;
  approvalRate: number;
  tier: "high" | "medium" | null;
}

interface NtsApiEpisode {
  episode_alias: string;
  show_alias: string;
  broadcast: string;
  name: string;
  media?: {
    picture_large?: string;
    picture_medium_large?: string;
    picture_medium?: string;
    background_large?: string;
  };
}

// ─── HELPERS ────────────────────────────────────────────────

function getCuratorKey(episode: { source: string; url: string; title: string | null }): string | null {
  if (episode.source === "nts") {
    const match = episode.url.match(/\/shows\/([^/]+)\//);
    return match ? `nts:${match[1]}` : null;
  }
  if (episode.source === "lotradio") {
    // Lot Radio shows are identified by episode title (e.g. "DJ Python", "Eris Drew")
    return episode.title ? `lotradio:${episode.title}` : null;
  }
  // Generic fallback
  return episode.title ? `${episode.source}:${episode.title}` : null;
}

async function fetchShowEpisodes(showSlug: string, limit: number): Promise<NtsApiEpisode[]> {
  const url = `${NTS_API}/shows/${showSlug}/episodes?offset=0&limit=${limit}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      log("fail", `NTS show episodes HTTP ${res.status} for "${showSlug}"`);
      return [];
    }
    const data = await res.json() as { results?: NtsApiEpisode[] };
    return data.results || [];
  } catch (err) {
    log("fail", `NTS show episodes fetch error for "${showSlug}": ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

// ─── STEP 1: COMPUTE CURATOR AFFINITY SCORES ────────────────

async function computeCuratorAffinities(): Promise<CuratorAffinity[]> {
  log("info", "Computing curator affinity scores from voting history...");

  // Get all reviewed tracks from curator-trackable sources (nts, lotradio)
  // Use the explicit FK hint to avoid ambiguity (tracks has both episode_id FK and episode_tracks junction)
  const { data: reviewedTracks, error } = await db
    .from("tracks")
    .select("episode_id, status, episode:episodes!episode_id(url, title, source)")
    .in("status", ["approved", "rejected"])
    .not("episode_id", "is", null);

  if (error) {
    log("fail", `Failed to fetch reviewed tracks: ${error.message}`);
    return [];
  }

  if (!reviewedTracks || reviewedTracks.length === 0) {
    log("info", "No reviewed tracks found — skipping curator affinity");
    return [];
  }

  // Group by curator key (source-agnostic)
  const showStats = new Map<string, { approved: number; rejected: number; source: string; showSlug: string }>();

  for (const track of reviewedTracks as any[]) {
    const ep = Array.isArray(track.episode) ? track.episode[0] : track.episode;
    if (!ep?.url) continue;
    // Filter to NTS/lotradio sources client-side (couldn't do in query due to FK ambiguity)
    if (ep.source !== "nts" && ep.source !== "lotradio") continue;

    const curatorKey = getCuratorKey({ source: ep.source, url: ep.url, title: ep.title ?? null });
    if (!curatorKey) continue;

    if (!showStats.has(curatorKey)) {
      // showSlug is the display identifier (slug for NTS, title for Lot Radio)
      const showSlug = curatorKey.substring(curatorKey.indexOf(":") + 1);
      showStats.set(curatorKey, { approved: 0, rejected: 0, source: ep.source, showSlug });
    }

    const stats = showStats.get(curatorKey)!;
    if (track.status === "approved") stats.approved++;
    else if (track.status === "rejected") stats.rejected++;
  }

  const affinities: CuratorAffinity[] = [];

  for (const [curatorKey, stats] of showStats) {
    const total = stats.approved + stats.rejected;
    if (total < 3) continue; // Need at least 3 reviewed tracks

    const approvalRate = stats.approved / total;
    if (approvalRate <= 0.4) continue; // Must be > 40%

    let tier: "high" | "medium" | null = null;
    if (approvalRate > 0.5 && total >= 5) {
      tier = "high";
    } else if (approvalRate > 0.4 && total >= 3) {
      tier = "medium";
    }

    if (tier) {
      affinities.push({
        curatorKey,
        source: stats.source,
        showSlug: stats.showSlug,
        approved: stats.approved,
        rejected: stats.rejected,
        total,
        approvalRate,
        tier,
      });
    }
  }

  // Sort by approval rate descending
  affinities.sort((a, b) => b.approvalRate - a.approvalRate);

  log("info", `Found ${affinities.length} curator(s) meeting affinity thresholds`);
  for (const a of affinities) {
    log("info", `  [${a.tier}] ${a.curatorKey}: ${a.approved}/${a.total} approved (${Math.round(a.approvalRate * 100)}%)`);
  }

  return affinities;
}

// ─── STEP 3+4: PROCESS EPISODES FOR A SHOW ──────────────────

async function processEpisode(
  episodeUrl: string,
  episodeTitle: string,
  airedDate: string | null,
  artworkUrl: string | null,
  affinity: CuratorAffinity,
): Promise<number> {
  // Check if episode already exists in DB
  const { data: existingEp } = await db
    .from("episodes")
    .select("id")
    .eq("url", episodeUrl)
    .maybeSingle();

  let episodeId: string;

  if (existingEp) {
    episodeId = existingEp.id;
    // Check if already has tracks
    const { count } = await db
      .from("tracks")
      .select("*", { count: "exact", head: true })
      .eq("episode_id", episodeId);

    if (count && count > 0) {
      log("skip", `Already crawled (${count} tracks): ${episodeTitle}`);
      return 0;
    }
  } else {
    // Insert new episode
    const { data: newEp, error: epErr } = await db
      .from("episodes")
      .insert({
        url: episodeUrl,
        title: episodeTitle || null,
        source: "nts",
        aired_date: airedDate || null,
        artwork_url: artworkUrl || null,
      })
      .select("id")
      .single();

    if (!newEp) {
      log("fail", `Episode insert failed: ${episodeTitle} — ${epErr?.message}`);
      return 0;
    }
    episodeId = newEp.id;
  }

  // Fetch tracklist
  const rawTracks = await ntsSource.getTracklist(episodeUrl);
  if (rawTracks.length === 0) {
    log("warn", `Empty tracklist: ${episodeTitle}`);
    return 0;
  }

  let tracksAdded = 0;

  for (let pos = 0; pos < rawTracks.length; pos++) {
    const track = rawTracks[pos];
    const lTitle = track.title.toLowerCase().trim();
    const lArtist = track.artist.toLowerCase().trim();

    if (GARBAGE_TITLES.has(lTitle) || lTitle.length <= 1 || lArtist.length <= 1) continue;

    // Dedup: check for existing track with same artist+title (case-insensitive)
    const { data: existing } = await db
      .from("tracks")
      .select("id")
      .ilike("artist", track.artist.trim())
      .ilike("title", track.title.trim())
      .limit(1);

    if (existing && existing.length > 0) continue;

    // Insert track with curator radar metadata
    const { data: inserted, error: trackErr } = await db
      .from("tracks")
      .insert({
        artist: track.artist.trim(),
        title: track.title.trim(),
        source: "nts",
        source_url: episodeUrl,
        source_context: episodeTitle,
        status: "pending",
        episode_id: episodeId,
        metadata: {
          discovery_method: "radar:curator",
          curator_slug: affinity.showSlug,
          curator_source: affinity.source,
          curator_affinity: Math.round(affinity.approvalRate * 100) / 100,
          curator_tier: affinity.tier,
          taste_score_multiplier: 0.9,
        },
      })
      .select("id")
      .single();

    if (trackErr || !inserted) continue;

    // Insert episode_tracks entry
    await db.from("episode_tracks").upsert(
      { episode_id: episodeId, track_id: inserted.id, position: pos },
      { onConflict: "episode_id,track_id" },
    );

    tracksAdded++;
  }

  log("ok", `${episodeTitle || episodeUrl} — ${rawTracks.length} tracks scraped, ${tracksAdded} new`);
  return tracksAdded;
}

async function processNtsShow(affinity: CuratorAffinity): Promise<{ episodesChecked: number; tracksAdded: number }> {
  const episodeLimit = affinity.tier === "high" ? 10 : 12; // fetch 12 for medium (new episodes only anyway)
  log("info", `[${affinity.tier}] Fetching NTS episodes for show: ${affinity.showSlug}`);

  const episodes = await fetchShowEpisodes(affinity.showSlug, episodeLimit);
  if (episodes.length === 0) {
    log("warn", `No episodes returned from NTS API for ${affinity.showSlug}`);
    return { episodesChecked: 0, tracksAdded: 0 };
  }

  // For medium tier: only new episodes (not already in DB)
  // For high tier: backfill last 10 episodes regardless
  let episodesToProcess = episodes;

  if (affinity.tier === "medium") {
    // Filter to only episodes not in DB
    const episodeUrls = episodes.map(
      (ep) => `https://www.nts.live/shows/${ep.show_alias}/episodes/${ep.episode_alias}`
    );
    const { data: existingEps } = await db
      .from("episodes")
      .select("url")
      .in("url", episodeUrls);

    const existingUrls = new Set((existingEps || []).map((e: any) => e.url));
    episodesToProcess = episodes.filter(
      (ep) => !existingUrls.has(`https://www.nts.live/shows/${ep.show_alias}/episodes/${ep.episode_alias}`)
    );

    if (episodesToProcess.length === 0) {
      log("info", `No new episodes for medium-affinity show: ${affinity.showSlug}`);
      return { episodesChecked: 0, tracksAdded: 0 };
    }
  }

  let totalTracksAdded = 0;
  let episodesChecked = 0;

  // Process episodes in batches respecting concurrency limit
  for (let i = 0; i < episodesToProcess.length; i += CONCURRENCY.episodes) {
    const batch = episodesToProcess.slice(i, i + CONCURRENCY.episodes);
    const results = await Promise.allSettled(
      batch.map(async (ep) => {
        const episodeUrl = `https://www.nts.live/shows/${ep.show_alias}/episodes/${ep.episode_alias}`;
        const airedDate = ep.broadcast ? ep.broadcast.split("T")[0] : null;
        const artworkUrl =
          ep.media?.picture_large ||
          ep.media?.picture_medium_large ||
          ep.media?.picture_medium ||
          ep.media?.background_large ||
          null;

        return processEpisode(episodeUrl, ep.name, airedDate, artworkUrl, affinity);
      })
    );

    for (const result of results) {
      episodesChecked++;
      if (result.status === "fulfilled") {
        totalTracksAdded += result.value;
      } else {
        log("fail", `Episode processing error: ${result.reason}`);
      }
    }

    // Small delay between batches to be polite to NTS API
    if (i + CONCURRENCY.episodes < episodesToProcess.length) {
      await sleep(500);
    }
  }

  return { episodesChecked, tracksAdded: totalTracksAdded };
}

async function processLotRadioShow(affinity: CuratorAffinity): Promise<{ episodesChecked: number; tracksAdded: number }> {
  log("info", `[${affinity.tier}] Checking Lot Radio episodes for: ${affinity.showSlug}`);

  // Lot Radio episodes are crawled externally — query DB for episodes matching this show (by title)
  const episodeLimit = affinity.tier === "high" ? 10 : 5;
  const { data: episodes } = await db
    .from("episodes")
    .select("id, url, title, aired_date, artwork_url")
    .eq("source", "lotradio")
    .ilike("title", affinity.showSlug)
    .order("aired_date", { ascending: false })
    .limit(episodeLimit);

  if (!episodes || episodes.length === 0) {
    log("info", `No Lot Radio episodes found in DB for: ${affinity.showSlug}`);
    return { episodesChecked: 0, tracksAdded: 0 };
  }

  let totalTracksAdded = 0;
  let episodesChecked = 0;

  for (let i = 0; i < episodes.length; i += CONCURRENCY.episodes) {
    const batch = episodes.slice(i, i + CONCURRENCY.episodes);
    const results = await Promise.allSettled(
      batch.map((ep: any) =>
        processEpisode(ep.url, ep.title, ep.aired_date, ep.artwork_url, affinity)
      )
    );

    for (const result of results) {
      episodesChecked++;
      if (result.status === "fulfilled") {
        totalTracksAdded += result.value;
      } else {
        log("fail", `Episode processing error: ${result.reason}`);
      }
    }
  }

  return { episodesChecked, tracksAdded: totalTracksAdded };
}

async function processShow(affinity: CuratorAffinity): Promise<{ episodesChecked: number; tracksAdded: number }> {
  if (affinity.source === "nts") {
    return processNtsShow(affinity);
  }
  if (affinity.source === "lotradio") {
    return processLotRadioShow(affinity);
  }
  log("warn", `No handler for source "${affinity.source}", skipping ${affinity.curatorKey}`);
  return { episodesChecked: 0, tracksAdded: 0 };
}

// ─── MAIN EXPORT ─────────────────────────────────────────────

export async function runCuratorRadar(): Promise<void> {
  const t0 = Date.now();
  console.log(`\n━━━ CURATOR RADAR: Starting run ━━━`);
  console.log(`  ${new Date().toISOString()}\n`);

  await logEngineEvent("discover_started", "started", {
    message: "Curator radar run started",
    metadata: { trigger: "radar_curator_run" },
  });

  try {
    // Step 1: Compute affinity scores
    const affinities = await computeCuratorAffinities();

    if (affinities.length === 0) {
      log("info", "No curators meet affinity thresholds — nothing to do");
      await logEngineEvent("discover_completed", "completed", {
        message: "Curator radar: no qualifying curators found",
        metadata: {
          shows_processed: 0,
          episodes_checked: 0,
          tracks_added: 0,
          duration_ms: Date.now() - t0,
        },
      });
      return;
    }

    let totalEpisodesChecked = 0;
    let totalTracksAdded = 0;

    // Step 2+3: Process shows in batches
    for (let i = 0; i < affinities.length; i += CONCURRENCY.shows) {
      const batch = affinities.slice(i, i + CONCURRENCY.shows);
      const results = await Promise.allSettled(batch.map(processShow));

      for (const result of results) {
        if (result.status === "fulfilled") {
          totalEpisodesChecked += result.value.episodesChecked;
          totalTracksAdded += result.value.tracksAdded;
        } else {
          log("fail", `Show processing error: ${result.reason}`);
        }
      }

      // Small delay between show batches
      if (i + CONCURRENCY.shows < affinities.length) {
        await sleep(1000);
      }
    }

    const durationMs = Date.now() - t0;
    const durationSec = (durationMs / 1000).toFixed(1);

    console.log(`\n  Curator radar done (${durationSec}s)`);
    console.log(`  Shows: ${affinities.length}, Episodes: ${totalEpisodesChecked}, Tracks added: ${totalTracksAdded}\n`);

    await logEngineEvent("discover_completed", "completed", {
      message: `Curator radar: ${totalTracksAdded} tracks added from ${affinities.length} show(s)`,
      metadata: {
        shows_processed: affinities.length,
        high_affinity: affinities.filter((a) => a.tier === "high").length,
        medium_affinity: affinities.filter((a) => a.tier === "medium").length,
        episodes_checked: totalEpisodesChecked,
        tracks_added: totalTracksAdded,
        duration_ms: durationMs,
      },
    });
  } catch (err) {
    log("fail", `Curator radar error: ${err instanceof Error ? err.message : err}`);
    await logEngineEvent("error", "failed", {
      message: `Curator radar failed: ${err instanceof Error ? err.message : err}`,
    });
    throw err;
  }
}

// ─── STANDALONE ENTRYPOINT ───────────────────────────────────

if (import.meta.main) {
  runCuratorRadar()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
