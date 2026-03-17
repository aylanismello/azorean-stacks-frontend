#!/usr/bin/env bun
/**
 * One-off fix: update episode_seeds rows where match_type='unknown'
 *
 * For each unknown match, checks the episode's tracklist:
 *   - exact artist+title match → 'full'
 *   - artist-only match       → 'artist'
 *   - no match                → logs as suspicious (skips update)
 *
 * Usage: bun run scripts/fix-match-types.ts
 */
import { getSupabase } from "../lib/supabase";

const db = getSupabase();

async function main() {
  console.log("Fetching episode_seeds with match_type='unknown'...");

  const { data: unknowns, error } = await db
    .from("episode_seeds")
    .select("id, episode_id, seed_id, match_type")
    .eq("match_type", "unknown");

  if (error) {
    console.error("Failed to fetch episode_seeds:", error.message);
    process.exit(1);
  }

  if (!unknowns || unknowns.length === 0) {
    console.log("No rows with match_type='unknown' found.");
    return;
  }

  console.log(`Found ${unknowns.length} rows to process.\n`);

  let full = 0;
  let artist = 0;
  let suspicious = 0;
  let errors = 0;

  for (const row of unknowns) {
    // Fetch the seed's artist+title
    const { data: seed, error: seedErr } = await db
      .from("seeds")
      .select("artist, title")
      .eq("id", row.seed_id)
      .single();

    if (seedErr || !seed) {
      console.error(`  [error] Could not fetch seed ${row.seed_id}: ${seedErr?.message ?? "not found"}`);
      errors++;
      continue;
    }

    const seedArtistLower = seed.artist.toLowerCase().trim();
    const seedTitleLower = seed.title.toLowerCase().trim();

    // Fetch the episode's tracklist via episode_tracks → tracks
    const { data: episodeTracks, error: tracksErr } = await db
      .from("episode_tracks")
      .select("tracks(artist, title)")
      .eq("episode_id", row.episode_id);

    if (tracksErr || !episodeTracks) {
      console.error(`  [error] Could not fetch episode tracks for episode ${row.episode_id}: ${tracksErr?.message ?? "not found"}`);
      errors++;
      continue;
    }

    const tracklist = episodeTracks
      .map((et: any) => (Array.isArray(et.tracks) ? et.tracks[0] : et.tracks))
      .filter(Boolean) as Array<{ artist: string; title: string }>;

    const hasFullMatch = tracklist.some(
      (t) =>
        t.artist.toLowerCase().trim() === seedArtistLower &&
        t.title.toLowerCase().trim() === seedTitleLower,
    );

    const hasArtistMatch = tracklist.some(
      (t) => t.artist.toLowerCase().trim() === seedArtistLower,
    );

    let newMatchType: string;

    if (hasFullMatch) {
      newMatchType = "full";
      full++;
    } else if (hasArtistMatch) {
      newMatchType = "artist";
      artist++;
    } else {
      console.warn(
        `  [suspicious] No match for seed "${seed.artist} – ${seed.title}" in episode ${row.episode_id} — skipping`,
      );
      suspicious++;
      continue;
    }

    const { error: updateErr } = await db
      .from("episode_seeds")
      .update({ match_type: newMatchType })
      .eq("id", row.id);

    if (updateErr) {
      console.error(`  [error] Failed to update row ${row.id}: ${updateErr.message}`);
      errors++;
    } else {
      console.log(`  [${newMatchType}] ${seed.artist} – ${seed.title}`);
    }
  }

  console.log(`
Done.
  full:       ${full}
  artist:     ${artist}
  suspicious: ${suspicious}
  errors:     ${errors}
`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
