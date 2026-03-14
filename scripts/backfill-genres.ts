#!/usr/bin/env bun
/**
 * Backfill Spotify artist genres for tracks that have a spotify_id but no genres.
 *
 * Fetches artist IDs from the Spotify track endpoint, then batch-fetches
 * genres from the artists endpoint. Updates metadata.genres in-place.
 *
 * Usage: bun run scripts/backfill-genres.ts [--dry-run] [--limit 500]
 */
import { parseArgs } from "util";
import { getSupabase } from "../lib/supabase";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "dry-run": { type: "boolean", default: false },
    limit: { type: "string", default: "5000" },
  },
  strict: false,
});

const dryRun = values["dry-run"] || false;
const limit = parseInt(String(values.limit || "5000"), 10);

const db = getSupabase();
const SPOTIFY_API = "https://api.spotify.com/v1";
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
let cachedToken: string | null = null;
let tokenExpiry = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function getSpotifyToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiry - 60_000) return cachedToken;
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Missing SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET");
  const creds = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: { Authorization: `Basic ${creds}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`Spotify auth failed: ${res.status}`);
  const data = await res.json() as { access_token: string; expires_in: number };
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + data.expires_in * 1000;
  return cachedToken;
}

async function fetchWithRetry(url: string, token: string): Promise<any> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 429) {
    const wait = parseInt(res.headers.get("Retry-After") || "5", 10);
    console.log(`  Rate limited — waiting ${wait}s`);
    await sleep(wait * 1000);
    return fetchWithRetry(url, token);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

async function main() {
  console.log(`\n=== Backfill Spotify Artist Genres ===`);
  console.log(`Mode: ${dryRun ? "DRY RUN" : "LIVE"}, Limit: ${limit}\n`);

  // Fetch tracks that have spotify_id but no genres (paginate past Supabase 1000-row cap)
  const allTracks: any[] = [];
  let page = 0;
  const PAGE_SIZE = 1000;
  while (allTracks.length < limit) {
    const { data, error } = await db
      .from("tracks")
      .select("id, artist, title, metadata")
      .not("metadata->spotify_id", "is", null)
      .order("created_at")
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
    if (error) {
      console.error(`Failed to fetch tracks (page ${page}): ${error.message}`);
      process.exit(1);
    }
    if (!data || data.length === 0) break;
    allTracks.push(...data);
    if (data.length < PAGE_SIZE) break;
    page++;
  }

  // Filter to tracks missing genres
  const needsGenres = allTracks.filter(
    (t: any) => t.metadata?.spotify_id && !t.metadata?.genres?.length
  );

  console.log(`${allTracks.length} tracks with spotify_id, ${needsGenres.length} missing genres\n`);

  if (needsGenres.length === 0) {
    console.log("Nothing to backfill.");
    return;
  }

  const token = await getSpotifyToken();

  // Step 1: Batch-fetch track details to get artist IDs (50 at a time)
  console.log(`Step 1: Fetching artist IDs from Spotify tracks...`);
  const trackArtistMap = new Map<string, string[]>(); // track db id -> artist spotify ids

  const spotifyIds = needsGenres.map((t: any) => t.metadata.spotify_id);
  for (let i = 0; i < spotifyIds.length; i += 50) {
    const batch = spotifyIds.slice(i, i + 50);
    const ids = batch.join(",");
    try {
      const data = await fetchWithRetry(`${SPOTIFY_API}/tracks?ids=${ids}`, token);
      for (let j = 0; j < (data.tracks || []).length; j++) {
        const spotTrack = data.tracks[j];
        if (!spotTrack) continue;
        const dbTrack = needsGenres[i + j];
        const artistIds = (spotTrack.artists || []).map((a: any) => a.id).filter(Boolean);
        trackArtistMap.set(dbTrack.id, artistIds);
      }
    } catch (err) {
      console.error(`  Batch ${i}-${i + 50} failed: ${err instanceof Error ? err.message : err}`);
    }
    await sleep(100);
  }

  console.log(`  Got artist IDs for ${trackArtistMap.size} tracks`);

  // Step 2: Collect unique artist IDs and batch-fetch their genres
  console.log(`\nStep 2: Fetching artist genres...`);
  const allArtistIds = new Set<string>();
  for (const ids of trackArtistMap.values()) {
    for (const id of ids) allArtistIds.add(id);
  }
  console.log(`  ${allArtistIds.size} unique artists to look up`);

  const artistGenreMap = new Map<string, string[]>(); // artist id -> genres
  const artistIdList = Array.from(allArtistIds);

  for (let i = 0; i < artistIdList.length; i += 50) {
    const batch = artistIdList.slice(i, i + 50);
    try {
      const data = await fetchWithRetry(`${SPOTIFY_API}/artists?ids=${batch.join(",")}`, token);
      for (const artist of data.artists || []) {
        if (artist?.id) {
          artistGenreMap.set(artist.id, artist.genres || []);
        }
      }
    } catch (err) {
      console.error(`  Artist batch ${i}-${i + 50} failed: ${err instanceof Error ? err.message : err}`);
    }
    await sleep(100);
  }

  console.log(`  Got genres for ${artistGenreMap.size} artists`);

  // Step 3: Merge genres per track and update DB
  console.log(`\nStep 3: Updating tracks...`);
  let updated = 0;
  let noGenres = 0;
  let errors = 0;

  for (const track of needsGenres) {
    const artistIds = trackArtistMap.get(track.id);
    if (!artistIds) continue;

    const genres = new Set<string>();
    for (const aid of artistIds) {
      for (const g of artistGenreMap.get(aid) || []) genres.add(g);
    }

    if (genres.size === 0) {
      noGenres++;
      continue;
    }

    const genreArray = Array.from(genres);

    if (dryRun) {
      console.log(`  [dry] ${track.artist} – ${track.title}: ${genreArray.join(", ")}`);
      updated++;
      continue;
    }

    const { error } = await db
      .from("tracks")
      .update({
        metadata: { ...track.metadata, genres: genreArray },
      })
      .eq("id", track.id);

    if (error) {
      console.error(`  Failed: ${track.artist} – ${track.title}: ${error.message}`);
      errors++;
    } else {
      updated++;
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Updated: ${updated}`);
  console.log(`No genres found: ${noGenres} (artist has no Spotify genres)`);
  console.log(`Errors: ${errors}`);

  // Show genre distribution
  if (!dryRun && updated > 0) {
    const { data: genreStats } = await db.rpc("get_genre_counts");
    if (!genreStats) {
      // Fallback: just show a sample
      const { data: sample } = await db
        .from("tracks")
        .select("artist, metadata->genres")
        .not("metadata->genres", "is", null)
        .limit(5);
      if (sample) {
        console.log(`\nSample enriched tracks:`);
        for (const t of sample) {
          console.log(`  ${t.artist}: ${JSON.stringify(t.genres)}`);
        }
      }
    }
  }

  console.log("");
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
