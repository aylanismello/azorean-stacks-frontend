/**
 * Shared pipeline utilities — extracted from discover.ts and download.ts
 * so watcher.ts (and future consumers) can reuse them without duplication.
 */
import { getSupabase } from "./supabase";
import { Sentry } from "./sentry";

const db = getSupabase();
const YT_DLP_BIN =
  process.env.YT_DLP_BIN ||
  Bun.which("yt-dlp") ||
  "/opt/homebrew/bin/yt-dlp";

// ─── GENERAL UTILITIES ──────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout: ${label} after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!));
}

// ─── LOGGING ────────────────────────────────────────────────

export const LOG_ICONS = { ok: "✓", fail: "✗", skip: "→", warn: "⚠", wait: "…", info: "·" } as const;

export function log(icon: keyof typeof LOG_ICONS, msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`  ${ts} ${LOG_ICONS[icon]} ${msg}`);
}

export function elapsed(start: number): string {
  const s = (Date.now() - start) / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${(s / 60).toFixed(1)}m`;
}

// ─── SEARCH NORMALIZATION ───────────────────────────────────

export function stripFeaturing(s: string): string {
  let cleaned = s.replace(/\s*[\(\[](feat\.?|ft\.?|featuring)\s+[^\)\]]+[\)\]]/gi, "");
  cleaned = cleaned.replace(/\s*(feat\.?|ft\.?|featuring)\s+.*/gi, "");
  return cleaned.trim();
}

const YT_NOISE_RE = /\s*[\(\[](official\s*(video|audio|music\s*video|lyric\s*video|visuali[sz]er)?|lyrics?|audio|video|music\s*video|mv|hd|hq|4k|visuali[sz]er|remix|prod\.?\s+[^\)\]]*|out\s+now)[\)\]]/gi;

export function stripVideoNoise(s: string): string {
  return s.replace(YT_NOISE_RE, "").trim();
}

export function normalizeForSearch(artist: string, title: string) {
  let cleanTitle = stripFeaturing(title);
  cleanTitle = stripVideoNoise(cleanTitle);
  let primaryArtist = stripFeaturing(artist)
    .split(/,\s*/)[0]
    .split(/\s*[&+x×]\s*/i)[0]
    .trim();
  return { primaryArtist, cleanTitle, fullArtist: artist.trim() };
}

export function stringSimilarity(a: string, b: string): number {
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

// ─── TRACK HELPERS ──────────────────────────────────────────

export function isSameTrack(a: { artist: string; title: string }, b: { artist: string; title: string }): boolean {
  return a.artist.toLowerCase().trim() === b.artist.toLowerCase().trim() &&
    a.title.toLowerCase().trim() === b.title.toLowerCase().trim();
}

// ─── SPOTIFY ────────────────────────────────────────────────

const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_API = "https://api.spotify.com/v1";
let cachedToken: string | null = null;
let tokenExpiry = 0;

export async function getSpotifyToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiry - 60_000) return cachedToken;
  log("info", "Refreshing Spotify token");
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Missing SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET env vars");
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
  log("ok", `Spotify token refreshed (expires in ${data.expires_in}s)`);
  return cachedToken;
}

type SpotifyTrackItem = {
  id: string; name: string; preview_url: string | null;
  external_urls: { spotify: string };
  artists: Array<{ id: string; name: string }>;
  album: { name: string; images: Array<{ url: string }> };
};

// Exponential backoff base delays: 5s → 15s → 45s
const SPOTIFY_BACKOFF = [5, 15, 45];

async function spotifySearch(query: string, token: string, artist: string, title: string, retries = 0): Promise<SpotifyTrackItem[]> {
  await sleep(200); // rate-limit gap between sequential Spotify requests
  const q = encodeURIComponent(query);
  const res = await fetch(`${SPOTIFY_API}/search?q=${q}&type=track&limit=5`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 429) {
    if (retries >= 3) {
      log("fail", `Spotify rate-limited 3 times — giving up for "${query}"`);
      return [];
    }
    const retryAfter = parseInt(res.headers.get("Retry-After") || "0", 10);
    const backoff = SPOTIFY_BACKOFF[retries] || 45;
    const waitSec = Math.max(retryAfter, backoff);
    log("wait", `Spotify rate-limited — waiting ${waitSec}s (retry ${retries + 1}/3)`);
    await sleep(waitSec * 1000);
    return spotifySearch(query, token, artist, title, retries + 1);
  }
  if (!res.ok) return [];
  const data = await res.json() as { tracks: { items: SpotifyTrackItem[] } };
  return data.tracks?.items || [];
}

function scoreSpotifyCandidate(
  item: SpotifyTrackItem,
  primaryArtist: string,
  fullArtist: string,
  cleanTitle: string,
  originalTitle: string,
): { score: number; artistScore: number; titleScore: number } {
  const candidateArtist = item.artists.map((a) => a.name).join(", ");
  const trackName = item.name || "";
  const artistScore = Math.max(
    stringSimilarity(primaryArtist, item.artists[0]?.name || ""),
    stringSimilarity(fullArtist, candidateArtist),
  );
  const cleanedSpotifyTitle = stripFeaturing(trackName);
  const titleScore = Math.max(
    stringSimilarity(cleanTitle, trackName),
    stringSimilarity(cleanTitle, cleanedSpotifyTitle),
    stringSimilarity(originalTitle, trackName),
  );
  if (artistScore < 40) return { score: Math.min(artistScore, 30), artistScore, titleScore };
  return { score: artistScore * 0.4 + titleScore * 0.6, artistScore, titleScore };
}

export async function spotifyLookup(artist: string, title: string) {
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
    const items = await spotifySearch(strategy, token, artist, title);
    for (const item of items) {
      if (!seen.has(item.id)) { seen.add(item.id); allCandidates.push(item); }
    }
  }

  if (!allCandidates.length) return null;

  let bestMatch = allCandidates[0];
  let bestScore = -1;
  let bestArtistScore = 0;
  let bestTitleScore = 0;

  for (const item of allCandidates) {
    const { score, artistScore, titleScore } = scoreSpotifyCandidate(item, primaryArtist, fullArtist, cleanTitle, title);
    if (score > bestScore) {
      bestScore = score; bestArtistScore = artistScore; bestTitleScore = titleScore; bestMatch = item;
    }
  }

  const confidence = Math.round(bestScore);
  if (confidence < 65) {
    log("skip", `Spotify: score ${confidence} too low for ${artist} – ${title}`);
    return null;
  }
  if (bestArtistScore < 50) {
    log("skip", `Spotify: artist mismatch for ${artist} – ${title}`);
    return null;
  }

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

// ─── YOUTUBE ────────────────────────────────────────────────

export interface YouTubeResult {
  url: string;
  thumbnail: string | null;
  source: "youtube" | "soundcloud";
}

async function ytDlpSearch(
  searchPrefix: string,
  searchQuery: string,
  timeoutLabel: string,
): Promise<{ chosen: any } | null> {
  const proc = Bun.spawn(
    [YT_DLP_BIN, "--dump-json", "--no-download", "--flat-playlist", "--no-warnings",
     `${searchPrefix}:${searchQuery}`],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, _stderr, exitCode] = await Promise.all([
    withTimeout(new Response(proc.stdout).text(), 30_000, timeoutLabel),
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
  return { chosen };
}

function extractThumbnail(chosen: any): string | null {
  if (chosen.thumbnails?.length) {
    return chosen.thumbnails[chosen.thumbnails.length - 1]?.url || null;
  }
  return chosen.thumbnail || null;
}

export async function youtubeLookup(artist: string, title: string): Promise<YouTubeResult | null> {
  try {
    const { primaryArtist, cleanTitle } = normalizeForSearch(artist, title);
    const searchQuery = `${primaryArtist} ${cleanTitle}`;

    // Try YouTube first
    const ytResult = await ytDlpSearch("ytsearch3", searchQuery, "yt-search");
    if (ytResult) {
      return { url: ytResult.chosen.webpage_url, thumbnail: extractThumbnail(ytResult.chosen), source: "youtube" };
    }
    log("skip", `YouTube: no results for "${searchQuery}" — trying SoundCloud`);

    // Fallback: try SoundCloud
    const scResult = await ytDlpSearch("scsearch3", searchQuery, "sc-search");
    if (scResult) {
      log("ok", `SoundCloud: found match for "${searchQuery}"`);
      return { url: scResult.chosen.webpage_url, thumbnail: extractThumbnail(scResult.chosen), source: "soundcloud" };
    }

    return null;
  } catch (err) {
    log("fail", `YouTube lookup error: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

// ─── SPOTIFY ARTIST GENRES ──────────────────────────────────

export async function spotifyArtistGenres(artistIds: string[], retries = 0): Promise<string[]> {
  if (!artistIds.length) return [];
  try {
    await sleep(200); // rate-limit gap between sequential Spotify requests
    const token = await getSpotifyToken();
    const ids = artistIds.slice(0, 50).join(",");
    const res = await fetch(`${SPOTIFY_API}/artists?ids=${ids}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 429) {
      if (retries >= 3) {
        log("fail", "Spotify artist genres rate-limited 3 times — giving up");
        return [];
      }
      const retryAfter = parseInt(res.headers.get("Retry-After") || "0", 10);
      const backoff = SPOTIFY_BACKOFF[retries] || 45;
      const waitSec = Math.max(retryAfter, backoff);
      await sleep(waitSec * 1000);
      return spotifyArtistGenres(artistIds, retries + 1);
    }
    if (!res.ok) return [];
    const data = await res.json() as { artists: Array<{ genres: string[] }> };
    const genres = new Set<string>();
    for (const a of data.artists || []) for (const g of a.genres || []) genres.add(g);
    return Array.from(genres);
  } catch {
    return [];
  }
}

// ─── MUSICBRAINZ ────────────────────────────────────────────

const MB_API = "https://musicbrainz.org/ws/2";
const MB_USER_AGENT = "AzoreanStacks/1.0 (picoisazorean@gmail.com)";
let lastMbRequestAt = 0;
let mbQueuePromise: Promise<void> = Promise.resolve();

// Sequential queue for MusicBrainz — ensures 1 request per second globally
function withMbRateLimit<T>(fn: () => Promise<T>): Promise<T> {
  const ticket = mbQueuePromise.then(async () => {
    const now = Date.now();
    const elapsed = now - lastMbRequestAt;
    if (elapsed < 1100) await sleep(1100 - elapsed);
    lastMbRequestAt = Date.now();
  });
  mbQueuePromise = ticket.catch(() => {});
  return ticket.then(fn);
}

export interface MusicBrainzResult {
  artist: string;
  title: string;
  album?: string;
  release_date?: string;
  genres?: string[];
  isrc?: string;
  musicbrainz_id: string;
}

export async function musicbrainzLookup(artist: string, title: string): Promise<MusicBrainzResult | null> {
  // Rate limiting handled by withMbRateLimit() caller

  const { primaryArtist, cleanTitle } = normalizeForSearch(artist, title);
  const query = encodeURIComponent(`artist:"${primaryArtist}" AND recording:"${cleanTitle}"`);
  const url = `${MB_API}/recording?query=${query}&fmt=json&limit=3`;

  const res = await fetch(url, {
    headers: { "User-Agent": MB_USER_AGENT },
  });

  if (!res.ok) {
    log("fail", `MusicBrainz ${res.status} for ${artist} – ${title}`);
    return null;
  }

  const data = await res.json() as {
    recordings?: Array<{
      id: string;
      title: string;
      "artist-credit"?: Array<{ name: string }>;
      releases?: Array<{ title: string; date?: string }>;
      tags?: Array<{ name: string; count: number }>;
      isrcs?: string[];
    }>;
  };

  const recordings = data.recordings;
  if (!recordings?.length) return null;

  const rec = recordings[0];
  const mbArtist = rec["artist-credit"]?.map((a) => a.name).join(", ") || artist;
  const release = rec.releases?.[0];

  // Extract genres from tags (sorted by count)
  const genres = rec.tags
    ?.filter((t) => t.count > 0)
    .sort((a, b) => b.count - a.count)
    .map((t) => t.name)
    .slice(0, 5);

  return {
    artist: mbArtist,
    title: rec.title || title,
    album: release?.title,
    release_date: release?.date,
    genres: genres?.length ? genres : undefined,
    isrc: rec.isrcs?.[0],
    musicbrainz_id: rec.id,
  };
}

// ─── ENRICH ONE TRACK ───────────────────────────────────────

export async function enrichTrack(track: any): Promise<boolean> {
  const label = `${track.artist} – ${track.title}`;
  const t0 = Date.now();
  const updates: Record<string, unknown> = {};
  let spotFound = !!track.spotify_url;
  let ytFound = !!track.youtube_url;
  let ytSource: "youtube" | "soundcloud" = "youtube";

  // Run Spotify, YouTube, and MusicBrainz lookups in PARALLEL
  // Spotify has a 15s timeout, MusicBrainz 5s — neither blocks YouTube
  let mbResult: MusicBrainzResult | null = null;
  const [spotResult, ytResult, _mbResult] = await Promise.allSettled([
    // Spotify lookup (best-effort — rate limited, non-critical, 15s max)
    !track.spotify_url
      ? withTimeout(spotifyLookup(track.artist, track.title).then(async (spot) => {
          if (spot) {
            spotFound = true;
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
              ...(genres.length > 0 ? { genres } : {}),
            };
          } else {
            updates.spotify_url = "";
          }
        }), 5_000, `spotify:${label}`).catch((err) => {
          log("fail", `Spotify error for ${label}: ${err instanceof Error ? err.message : err}`);
          updates.spotify_url = "";
        })
      : Promise.resolve(),
    // YouTube lookup (primary — no auth, no rate limits)
    !track.youtube_url
      ? youtubeLookup(track.artist, track.title).then((yt) => {
          if (yt) {
            updates.youtube_url = yt.url;
            ytFound = true;
            ytSource = yt.source;
          }
        }).catch((err) => {
          log("fail", `YouTube error for ${label}: ${err instanceof Error ? err.message : err}`);
        })
      : Promise.resolve(),
    // MusicBrainz lookup (fallback metadata — 5s timeout, 1req/s rate limited)
    !track.metadata?.musicbrainz_id
      ? withTimeout(withMbRateLimit(() => musicbrainzLookup(track.artist, track.title)), 10_000, `mb:${label}`).then((mb) => {
          mbResult = mb;
        }).catch((err) => {
          log("fail", `MusicBrainz error for ${label}: ${err instanceof Error ? err.message : err}`);
        })
      : Promise.resolve(),
  ]);

  // Merge MusicBrainz data into metadata
  if (mbResult) {
    const mb = mbResult as MusicBrainzResult;
    const existingMeta = (updates.metadata || track.metadata || {}) as Record<string, unknown>;
    updates.metadata = {
      ...existingMeta,
      musicbrainz_id: mb.musicbrainz_id,
      ...(mb.album ? { mb_album: mb.album } : {}),
      ...(mb.release_date ? { mb_release_date: mb.release_date } : {}),
      ...(mb.genres?.length ? { mb_genres: mb.genres } : {}),
      ...(mb.isrc ? { isrc: mb.isrc } : {}),
      // Use MB genres as fallback when Spotify has none
      ...(!existingMeta.genres && mb.genres?.length ? { genres: mb.genres } : {}),
    };
    log("ok", `MusicBrainz: found ${mb.musicbrainz_id} for ${label}`);
  }

  // Artwork fallback: use NTS episode artwork
  if (!track.cover_art_url && !updates.cover_art_url && track.episode_id) {
    const { data: ep } = await db.from("episodes")
      .select("artwork_url").eq("id", track.episode_id).single();
    if (ep?.artwork_url) {
      updates.cover_art_url = ep.artwork_url;
      log("info", `Using episode artwork as cover art for ${label}`);
    }
  }

  // Track enrichment sources — which services provided metadata
  const sources: string[] = [];
  if (spotFound) sources.push("spotify");
  if (ytFound) sources.push(ytSource);
  if (mbResult) sources.push("musicbrainz");
  const existingMeta = (updates.metadata || track.metadata || {}) as Record<string, unknown>;
  updates.metadata = { ...existingMeta, enrichment_sources: sources, enriched_at: new Date().toISOString() };

  const { error } = await db.from("tracks").update(updates).eq("id", track.id);
  if (error) {
    log("fail", `DB update failed for ${label}: ${error.message}`);
    Sentry.captureException(new Error(`DB update failed: ${error.message}`), {
      tags: { component: "pipeline", action: "enrich" },
      extra: { track_id: track.id, artist: track.artist, title: track.title },
    });
    return false;
  }

  const sp = spotFound ? "spotify" : "no-spotify";
  const yt = ytFound ? "youtube" : "no-youtube";
  const mb = mbResult ? "musicbrainz" : "no-mb";
  log(spotFound || ytFound ? "ok" : "skip", `${label} [${sp}, ${yt}, ${mb}] (${elapsed(t0)})`);
  return true;
}

// ─── FAST ENRICH (YouTube only) ─────────────────────────────

export async function enrichTrackFast(track: any): Promise<boolean> {
  const label = `${track.artist} – ${track.title}`;
  const t0 = Date.now();
  const updates: Record<string, unknown> = {};
  let ytFound = !!track.youtube_url;
  let ytSource: "youtube" | "soundcloud" = "youtube";

  // Only do YouTube + SoundCloud lookup — no Spotify, no MusicBrainz
  if (!track.youtube_url) {
    try {
      const yt = await youtubeLookup(track.artist, track.title);
      if (yt) {
        updates.youtube_url = yt.url;
        ytFound = true;
        ytSource = yt.source;
      }
    } catch (err) {
      log("fail", `YouTube error for ${label}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // If nothing found, mark as searched so we don't retry
  if (!ytFound) {
    updates.youtube_url = "";
    updates.spotify_url = "";
  }

  // Track enrichment sources
  const sources: string[] = ytFound ? [ytSource] : [];
  const existingMeta = (track.metadata || {}) as Record<string, unknown>;
  updates.metadata = { ...existingMeta, enrichment_sources: sources, enriched_at: new Date().toISOString() };

  const { error } = await db.from("tracks").update(updates).eq("id", track.id);
  if (error) {
    log("fail", `DB update failed for ${label}: ${error.message}`);
    Sentry.captureException(new Error(`DB update failed: ${error.message}`), {
      tags: { component: "pipeline", action: "enrich_fast" },
      extra: { track_id: track.id, artist: track.artist, title: track.title },
    });
    return false;
  }

  log(ytFound ? "ok" : "skip", `[Fast] ${label} [${ytFound ? ytSource : "no-youtube"}] (${elapsed(t0)})`);
  return true;
}

// ─── SLOW METADATA BACKFILL ─────────────────────────────────

export async function enrichTrackMetadata(track: any): Promise<boolean> {
  const label = `${track.artist} – ${track.title}`;
  const t0 = Date.now();
  const updates: Record<string, unknown> = {};
  let spotFound = !!track.spotify_url;
  let mbResult: MusicBrainzResult | null = null;

  // Run Spotify and MusicBrainz in parallel
  await Promise.allSettled([
    // Spotify lookup (5s timeout)
    !track.spotify_url
      ? withTimeout(spotifyLookup(track.artist, track.title).then(async (spot) => {
          if (spot) {
            spotFound = true;
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
              ...(genres.length > 0 ? { genres } : {}),
            };
          } else {
            updates.spotify_url = "";
          }
        }), 5_000, `spotify:${label}`).catch((err) => {
          log("fail", `Spotify error for ${label}: ${err instanceof Error ? err.message : err}`);
          updates.spotify_url = "";
        })
      : Promise.resolve(),
    // MusicBrainz lookup (rate limited)
    !track.metadata?.musicbrainz_id
      ? withTimeout(withMbRateLimit(() => musicbrainzLookup(track.artist, track.title)), 10_000, `mb:${label}`).then((mb) => {
          mbResult = mb;
        }).catch((err) => {
          log("fail", `MusicBrainz error for ${label}: ${err instanceof Error ? err.message : err}`);
        })
      : Promise.resolve(),
  ]);

  // Merge MusicBrainz data
  if (mbResult) {
    const mb = mbResult as MusicBrainzResult;
    const metaBase = (updates.metadata || track.metadata || {}) as Record<string, unknown>;
    updates.metadata = {
      ...metaBase,
      musicbrainz_id: mb.musicbrainz_id,
      ...(mb.album ? { mb_album: mb.album } : {}),
      ...(mb.release_date ? { mb_release_date: mb.release_date } : {}),
      ...(mb.genres?.length ? { mb_genres: mb.genres } : {}),
      ...(mb.isrc ? { isrc: mb.isrc } : {}),
      ...(!metaBase.genres && mb.genres?.length ? { genres: mb.genres } : {}),
    };
    log("ok", `MusicBrainz: found ${mb.musicbrainz_id} for ${label}`);
  }

  // Artwork fallback: use NTS episode artwork
  if (!track.cover_art_url && !updates.cover_art_url && track.episode_id) {
    const { data: ep } = await db.from("episodes")
      .select("artwork_url").eq("id", track.episode_id).single();
    if (ep?.artwork_url) {
      updates.cover_art_url = ep.artwork_url;
      log("info", `Using episode artwork as cover art for ${label}`);
    }
  }

  // Append to existing enrichment sources
  const finalMeta = (updates.metadata || track.metadata || {}) as Record<string, unknown>;
  const existingSources: string[] = (finalMeta.enrichment_sources as string[]) || [];
  const newSources = [...existingSources];
  if (spotFound && !newSources.includes("spotify")) newSources.push("spotify");
  if (mbResult && !newSources.includes("musicbrainz")) newSources.push("musicbrainz");
  updates.metadata = { ...finalMeta, enrichment_sources: newSources, enriched_at: new Date().toISOString() };

  const { error } = await db.from("tracks").update(updates).eq("id", track.id);
  if (error) {
    log("fail", `DB update failed for ${label}: ${error.message}`);
    Sentry.captureException(new Error(`DB update failed: ${error.message}`), {
      tags: { component: "pipeline", action: "enrich_metadata" },
      extra: { track_id: track.id, artist: track.artist, title: track.title },
    });
    return false;
  }

  const sp = spotFound ? "spotify" : "no-spotify";
  const mb = mbResult ? "musicbrainz" : "no-mb";
  log("ok", `[Metadata] ${label} [${sp}, ${mb}] (${elapsed(t0)})`);
  return true;
}

// ─── DOWNLOAD ONE TRACK ────────────────────────────────────

import { existsSync, mkdirSync, readFileSync, unlinkSync, readdirSync } from "fs";

const TMP_DIR = "/tmp/stacks";
const DL_TIMEOUT = 45_000;

function sanitize(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s\-.,()&+]/g, "").replace(/\s+/g, " ").trim().slice(0, 100) || "unknown";
}

export async function downloadTrack(track: any): Promise<boolean> {
  if (!track.youtube_url) return false;
  if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });

  const videoId = `dl-${track.id.slice(0, 8)}`;
  const outPath = `${TMP_DIR}/${videoId}.%(ext)s`;
  const expectedPath = `${TMP_DIR}/${videoId}.mp3`;

  const dlProc = Bun.spawn(
    [YT_DLP_BIN, "-x", "--audio-format", "mp3", "--audio-quality", "0",
     "--no-playlist", "--no-warnings",
     "--retries", "3", "--fragment-retries", "3",
     "--socket-timeout", "30", "--extractor-retries", "3",
     "-o", outPath, track.youtube_url],
    { stdout: "ignore", stderr: "ignore" },
  );

  const exitCode = await withTimeout(dlProc.exited, DL_TIMEOUT, `${track.artist} - ${track.title}`);
  if (exitCode !== 0) {
    await db.from("tracks").update({
      dl_attempts: (track.dl_attempts || 0) + 1,
      dl_failed_at: new Date().toISOString(),
    }).eq("id", track.id);
    return false;
  }

  let localPath = expectedPath;
  if (!existsSync(localPath)) {
    const f = readdirSync(TMP_DIR).find((f) => f.startsWith(videoId));
    if (f) localPath = `${TMP_DIR}/${f}`;
    else {
      await db.from("tracks").update({
        dl_attempts: (track.dl_attempts || 0) + 1,
        dl_failed_at: new Date().toISOString(),
      }).eq("id", track.id);
      return false;
    }
  }

  const storagePath = `${sanitize(track.artist)}/${sanitize(track.title)}.mp3`;
  const { error } = await db.storage.from("tracks").upload(storagePath, readFileSync(localPath), {
    contentType: "audio/mpeg", upsert: true,
  });
  if (error) {
    Sentry.captureException(new Error(`Storage upload failed: ${error.message}`), {
      tags: { component: "pipeline", action: "download" },
      extra: { track_id: track.id, artist: track.artist, title: track.title, storage_path: storagePath },
    });
    await db.from("tracks").update({
      dl_attempts: (track.dl_attempts || 0) + 1,
      dl_failed_at: new Date().toISOString(),
    }).eq("id", track.id);
    return false;
  }

  const { data: signed } = await db.storage.from("tracks").createSignedUrl(storagePath, 7 * 24 * 3600);
  await db.from("tracks").update({
    storage_path: storagePath,
    download_url: signed?.signedUrl || "",
    downloaded_at: new Date().toISOString(),
    dl_attempts: 0,
    dl_failed_at: null,
  }).eq("id", track.id);

  try { unlinkSync(localPath); } catch {}
  return true;
}

// ─── ENGINE EVENTS ──────────────────────────────────────────

export type EngineEventType =
  | "seed_detected"
  | "discover_started"
  | "discover_completed"
  | "enrich_started"
  | "enrich_completed"
  | "repair_started"
  | "repair_completed"
  | "super_like_detected"
  | "super_like_completed"
  | "error"
  | "watcher_connected"
  | "watcher_disconnected"
  | "watcher_reconnect"
  | "radar_curator_run"
  | "download_drain_started"
  | "download_drain_completed";

export async function logEngineEvent(
  eventType: EngineEventType,
  status: "started" | "completed" | "failed" | "info",
  opts: { seedId?: string; message?: string; metadata?: Record<string, unknown> } = {},
): Promise<void> {
  try {
    await db.from("engine_events").insert({
      event_type: eventType,
      seed_id: opts.seedId || null,
      status,
      message: opts.message || null,
      metadata: opts.metadata || {},
    });
  } catch (err) {
    // Don't crash on event logging failures
    console.error(`[engine_events] Failed to log ${eventType}: ${err instanceof Error ? err.message : err}`);
  }
}
