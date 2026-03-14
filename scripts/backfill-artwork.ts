#!/usr/bin/env bun
/**
 * Backfill episode artwork + fix bad Spotify matches.
 *
 * 1. Fetches artwork from NTS API for episodes missing artwork_url
 * 2. Clears bad Spotify matches (confidence < 55) — nulls spotify_url + cover_art_url
 * 3. Applies episode artwork as fallback for tracks with no cover_art_url
 *
 * Usage: bun run backfill-artwork [--dry-run]
 */
import { getSupabase } from "../lib/supabase";

const dryRun = Bun.argv.includes("--dry-run");
const db = getSupabase();
const NTS_API = "https://www.nts.live/api/v2";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function log(icon: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`  ${ts} ${icon} ${msg}`);
}

async function fetchEpisodeArtwork(episodeUrl: string): Promise<string | null> {
  // Extract API path from full URL: https://www.nts.live/shows/foo/episodes/bar → /shows/foo/episodes/bar
  const path = episodeUrl.replace("https://www.nts.live", "");
  try {
    const res = await fetch(`${NTS_API}${path}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      media?: {
        picture_large?: string;
        picture_medium_large?: string;
        picture_medium?: string;
        background_large?: string;
        background_medium_large?: string;
      };
    };
    return (
      data.media?.picture_large ||
      data.media?.picture_medium_large ||
      data.media?.picture_medium ||
      data.media?.background_large ||
      data.media?.background_medium_large ||
      null
    );
  } catch {
    return null;
  }
}

async function main() {
  console.log(`\n━━━ BACKFILL ARTWORK ${dryRun ? "(DRY RUN)" : ""} ━━━\n`);

  // ── Step 1: Fetch artwork for episodes missing artwork_url ──
  console.log("  ── Step 1: Backfill episode artwork from NTS API ──\n");

  const { data: episodes, error: epErr } = await db
    .from("episodes")
    .select("id, url, source")
    .is("artwork_url", null)
    .eq("source", "nts");

  if (epErr) {
    console.error("  Failed to fetch episodes:", epErr.message);
    process.exit(1);
  }

  console.log(`  ${episodes?.length ?? 0} NTS episodes missing artwork\n`);

  let epUpdated = 0;
  let epFailed = 0;

  for (const ep of episodes || []) {
    const artwork = await fetchEpisodeArtwork(ep.url);
    if (artwork) {
      if (!dryRun) {
        const { error } = await db
          .from("episodes")
          .update({ artwork_url: artwork })
          .eq("id", ep.id);
        if (error) {
          log("✗", `Failed to update episode ${ep.id}: ${error.message}`);
          epFailed++;
          continue;
        }
      }
      log("✓", `${ep.url.split("/").slice(-1)} → artwork fetched`);
      epUpdated++;
    } else {
      log("→", `${ep.url.split("/").slice(-1)} → no artwork found`);
      epFailed++;
    }

    await sleep(500); // respect NTS rate limits
  }

  console.log(`\n  Episodes: ${epUpdated} updated, ${epFailed} skipped/failed\n`);

  // ── Step 2: Clear bad Spotify matches (confidence < 55) ──
  console.log("  ── Step 2: Clear bad Spotify matches ──\n");

  // Find tracks with low Spotify confidence that have a spotify_url and/or cover_art_url from Spotify
  const { data: badTracks, error: btErr } = await db
    .from("tracks")
    .select("id, artist, title, cover_art_url, spotify_url, metadata")
    .not("spotify_url", "is", null)
    .not("spotify_url", "eq", "");

  if (btErr) {
    console.error("  Failed to fetch tracks:", btErr.message);
    process.exit(1);
  }

  const lowConfTracks = (badTracks || []).filter((t: any) => {
    const conf = t.metadata?.spotify_confidence;
    return typeof conf === "number" && conf < 55;
  });

  console.log(`  ${lowConfTracks.length} tracks with Spotify confidence < 55\n`);

  let cleared = 0;
  for (const track of lowConfTracks) {
    const label = `${track.artist} – ${track.title}`;
    const conf = (track.metadata as any)?.spotify_confidence;

    if (!dryRun) {
      // Clear spotify_url and cover_art_url if artwork came from Spotify
      const isSpotifyArt =
        track.cover_art_url?.includes("i.scdn.co") ||
        track.cover_art_url?.includes("spotify");

      const updates: Record<string, unknown> = { spotify_url: null };
      if (isSpotifyArt) {
        updates.cover_art_url = null;
      }

      const { error } = await db
        .from("tracks")
        .update(updates)
        .eq("id", track.id);
      if (error) {
        log("✗", `Failed to clear ${label}: ${error.message}`);
        continue;
      }
    }

    log("✓", `Cleared spotify (conf=${conf}): ${label}`);
    cleared++;
  }

  console.log(`\n  Cleared: ${cleared} bad Spotify matches\n`);

  // ── Step 3: Apply episode artwork to tracks with no cover_art_url ──
  console.log("  ── Step 3: Apply episode artwork fallback ──\n");

  // Get tracks with no cover_art_url that have an episode_id
  const { data: noCoverTracks, error: ncErr } = await db
    .from("tracks")
    .select("id, artist, title, episode_id")
    .is("cover_art_url", null)
    .not("episode_id", "is", null);

  if (ncErr) {
    console.error("  Failed to fetch tracks:", ncErr.message);
    process.exit(1);
  }

  console.log(`  ${noCoverTracks?.length ?? 0} tracks with no cover art\n`);

  // Also check episode_tracks junction for tracks that might not have episode_id directly
  // but are linked through the junction table
  const tracksNeedingArt = noCoverTracks || [];

  // Build a set of episode IDs we need artwork for
  const episodeIds = new Set(tracksNeedingArt.map((t: any) => t.episode_id).filter(Boolean));

  // Fetch episode artwork in bulk
  const artworkMap = new Map<string, string>();
  if (episodeIds.size > 0) {
    const { data: epsWithArt } = await db
      .from("episodes")
      .select("id, artwork_url")
      .in("id", Array.from(episodeIds))
      .not("artwork_url", "is", null);

    for (const ep of epsWithArt || []) {
      artworkMap.set(ep.id, ep.artwork_url);
    }
  }

  let applied = 0;
  for (const track of tracksNeedingArt) {
    const artwork = artworkMap.get(track.episode_id);
    if (!artwork) continue;

    const label = `${track.artist} – ${track.title}`;
    if (!dryRun) {
      const { error } = await db
        .from("tracks")
        .update({ cover_art_url: artwork })
        .eq("id", track.id);
      if (error) {
        log("✗", `Failed to apply artwork for ${label}: ${error.message}`);
        continue;
      }
    }

    log("✓", `Applied episode artwork: ${label}`);
    applied++;
  }

  console.log(`\n  Applied episode artwork to ${applied} tracks\n`);

  // ── Summary ──
  console.log("  ── Summary ──");
  console.log(`  Episode artwork fetched:     ${epUpdated}`);
  console.log(`  Bad Spotify matches cleared: ${cleared}`);
  console.log(`  Episode artwork applied:     ${applied}`);
  if (dryRun) console.log(`\n  (DRY RUN — no changes written)`);
  console.log("");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
