#!/usr/bin/env bun
/**
 * Backfill cover_art_url for seeds using Spotify search.
 *
 * Looks up each seed song on Spotify and saves the album artwork URL.
 *
 * Usage: bun run scripts/backfill-seed-covers.ts
 */
import { getSupabase } from "../lib/supabase";

const db = getSupabase();

const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_API = "https://api.spotify.com/v1";
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
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + data.expires_in * 1000;
  return cachedToken;
}

type SpotifyTrackItem = {
  name: string;
  artists: Array<{ name: string }>;
  album: { name: string; images: Array<{ url: string; width?: number }> };
  external_urls: { spotify: string };
};

function stringSimilarity(a: string, b: string): number {
  const na = a.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const nb = b.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  if (na === nb) return 100;
  if (!na || !nb) return 0;
  const maxLen = Math.max(na.length, nb.length);
  if (na.includes(nb) || nb.includes(na)) {
    return Math.round(Math.max(70, (Math.min(na.length, nb.length) / maxLen) * 100));
  }
  // Levenshtein
  const m = na.length, n = nb.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (na[i - 1] === nb[j - 1] ? 0 : 1));
    }
    [prev, curr] = [curr, prev];
  }
  return Math.round(Math.max(0, (1 - prev[n] / maxLen) * 100));
}

async function findSeedCoverArt(artist: string, title: string): Promise<string | null> {
  const token = await getSpotifyToken();
  const primaryArtist = artist.split(/[,&]/)[0].trim();

  const strategies = [
    `track:${title} artist:${primaryArtist}`,
    `${primaryArtist} ${title}`,
  ];

  const seen = new Set<string>();
  const candidates: SpotifyTrackItem[] = [];

  for (const query of strategies) {
    const q = encodeURIComponent(query);
    const res = await fetch(`${SPOTIFY_API}/search?q=${q}&type=track&limit=5`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 429) {
      const wait = parseInt(res.headers.get("Retry-After") || "5", 10);
      console.log(`  Rate limited, waiting ${wait}s...`);
      await sleep(wait * 1000);
      continue;
    }
    if (!res.ok) continue;
    const data = (await res.json()) as { tracks: { items: SpotifyTrackItem[] } };
    for (const item of data.tracks?.items || []) {
      const key = item.external_urls.spotify;
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push(item);
      }
    }
    await sleep(100);
  }

  if (!candidates.length) return null;

  // Score and pick best match
  let best: SpotifyTrackItem | null = null;
  let bestScore = -1;

  for (const item of candidates) {
    const candidateArtist = item.artists.map((a) => a.name).join(", ");
    const artistScore = Math.max(
      stringSimilarity(primaryArtist, item.artists[0]?.name || ""),
      stringSimilarity(artist, candidateArtist),
    );
    const titleScore = stringSimilarity(title, item.name);
    const score = artistScore * 0.4 + titleScore * 0.6;

    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }

  if (!best || bestScore < 40) {
    console.log(`  ✗ No confident match (best score: ${Math.round(bestScore)})`);
    return null;
  }

  const coverUrl = best.album?.images?.[0]?.url || null;
  console.log(`  ✓ Matched: ${best.artists[0]?.name} – ${best.name} (score: ${Math.round(bestScore)}, album: ${best.album?.name})`);
  return coverUrl;
}

async function main() {
  console.log("\n  Backfill Seed Cover Art\n");

  const { data: seeds, error } = await db
    .from("seeds")
    .select("id, artist, title, cover_art_url")
    .order("created_at");

  if (error) throw new Error(`Failed to fetch seeds: ${error.message}`);
  if (!seeds?.length) {
    console.log("  No seeds found.");
    return;
  }

  const toBackfill = seeds.filter((s) => !s.cover_art_url);
  console.log(`  ${seeds.length} seeds total, ${toBackfill.length} need cover art\n`);

  let updated = 0;
  let failed = 0;

  for (const seed of toBackfill) {
    console.log(`  ${seed.artist} – ${seed.title}`);
    const coverUrl = await findSeedCoverArt(seed.artist, seed.title);

    if (coverUrl) {
      const { error: updateErr } = await db
        .from("seeds")
        .update({ cover_art_url: coverUrl })
        .eq("id", seed.id);

      if (updateErr) {
        console.log(`  ✗ DB update failed: ${updateErr.message}`);
        failed++;
      } else {
        updated++;
      }
    } else {
      failed++;
    }

    await sleep(200);
  }

  console.log(`\n  Done: ${updated} updated, ${failed} failed\n`);
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
