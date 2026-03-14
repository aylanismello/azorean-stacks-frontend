#!/usr/bin/env bun
/**
 * Backfill episode_tracks.position from NTS API tracklists.
 *
 * For each episode with null positions, fetches the NTS tracklist
 * and matches tracks by artist+title to set the correct position.
 */
import { getSupabase } from "../lib/supabase";

const db = getSupabase();
const NTS_API = "https://www.nts.live/api/v2";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

interface NTSTrack { artist: string; title: string }

async function ntsTracklist(episodeUrl: string): Promise<NTSTrack[]> {
  // Extract the path from the full URL
  const path = episodeUrl.replace("https://www.nts.live", "");
  const url = `${NTS_API}${path}/tracklist`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return [];
    const data = await res.json();
    const tracks = data.results || (data as unknown as NTSTrack[]);
    if (!Array.isArray(tracks)) return [];
    return tracks
      .filter((t: any) => t.artist?.trim() && t.title?.trim())
      .map((t: any) => ({ artist: t.artist.trim(), title: t.title.trim() }));
  } catch {
    return [];
  }
}

async function main() {
  // Get all episodes that have episode_tracks with null position
  const { data: episodes, error } = await db
    .from("episodes")
    .select("id, url")
    .eq("source", "nts");

  if (error || !episodes) {
    console.error("Failed to fetch episodes:", error?.message);
    process.exit(1);
  }

  console.log(`Found ${episodes.length} NTS episodes to backfill\n`);

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const ep of episodes) {
    // Check if this episode has any null positions
    const { data: nullRows } = await db
      .from("episode_tracks")
      .select("track_id")
      .eq("episode_id", ep.id)
      .is("position", null)
      .limit(1);

    if (!nullRows || nullRows.length === 0) {
      skipped++;
      continue;
    }

    await sleep(500); // respect NTS rate limits

    const ntsTracks = await ntsTracklist(ep.url);
    if (ntsTracks.length === 0) {
      console.log(`  ✗ Empty tracklist: ${ep.url}`);
      failed++;
      continue;
    }

    // Get all tracks for this episode from the junction table
    const { data: etRows } = await db
      .from("episode_tracks")
      .select("track_id, tracks(artist, title)")
      .eq("episode_id", ep.id);

    if (!etRows) continue;

    let epUpdated = 0;
    for (const row of etRows) {
      const track = (row as any).tracks;
      if (!track) continue;

      // Find position in NTS tracklist by matching artist+title (case-insensitive)
      const pos = ntsTracks.findIndex(
        (nt) =>
          nt.artist.toLowerCase() === track.artist.toLowerCase() &&
          nt.title.toLowerCase() === track.title.toLowerCase()
      );

      if (pos >= 0) {
        const { error: updateErr } = await db
          .from("episode_tracks")
          .update({ position: pos })
          .eq("episode_id", ep.id)
          .eq("track_id", row.track_id);

        if (!updateErr) epUpdated++;
      }
    }

    updated += epUpdated;
    console.log(`  ✓ ${ep.url} — ${epUpdated}/${etRows.length} positions set (${ntsTracks.length} NTS tracks)`);
  }

  console.log(`\nDone: ${updated} positions set, ${skipped} already done, ${failed} failed`);
}

main().catch((err) => {
  console.error("Backfill crashed:", err);
  process.exit(1);
});
