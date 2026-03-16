#!/usr/bin/env bun
/**
 * Enrichment Accuracy Audit
 *
 * Scores tracks on Spotify match, YouTube match, and artwork validity.
 * Persists audit data to Supabase `track_audits`.
 *
 * Usage:
 *   bun run audit                   # audit all enriched tracks
 *   bun run audit --days 7          # only tracks from last 7 days
 *   bun run audit --sample 100      # random sample of 100 tracks
 *   bun run audit --fix             # clear artwork + spotify + youtube for bad matches
 */
import { parseArgs } from "util";
import { getSupabase } from "../lib/supabase";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    days: { type: "string" },
    sample: { type: "string" },
    fix: { type: "boolean", default: false },
  },
  strict: false,
});

const filterDays = values.days ? parseInt(String(values.days), 10) : null;
const sampleSize = values.sample ? parseInt(String(values.sample), 10) : null;
const fixMode = values.fix || false;

const db = getSupabase();
const BATCH_SIZE = 50;
const BATCH_DELAY_MS = 2000;
const REQUEST_DELAY_MS = 200;

// ─── LOGGING ────────────────────────────────────────────────

const LOG_ICONS = { ok: "✓", fail: "✗", skip: "→", warn: "⚠", wait: "…", info: "·" } as const;

function log(icon: keyof typeof LOG_ICONS, msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`  ${ts} ${LOG_ICONS[icon]} ${msg}`);
}

function elapsed(start: number): string {
  const s = (Date.now() - start) / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${(s / 60).toFixed(1)}m`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── STRING SIMILARITY ─────────────────────────────────────

const NOISE_WORDS = [
  "official video", "official audio", "official music video",
  "official lyric video", "lyric video", "lyrics", "official",
  "audio", "video", "hd", "hq", "4k", "visualizer", "visualiser",
  "feat.", "feat", "ft.", "ft", "music video", "mv",
  "(official)", "[official]", "(lyrics)", "[lyrics]",
];

function normalize(s: string): string {
  let cleaned = s.toLowerCase().trim();
  for (const noise of NOISE_WORDS) {
    cleaned = cleaned.replaceAll(noise, "");
  }
  // collapse whitespace, strip parens/brackets with short content
  cleaned = cleaned.replace(/[\(\[\{][^)\]\}]{0,20}[\)\]\}]/g, "");
  cleaned = cleaned.replace(/[^a-z0-9\s]/g, " ");
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  return cleaned;
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  // Use single-row optimization
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);

  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function similarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 100;
  if (!na || !nb) return 0;
  const maxLen = Math.max(na.length, nb.length);
  const dist = levenshtein(na, nb);
  return Math.round(Math.max(0, (1 - dist / maxLen) * 100));
}

// ─── SPOTIFY AUTH ───────────────────────────────────────────

const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_API = "https://api.spotify.com/v1";
let cachedToken: string | null = null;
let tokenExpiry = 0;

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

// ─── SCORING FUNCTIONS ─────────────────────────────────────

interface SpotifyDetails {
  has_url: boolean;
  spotify_artist?: string;
  spotify_title?: string;
  artist_similarity?: number;
  title_similarity?: number;
  combined_similarity?: number;
  error?: string;
}

async function scoreSpotify(
  track: { artist: string; title: string; spotify_url: string | null }
): Promise<{ score: number; details: SpotifyDetails }> {
  if (!track.spotify_url || track.spotify_url === "") {
    return { score: 0, details: { has_url: false } };
  }

  // Extract Spotify track ID from URL
  const match = track.spotify_url.match(/track\/([a-zA-Z0-9]+)/);
  if (!match) {
    return { score: 0, details: { has_url: true, error: "invalid_url_format" } };
  }

  try {
    const token = await getSpotifyToken();
    const res = await fetch(`${SPOTIFY_API}/tracks/${match[1]}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.status === 429) {
      const wait = parseInt(res.headers.get("Retry-After") || "5", 10);
      log("wait", `Spotify rate-limited — waiting ${wait}s`);
      await sleep(wait * 1000);
      return scoreSpotify(track);
    }

    if (!res.ok) {
      return { score: 0, details: { has_url: true, error: `http_${res.status}` } };
    }

    const data = (await res.json()) as {
      name: string;
      artists: Array<{ name: string }>;
    };

    const spotifyArtist = data.artists.map((a) => a.name).join(", ");
    const spotifyTitle = data.name;

    const artistSim = similarity(track.artist, spotifyArtist);
    const titleSim = similarity(track.title, spotifyTitle);
    // Weighted: title match matters more
    const combined = Math.round(artistSim * 0.4 + titleSim * 0.6);

    return {
      score: combined,
      details: {
        has_url: true,
        spotify_artist: spotifyArtist,
        spotify_title: spotifyTitle,
        artist_similarity: artistSim,
        title_similarity: titleSim,
        combined_similarity: combined,
      },
    };
  } catch (err) {
    return {
      score: 0,
      details: { has_url: true, error: err instanceof Error ? err.message : String(err) },
    };
  }
}

interface YouTubeDetails {
  has_url: boolean;
  page_title?: string;
  similarity?: number;
  error?: string;
}

async function scoreYouTube(
  track: { artist: string; title: string; youtube_url: string | null }
): Promise<{ score: number; details: YouTubeDetails }> {
  if (!track.youtube_url || track.youtube_url === "") {
    return { score: 0, details: { has_url: false } };
  }

  try {
    const res = await fetch(track.youtube_url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; AzoreanAudit/1.0)" },
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      return { score: 0, details: { has_url: true, error: `http_${res.status}` } };
    }

    const html = await res.text();
    const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
    if (!titleMatch) {
      return { score: 0, details: { has_url: true, error: "no_title_tag" } };
    }

    // YouTube titles are usually "Video Title - YouTube"
    let pageTitle = titleMatch[1].replace(/\s*-\s*YouTube\s*$/i, "").trim();
    // Decode HTML entities
    pageTitle = pageTitle
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"');

    const expectedStr = `${track.artist} ${track.title}`;
    const sim = similarity(expectedStr, pageTitle);

    return {
      score: sim,
      details: { has_url: true, page_title: pageTitle, similarity: sim },
    };
  } catch (err) {
    return {
      score: 0,
      details: { has_url: true, error: err instanceof Error ? err.message : String(err) },
    };
  }
}

interface ArtworkDetails {
  has_url: boolean;
  status_code?: number;
  content_type?: string;
  is_placeholder?: boolean;
  error?: string;
}

const PLACEHOLDER_PATTERNS = [
  "default_album",
  "default_artist",
  "placeholder",
  "noimage",
  "no-image",
  "2a96cbd8b46e442fc41c2b86b821562f", // Spotify default artist image hash
];

async function scoreArtwork(
  track: { cover_art_url: string | null; metadata?: { spotify_confidence?: number } | null; spotify_url?: string | null }
): Promise<{ score: number; details: ArtworkDetails }> {
  const url = track.cover_art_url;
  if (!url || url === "") {
    return { score: 0, details: { has_url: false } };
  }

  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    });

    const contentType = res.headers.get("content-type") || "";
    const isImage = contentType.startsWith("image/");
    const isPlaceholder = PLACEHOLDER_PATTERNS.some((p) => url.toLowerCase().includes(p));

    if (!res.ok) {
      return {
        score: 0,
        details: { has_url: true, status_code: res.status, content_type: contentType },
      };
    }

    if (!isImage) {
      return {
        score: 0,
        details: { has_url: true, status_code: res.status, content_type: contentType, error: "not_image" },
      };
    }

    if (isPlaceholder) {
      return {
        score: 25,
        details: { has_url: true, status_code: res.status, content_type: contentType, is_placeholder: true },
      };
    }

    // If artwork comes from a Spotify match, factor in the match confidence.
    // A low Spotify confidence means the artwork is likely from the wrong track.
    const isSpotifyArt = url.includes("i.scdn.co") || url.includes("spotify");
    const spotifyConf = track.metadata?.spotify_confidence ?? null;

    if (isSpotifyArt && spotifyConf !== null && spotifyConf < 60) {
      // Low-confidence Spotify match — artwork is probably wrong
      const penalizedScore = Math.round(spotifyConf * 0.75); // e.g. conf 40 → score 30
      return {
        score: penalizedScore,
        details: {
          has_url: true, status_code: res.status, content_type: contentType,
          is_placeholder: false, error: `low_spotify_confidence_${spotifyConf}`,
        },
      };
    }

    return {
      score: 100,
      details: { has_url: true, status_code: res.status, content_type: contentType, is_placeholder: false },
    };
  } catch (err) {
    return {
      score: 0,
      details: { has_url: true, error: err instanceof Error ? err.message : String(err) },
    };
  }
}

// ─── MAIN ───────────────────────────────────────────────────

async function fetchTracks(): Promise<any[]> {
  let query = db
    .from("tracks")
    .select("id, artist, title, spotify_url, youtube_url, cover_art_url, metadata, created_at")
    .order("created_at", { ascending: false });

  if (filterDays) {
    const since = new Date(Date.now() - filterDays * 86_400_000).toISOString();
    query = query.gte("created_at", since);
  }

  if (sampleSize) {
    query = query.limit(sampleSize);
  }

  const { data, error } = await query;
  if (error) throw new Error(`Failed to fetch tracks: ${error.message}`);
  return data || [];
}

interface AuditResult {
  track_id: string;
  spotify_score: number;
  youtube_score: number;
  artwork_score: number;
  overall_score: number;
  spotify_details: SpotifyDetails;
  youtube_details: YouTubeDetails;
  artwork_details: ArtworkDetails;
}

async function auditTrack(track: any): Promise<AuditResult> {
  const [spotify, youtube, artwork] = await Promise.all([
    scoreSpotify(track),
    scoreYouTube(track),
    scoreArtwork(track),
  ]);

  const overall = Math.round(
    spotify.score * 0.4 + youtube.score * 0.3 + artwork.score * 0.3
  );

  return {
    track_id: track.id,
    spotify_score: spotify.score,
    youtube_score: youtube.score,
    artwork_score: artwork.score,
    overall_score: overall,
    spotify_details: spotify.details,
    youtube_details: youtube.details,
    artwork_details: artwork.details,
  };
}

function classifyScore(score: number): "excellent" | "good" | "fair" | "poor" {
  if (score >= 80) return "excellent";
  if (score >= 60) return "good";
  if (score >= 40) return "fair";
  return "poor";
}

function summarizeResults(results: AuditResult[]) {
  const avgSpotify = Math.round(results.reduce((s, r) => s + r.spotify_score, 0) / results.length);
  const avgYouTube = Math.round(results.reduce((s, r) => s + r.youtube_score, 0) / results.length);
  const avgArtwork = Math.round(results.reduce((s, r) => s + r.artwork_score, 0) / results.length);
  const avgOverall = Math.round(results.reduce((s, r) => s + r.overall_score, 0) / results.length);

  const distribution = { excellent: 0, good: 0, fair: 0, poor: 0 };
  for (const r of results) {
    distribution[classifyScore(r.overall_score)]++;
  }

  return {
    last_audit_at: new Date().toISOString(),
    tracks_audited: results.length,
    avg_spotify_score: avgSpotify,
    avg_youtube_score: avgYouTube,
    avg_artwork_score: avgArtwork,
    avg_overall_score: avgOverall,
    score_distribution: distribution,
  };
}

async function main() {
  const start = Date.now();
  const auditedAt = new Date().toISOString();
  console.log(`\n  The Stacks — Enrichment Audit`);
  console.log(`  ${new Date().toISOString()}`);

  const filters: string[] = [];
  if (filterDays) filters.push(`last ${filterDays} days`);
  if (sampleSize) filters.push(`sample of ${sampleSize}`);
  if (fixMode) filters.push("FIX MODE — will clear bad artwork");
  console.log(`  Filter: ${filters.length ? filters.join(", ") : "all tracks"}\n`);

  // Fetch tracks
  const tracks = await fetchTracks();
  if (tracks.length === 0) {
    log("warn", "No tracks to audit");
    return;
  }
  log("info", `${tracks.length} tracks to audit`);

  // Process in batches
  const results: AuditResult[] = [];
  const totalBatches = Math.ceil(tracks.length / BATCH_SIZE);

  for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
    const batch = tracks.slice(batchIdx * BATCH_SIZE, (batchIdx + 1) * BATCH_SIZE);
    console.log(`\n  ── Batch ${batchIdx + 1}/${totalBatches} (${batch.length} tracks) ──`);

    for (const track of batch) {
      const label = `${track.artist} – ${track.title}`;
      try {
        const result = await auditTrack(track);
        results.push(result);

        const icon = result.overall_score >= 60 ? "ok" : result.overall_score >= 40 ? "warn" : "fail";
        log(icon, `${label} → S:${result.spotify_score} Y:${result.youtube_score} A:${result.artwork_score} = ${result.overall_score}`);

        // In fix mode, clear bad data so re-enrichment can try again with stricter matching
        if (fixMode) {
          const updates: Record<string, unknown> = {};
          const reasons: string[] = [];

          // Clear bad Spotify matches (threshold raised to 65 to match new enrichment logic)
          if (result.spotify_score < 65 && track.spotify_url) {
            updates.spotify_url = null;
            reasons.push(`spotify:${result.spotify_score}`);

            // Also clear cover art if it came from Spotify (wrong match = wrong art)
            if (track.cover_art_url?.includes("i.scdn.co")) {
              updates.cover_art_url = null;
              reasons.push("spotify-art");
            }

            // Clear metadata fields that came from the wrong Spotify match
            const meta = { ...(track.metadata || {}) };
            delete meta.spotify_id;
            delete meta.spotify_confidence;
            delete meta.album;
            delete meta.genres;
            updates.metadata = meta;
          }

          // Clear bad YouTube matches
          if (result.youtube_score < 40 && track.youtube_url) {
            updates.youtube_url = null;
            reasons.push(`youtube:${result.youtube_score}`);
          }

          if (Object.keys(updates).length > 0) {
            const { error: fixErr } = await db.from("tracks")
              .update(updates)
              .eq("id", track.id);
            if (fixErr) {
              log("fail", `Fix failed for ${label}: ${fixErr.message}`);
            } else {
              log("info", `Cleared ${reasons.join(", ")} for ${label}`);
            }
          }
        }
      } catch (err) {
        log("fail", `${label} — ${err instanceof Error ? err.message : err}`);
      }

      await sleep(REQUEST_DELAY_MS);
    }

    // Write batch results to Supabase
    const rows = results.slice(batchIdx * BATCH_SIZE).map((r) => ({
      track_id: r.track_id,
      audited_at: auditedAt,
      spotify_score: r.spotify_score,
      youtube_score: r.youtube_score,
      artwork_score: r.artwork_score,
      overall_score: r.overall_score,
      spotify_details: r.spotify_details,
      youtube_details: r.youtube_details,
      artwork_details: r.artwork_details,
    }));

    const { error } = await db.from("track_audits").insert(rows);
    if (error) {
      log("fail", `DB insert error for batch ${batchIdx + 1}: ${error.message}`);
    } else {
      log("ok", `Batch ${batchIdx + 1} saved to track_audits`);
    }

    // Pause between batches (except last)
    if (batchIdx < totalBatches - 1) {
      log("wait", `Pausing ${BATCH_DELAY_MS / 1000}s before next batch...`);
      await sleep(BATCH_DELAY_MS);
    }
  }

  // In fix mode, also clean up garbage tracks
  if (fixMode) {
    console.log(`\n  ── Garbage Track Cleanup ──`);
    const GARBAGE_TITLES = ["unknown track", "untitled", "id", "?", "unknown"];

    for (const garbageTitle of GARBAGE_TITLES) {
      const { data: garbageTracks } = await db.from("tracks")
        .select("id, artist, title")
        .ilike("title", garbageTitle);

      if (garbageTracks && garbageTracks.length > 0) {
        for (const gt of garbageTracks) {
          // Delete FK references first
          await db.from("track_audits").delete().eq("track_id", gt.id);
          await db.from("user_tracks").delete().eq("track_id", gt.id);
          await db.from("episode_tracks").delete().eq("track_id", gt.id);
          const { error: delErr } = await db.from("tracks").delete().eq("id", gt.id);
          if (delErr) {
            log("fail", `Could not delete garbage track: ${gt.artist} – ${gt.title}: ${delErr.message}`);
          } else {
            log("ok", `Deleted garbage track: ${gt.artist} – ${gt.title}`);
          }
        }
      }
    }

    // Also clean tracks with single-char artist or title
    const { data: shortTracks } = await db.from("tracks")
      .select("id, artist, title")
      .or("artist.lte.1,title.lte.1");

    // Manual filter since Supabase doesn't have string length filters
    if (shortTracks) {
      const toDelete = shortTracks.filter(
        (t: any) => t.artist.trim().length <= 1 || t.title.trim().length <= 1
      );
      for (const st of toDelete) {
        await db.from("track_audits").delete().eq("track_id", st.id);
        await db.from("user_tracks").delete().eq("track_id", st.id);
        await db.from("episode_tracks").delete().eq("track_id", st.id);
        const { error: delErr } = await db.from("tracks").delete().eq("id", st.id);
        if (delErr) {
          log("fail", `Could not delete short track: ${st.artist} – ${st.title}: ${delErr.message}`);
        } else {
          log("ok", `Deleted short track: ${st.artist} – ${st.title}`);
        }
      }
    }
  }

  // Write summary
  console.log(`\n  ── Summary ──`);
  const summary = summarizeResults(results);

  console.log(`  Tracks audited:  ${summary.tracks_audited}`);
  console.log(`  Avg Spotify:     ${summary.avg_spotify_score}`);
  console.log(`  Avg YouTube:     ${summary.avg_youtube_score}`);
  console.log(`  Avg Artwork:     ${summary.avg_artwork_score}`);
  console.log(`  Avg Overall:     ${summary.avg_overall_score}`);
  console.log(`  Distribution:    excellent=${summary.score_distribution.excellent} good=${summary.score_distribution.good} fair=${summary.score_distribution.fair} poor=${summary.score_distribution.poor}`);
  console.log(`\n  Done (${elapsed(start)})\n`);
}

main().catch((err) => {
  console.error("\n  !! Audit crashed !!");
  console.error(`  ${err instanceof Error ? err.stack || err.message : err}`);
  process.exit(1);
});
