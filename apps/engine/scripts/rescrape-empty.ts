#!/usr/bin/env bun
/**
 * Re-scrape episodes with 0 tracks.
 *
 * 1. Find all episodes with 0 associated tracks
 * 2. For each, re-fetch the tracklist from its source (NTS or Lot Radio)
 * 3. If tracks found, insert them into episode_tracks
 * 4. If still empty after re-fetch, mark the episode as skipped
 *    with a note "empty tracklist after retry"
 * 5. Print summary
 *
 * Usage: bun run rescrape-empty [--dry-run] [--limit 50]
 */
import { parseArgs } from "util";
import { getSupabase } from "../lib/supabase";
import { SOURCES } from "../lib/sources/index";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "dry-run": { type: "boolean", default: false },
    limit: { type: "string", default: "100" },
  },
  strict: false,
});

const dryRun = values["dry-run"] as boolean;
const limit = parseInt(String(values.limit || "100"), 10);
const db = getSupabase();

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function log(icon: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`  ${ts} ${icon} ${msg}`);
}

async function main() {
  console.log(`\n━━━ RESCRAPE EMPTY EPISODES ${dryRun ? "(DRY RUN)" : ""} ━━━\n`);

  // Find all episodes with 0 tracks (not already skipped)
  const { data: allEpisodes, error: epErr } = await db
    .from("episodes")
    .select("id, url, title, source, aired_date, metadata")
    .eq("skipped", false)
    .limit(limit * 5); // fetch more than limit to filter by track count

  if (epErr) {
    console.error("  Failed to fetch episodes:", epErr.message);
    process.exit(1);
  }

  if (!allEpisodes?.length) {
    console.log("  No episodes found.");
    return;
  }

  // Find which episodes have 0 tracks (paginate .in() to avoid 1000-row cap)
  const episodeIds = allEpisodes.map((e) => e.id);
  const allTrackLinks: any[] = [];
  const PAGE = 1000;
  for (let i = 0; i < episodeIds.length; i += PAGE) {
    const batch = episodeIds.slice(i, i + PAGE);
    const { data: page } = await db
      .from("episode_tracks")
      .select("episode_id")
      .in("episode_id", batch);
    if (page) allTrackLinks.push(...page);
  }

  const episodesWithTracks = new Set(allTrackLinks.map((l: any) => l.episode_id));

  const emptyEpisodes = allEpisodes.filter((e) => !episodesWithTracks.has(e.id)).slice(0, limit);

  console.log(`  ${emptyEpisodes.length} episodes with 0 tracks (of ${allEpisodes.length} checked)\n`);

  if (emptyEpisodes.length === 0) {
    console.log("  Nothing to rescrape.");
    return;
  }

  let refilled = 0;
  let stillEmpty = 0;
  let errors = 0;

  for (const ep of emptyEpisodes) {
    const label = ep.title || ep.url;
    const source = SOURCES.find((s) => s.name === ep.source);

    if (!source) {
      log("→", `Unknown source "${ep.source}" for: ${label}`);
      stillEmpty++;
      continue;
    }

    log("·", `Re-fetching: ${label}`);
    await sleep(1000);

    let rawTracks: Array<{ artist: string; title: string }> = [];
    try {
      rawTracks = await source.getTracklist(ep.url);
    } catch (err) {
      log("✗", `Fetch error: ${label} — ${err instanceof Error ? err.message : err}`);
      errors++;
      continue;
    }

    if (rawTracks.length === 0) {
      log("→", `Still empty after retry: ${label}`);
      stillEmpty++;

      if (!dryRun) {
        await db.from("episodes").update({
          skipped: true,
          metadata: {
            ...(ep.metadata || {}),
            skip_reason: "empty tracklist after retry",
          },
        }).eq("id", ep.id);
        log("·", `  Marked as skipped`);
      }
      continue;
    }

    log("✓", `Found ${rawTracks.length} tracks: ${label}`);

    if (dryRun) {
      refilled++;
      continue;
    }

    // Insert tracks and link to episode
    let inserted = 0;
    for (let pos = 0; pos < rawTracks.length; pos++) {
      const t = rawTracks[pos];
      if (!t.artist?.trim() || !t.title?.trim()) continue;

      // Check if track already exists
      const { data: existingTrack } = await db.from("tracks")
        .select("id")
        .ilike("artist", t.artist)
        .ilike("title", t.title)
        .limit(1)
        .maybeSingle();

      let trackId: string;

      if (existingTrack) {
        trackId = existingTrack.id;
      } else {
        const { data: newTrack, error: insertErr } = await db.from("tracks").insert({
          artist: t.artist.trim(),
          title: t.title.trim(),
          source: ep.source,
          source_url: ep.url,
          source_context: ep.title || ep.url,
          status: "pending",
          episode_id: ep.id,
          metadata: {},
        }).select("id").single();

        if (insertErr || !newTrack) {
          log("✗", `  Track insert failed: ${t.artist} – ${t.title}`);
          continue;
        }
        trackId = newTrack.id;
        inserted++;
      }

      await db.from("episode_tracks").upsert(
        { episode_id: ep.id, track_id: trackId, position: pos },
        { onConflict: "episode_id,track_id" }
      );
    }

    log("✓", `  Inserted ${inserted} new tracks, linked ${rawTracks.length} total`);
    refilled++;
  }

  console.log(`\n  ── Summary ──`);
  console.log(`  Episodes checked:   ${emptyEpisodes.length}`);
  console.log(`  Successfully filled: ${refilled}`);
  console.log(`  Still empty (skipped): ${stillEmpty}`);
  console.log(`  Errors:             ${errors}`);
  if (dryRun) console.log(`\n  (DRY RUN — no changes written)`);
  console.log("");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
