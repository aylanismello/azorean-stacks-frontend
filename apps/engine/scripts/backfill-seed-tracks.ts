#!/usr/bin/env bun
/**
 * Backfill seed tracks — ensures every active seed has a corresponding
 * entry in the tracks table and enriches it with Spotify/YouTube metadata.
 *
 * 1. Query all seeds where track_id is null
 * 2. For each, check if a matching track already exists (ilike artist + title)
 * 3. If not, create one with status "approved", source "seed"
 * 4. Update seeds.track_id
 * 5. Enrich the seed track (Spotify + YouTube)
 *
 * Usage: bun run backfill-seed-tracks [--dry-run]
 */
import { getSupabase } from "../lib/supabase";

const dryRun = Bun.argv.includes("--dry-run");
const db = getSupabase();

const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_API = "https://api.spotify.com/v1";
let cachedToken: string | null = null;
let tokenExpiry = 0;

const YT_DLP_BIN =
  process.env.YT_DLP_BIN ||
  Bun.which("yt-dlp") ||
  "/opt/homebrew/bin/yt-dlp";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function log(icon: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`  ${ts} ${icon} ${msg}`);
}

// ─── NORMALIZATION ────────────────────────────────────────────

const FEAT_RE = /\b(feat\.?|ft\.?|featuring)\b/i;

function stripFeaturing(s: string): string {
  let cleaned = s.replace(/\s*[\(\[](feat\.?|ft\.?|featuring)\s+[^\)\]]+[\)\]]/gi, "");
  cleaned = cleaned.replace(/\s*(feat\.?|ft\.?|featuring)\s+.*/gi, "");
  return cleaned.trim();
}

const YT_NOISE_RE = /\s*[\(\[](official\s*(video|audio|music\s*video)?|lyrics?|audio|video|mv|hd|hq|4k)[\)\]]/gi;

function normalizeForSearch(artist: string, title: string) {
  let cleanTitle = stripFeaturing(title).replace(YT_NOISE_RE, "").trim();
  let primaryArtist = stripFeaturing(artist).split(/,\s*/)[0].split(/\s*[&+x×]\s*/i)[0].trim();
  return { primaryArtist, cleanTitle, fullArtist: artist.trim() };
}

function stringSimilarity(a: string, b: string): number {
  const na = a.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const nb = b.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  if (na === nb) return 100;
  if (!na || !nb) return 0;
  const maxLen = Math.max(na.length, nb.length);
  if (na.includes(nb) || nb.includes(na)) {
    const minLen = Math.min(na.length, nb.length);
    if (minLen > 4) return Math.round(Math.max(60, (minLen / maxLen) * 100));
  }
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

// ─── SPOTIFY ──────────────────────────────────────────────────

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

type SpotifyTrackItem = {
  id: string; name: string; preview_url: string | null;
  external_urls: { spotify: string };
  artists: Array<{ id: string; name: string }>;
  album: { name: string; images: Array<{ url: string }> };
};

async function spotifyLookup(artist: string, title: string): Promise<{
  spotify_url: string | null; cover_art_url: string | null; spotify_id: string;
  artist_ids: string[]; album: string | null; spotify_confidence: number; preview_url: string | null;
} | null> {
  const token = await getSpotifyToken();
  const { primaryArtist, cleanTitle, fullArtist } = normalizeForSearch(artist, title);

  const strategies = [
    `track:${cleanTitle} artist:${primaryArtist}`,
    `${primaryArtist} ${cleanTitle}`,
    `${cleanTitle} ${primaryArtist}`,
  ];

  const seen = new Set<string>();
  const allCandidates: SpotifyTrackItem[] = [];

  for (const strategy of strategies) {
    if (allCandidates.length > 5) break;
    const q = encodeURIComponent(strategy);
    const res = await fetch(`${SPOTIFY_API}/search?q=${q}&type=track&limit=5`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 429) {
      const waitSec = parseInt(res.headers.get("Retry-After") || "5", 10);
      await sleep(waitSec * 1000);
      continue;
    }
    if (!res.ok) continue;
    const data = await res.json() as { tracks: { items: SpotifyTrackItem[] } };
    for (const item of data.tracks?.items || []) {
      if (!seen.has(item.id)) { seen.add(item.id); allCandidates.push(item); }
    }
    await sleep(100);
  }

  if (!allCandidates.length) return null;

  let bestMatch = allCandidates[0];
  let bestScore = -1;
  let bestArtistScore = 0;

  for (const item of allCandidates) {
    const candidateArtist = item.artists.map((a) => a.name).join(", ");
    const artistScore = Math.max(
      stringSimilarity(primaryArtist, item.artists[0]?.name || ""),
      stringSimilarity(fullArtist, candidateArtist),
    );
    const cleanedSpotifyTitle = stripFeaturing(item.name || "");
    const titleScore = Math.max(
      stringSimilarity(cleanTitle, item.name),
      stringSimilarity(cleanTitle, cleanedSpotifyTitle),
      stringSimilarity(title, item.name),
    );
    if (artistScore < 40) continue;
    const score = artistScore * 0.4 + titleScore * 0.6;
    if (score > bestScore) {
      bestScore = score;
      bestArtistScore = artistScore;
      bestMatch = item;
    }
  }

  const confidence = Math.round(bestScore);
  if (confidence < 65 || bestArtistScore < 50) return null;

  return {
    spotify_url: bestMatch.external_urls?.spotify || null,
    preview_url: bestMatch.preview_url || null,
    cover_art_url: bestMatch.album?.images?.[0]?.url || null,
    spotify_id: bestMatch.id,
    artist_ids: bestMatch.artists.map((a) => a.id).filter(Boolean),
    album: bestMatch.album?.name || null,
    spotify_confidence: confidence,
  };
}

async function spotifyArtistGenres(artistIds: string[]): Promise<string[]> {
  if (!artistIds.length) return [];
  try {
    const token = await getSpotifyToken();
    const ids = artistIds.slice(0, 50).join(",");
    const res = await fetch(`${SPOTIFY_API}/artists?ids=${ids}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return [];
    const data = await res.json() as { artists: Array<{ genres: string[] }> };
    const genres = new Set<string>();
    for (const a of data.artists || []) for (const g of a.genres || []) genres.add(g);
    return Array.from(genres);
  } catch {
    return [];
  }
}

// ─── YOUTUBE ──────────────────────────────────────────────────

async function youtubeLookup(artist: string, title: string): Promise<{ url: string; thumbnail: string | null } | null> {
  try {
    const { primaryArtist, cleanTitle } = normalizeForSearch(artist, title);
    const searchQuery = `${primaryArtist} ${cleanTitle}`;
    const proc = Bun.spawn(
      [YT_DLP_BIN, "--dump-json", "--no-download", "--flat-playlist", "--no-warnings", `ytsearch3:${searchQuery}`],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, , exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0 || !stdout.trim()) return null;
    const results = stdout.trim().split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const filtered = results.filter((r: any) => {
      const dur = r.duration || 0;
      const t = (r.title || "").toLowerCase();
      if (dur > 0 && (dur < 60 || dur > 900)) return false;
      if (t.includes("live at") || t.includes("live from")) return false;
      return true;
    });
    const chosen = filtered[0] || results[0];
    if (!chosen?.webpage_url) return null;
    let thumbnail: string | null = null;
    if (chosen.thumbnails?.length) thumbnail = chosen.thumbnails[chosen.thumbnails.length - 1]?.url || null;
    else if (chosen.thumbnail) thumbnail = chosen.thumbnail;
    return { url: chosen.webpage_url, thumbnail };
  } catch {
    return null;
  }
}

// ─── MAIN ────────────────────────────────────────────────────

async function main() {
  console.log(`\n━━━ BACKFILL SEED TRACKS ${dryRun ? "(DRY RUN)" : ""} ━━━\n`);

  // Fetch all seeds where track_id is null
  const { data: seeds, error: seedErr } = await db
    .from("seeds")
    .select("id, artist, title, track_id, active")
    .is("track_id", null);

  if (seedErr) {
    console.error("  Failed to fetch seeds:", seedErr.message);
    process.exit(1);
  }

  console.log(`  ${seeds?.length ?? 0} seeds missing track_id\n`);

  let created = 0;
  let linked = 0;
  let enriched = 0;
  let failed = 0;

  for (const seed of seeds || []) {
    const label = `${seed.artist} - ${seed.title}`;

    // Check if a matching track already exists
    const { data: existingTrack } = await db.from("tracks")
      .select("id, spotify_url, youtube_url")
      .ilike("artist", seed.artist)
      .ilike("title", seed.title)
      .limit(1)
      .maybeSingle();

    let trackId: string;

    if (existingTrack) {
      log("→", `Existing track found for: ${label}`);
      trackId = existingTrack.id;
      linked++;

      if (!dryRun) {
        await db.from("seeds").update({ track_id: trackId }).eq("id", seed.id);
      }
    } else {
      log("·", `Creating seed track: ${label}`);

      if (!dryRun) {
        const { data: newTrack, error: insertErr } = await db.from("tracks").insert({
          artist: seed.artist,
          title: seed.title,
          source: "seed",
          source_url: "",
          source_context: "Seed track",
          status: "approved",
          metadata: { is_seed: true },
        }).select("id, spotify_url, youtube_url").single();

        if (insertErr || !newTrack) {
          log("✗", `Failed to create track for: ${label} — ${insertErr?.message ?? "no data"}`);
          failed++;
          continue;
        }

        trackId = newTrack.id;
        await db.from("seeds").update({ track_id: trackId }).eq("id", seed.id);
        created++;
        log("✓", `Created: ${label} (id: ${trackId})`);
      } else {
        log("·", `  [dry-run] would create track for: ${label}`);
        continue;
      }
    }

    // Enrich the seed track if it lacks Spotify or YouTube
    const { data: track } = await db.from("tracks")
      .select("id, artist, title, spotify_url, youtube_url, cover_art_url, preview_url, metadata")
      .eq("id", trackId)
      .single();

    if (!track) continue;

    const updates: Record<string, unknown> = {};

    if (!track.spotify_url) {
      try {
        log("·", `  Spotify lookup: ${label}`);
        const spot = await spotifyLookup(track.artist, track.title);
        if (spot) {
          updates.spotify_url = spot.spotify_url;
          if (!track.preview_url && spot.preview_url) updates.preview_url = spot.preview_url;
          if (!track.cover_art_url && spot.cover_art_url && spot.spotify_confidence >= 75) {
            updates.cover_art_url = spot.cover_art_url;
          }
          const genres = await spotifyArtistGenres(spot.artist_ids);
          updates.metadata = {
            ...(track.metadata || {}),
            spotify_id: spot.spotify_id,
            album: spot.album,
            spotify_confidence: spot.spotify_confidence,
            is_seed: true,
            ...(genres.length > 0 ? { genres } : {}),
          };
          log("✓", `  Spotify: ${spot.spotify_url ? "found" : "no url"} (confidence: ${spot.spotify_confidence})`);
        } else {
          updates.spotify_url = "";
          log("→", `  Spotify: no match`);
        }
      } catch (err) {
        log("✗", `  Spotify error: ${err instanceof Error ? err.message : err}`);
        updates.spotify_url = "";
      }
      await sleep(200);
    }

    if (!track.youtube_url) {
      try {
        log("·", `  YouTube lookup: ${label}`);
        const yt = await youtubeLookup(track.artist, track.title);
        if (yt) {
          updates.youtube_url = yt.url;
          log("✓", `  YouTube: found`);
        } else {
          log("→", `  YouTube: no match`);
        }
      } catch (err) {
        log("✗", `  YouTube error: ${err instanceof Error ? err.message : err}`);
      }
    }

    if (Object.keys(updates).length > 0 && !dryRun) {
      const { error: updateErr } = await db.from("tracks").update(updates).eq("id", trackId);
      if (updateErr) {
        log("✗", `  Enrich update failed: ${updateErr.message}`);
      } else {
        enriched++;
      }
    }

    await sleep(500);
  }

  console.log(`\n  ── Summary ──`);
  console.log(`  Seeds processed:  ${(seeds || []).length}`);
  console.log(`  Tracks created:   ${created}`);
  console.log(`  Seeds linked:     ${linked}`);
  console.log(`  Tracks enriched:  ${enriched}`);
  console.log(`  Failures:         ${failed}`);
  if (dryRun) console.log(`\n  (DRY RUN — no changes written)`);
  console.log("");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
