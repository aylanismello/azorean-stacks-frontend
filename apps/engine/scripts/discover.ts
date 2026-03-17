#!/usr/bin/env bun
/**
 * The Stacks — Discover + Enrich
 *
 * Searches NTS Radio for episodes containing seed tracks,
 * pulls co-occurring tracks as candidates, then enriches
 * them with Spotify and YouTube metadata.
 *
 * Does NOT download audio — run download.ts for that.
 *
 * Usage: bun run discover [--skip-discover] [--limit 50] [--duration 60]
 */
import { parseArgs } from "util";
import { getSupabase } from "../lib/supabase";
import { SOURCES } from "../lib/sources/index";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    limit: { type: "string", default: "50" },
    "skip-discover": { type: "boolean", default: false },
    duration: { type: "string" },
  },
  strict: false,
});

const candidateLimit = parseInt(String(values.limit || "50"), 10);
const skipDiscover = values["skip-discover"] || false;
const durationMinutes = values.duration ? parseInt(String(values.duration), 10) : null;
const deadline = durationMinutes ? Date.now() + durationMinutes * 60_000 : null;

const db = getSupabase();
const ENRICH_CONCURRENCY = 5;
const ENRICH_MAX_RETRIES = 3;
const YT_DLP_BIN =
  process.env.YT_DLP_BIN ||
  Bun.which("yt-dlp") ||
  "/opt/homebrew/bin/yt-dlp";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout: ${label} after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!));
}

// ─── LOGGING ────────────────────────────────────────────────

const LOG_ICONS = { ok: "✓", fail: "✗", skip: "→", warn: "⚠", wait: "…", info: "·" } as const;

function log(icon: keyof typeof LOG_ICONS, msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`  ${ts} ${LOG_ICONS[icon]} ${msg}`);
}

function elapsed(start: number): string {
  const s = ((Date.now() - start) / 1000);
  return s < 60 ? `${s.toFixed(1)}s` : `${(s / 60).toFixed(1)}m`;
}

// ─── SEARCH NORMALIZATION ────────────────────────────────────

// Regex matching all common "feat" variations (case-insensitive)
const FEAT_RE = /\b(feat\.?|ft\.?|featuring|Feat\.?|Ft\.?|FEAT\.?|FT\.?|FEATURING)\b/i;

function stripFeaturing(s: string): string {
  // Remove parenthesized/bracketed featuring: "Track (feat. Someone)"
  let cleaned = s.replace(/\s*[\(\[](feat\.?|ft\.?|featuring)\s+[^\)\]]+[\)\]]/gi, "");
  // Remove inline featuring: "Track feat. Someone" — strips from feat onward
  cleaned = cleaned.replace(/\s*(feat\.?|ft\.?|featuring)\s+.*/gi, "");
  return cleaned.trim();
}

// Strip YouTube/promo noise from a string for search purposes
const YT_NOISE_RE = /\s*[\(\[](official\s*(video|audio|music\s*video|lyric\s*video|visuali[sz]er)?|lyrics?|audio|video|music\s*video|mv|hd|hq|4k|visuali[sz]er|remix|prod\.?\s+[^\)\]]*|out\s+now)[\)\]]/gi;

function stripVideoNoise(s: string): string {
  return s.replace(YT_NOISE_RE, "").trim();
}

function normalizeForSearch(artist: string, title: string) {
  // Strip feat/ft patterns and video noise from title
  let cleanTitle = stripFeaturing(title);
  cleanTitle = stripVideoNoise(cleanTitle);

  // Extract primary artist (before feat/ft), take first if comma-separated
  let primaryArtist = stripFeaturing(artist)
    .split(/,\s*/)[0]
    .split(/\s*[&+x×]\s*/i)[0] // Also split on &, +, x collaborations
    .trim();

  return { primaryArtist, cleanTitle, fullArtist: artist.trim() };
}

function stringSimilarity(a: string, b: string): number {
  const na = a.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const nb = b.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  if (na === nb) return 100;
  if (!na || !nb) return 0;
  const maxLen = Math.max(na.length, nb.length);

  // Check if one string contains the other (common for partial matches)
  // Only boost if the shorter string is substantial (>4 chars) to avoid
  // inflating scores for generic single-word matches like "stone" or "love"
  if (na.includes(nb) || nb.includes(na)) {
    const minLen = Math.min(na.length, nb.length);
    if (minLen > 4) {
      return Math.round(Math.max(60, (minLen / maxLen) * 100));
    }
  }

  // Levenshtein
  const m = na.length, n = nb.length;
  let prev = Array.from({length: n + 1}, (_, j) => j);
  let curr = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (na[i-1] === nb[j-1] ? 0 : 1));
    }
    [prev, curr] = [curr, prev];
  }
  return Math.round(Math.max(0, (1 - prev[n] / maxLen) * 100));
}

// ─── ARTIST/TITLE SWAP DETECTION (Fix 4) ─────────────────────
// NTS tracklists sometimes have artist and title fields swapped.
// Heuristic: if "artist" looks like a generic track title and
// "title" looks like an artist name, swap them.

const GENERIC_TITLE_WORDS = new Set([
  "system", "energy", "blessed", "untitled", "intro", "outro",
  "interlude", "dub", "version", "mix", "edit", "instrumental",
  "love", "dreams", "paradise", "waves", "light", "flow",
  "rhythm", "pulse", "dawn", "horizon", "echo", "signal",
]);

function looksLikeArtistName(s: string): boolean {
  // Multiple proper nouns separated by commas/& suggest artist names
  const parts = s.split(/[,&]/).map(p => p.trim()).filter(Boolean);
  if (parts.length >= 2) return true;
  // Capitalized multi-word name (e.g. "Navy Blue", "Chuck Strangers")
  const words = s.split(/\s+/);
  if (words.length >= 2 && words.every(w => /^[A-Z]/.test(w))) return true;
  return false;
}

function looksLikeGenericTitle(s: string): boolean {
  const lower = s.toLowerCase().trim();
  // Single generic word
  if (GENERIC_TITLE_WORDS.has(lower)) return true;
  // Very short (1-2 words) and all lowercase
  const words = lower.split(/\s+/);
  if (words.length <= 2 && s === s.toLowerCase()) return true;
  return false;
}

function maybeSwapArtistTitle(artist: string, title: string): { artist: string; title: string; swapped: boolean } {
  if (looksLikeGenericTitle(artist) && looksLikeArtistName(title)) {
    return { artist: title, title: artist, swapped: true };
  }
  return { artist, title, swapped: false };
}

// ─── TRACK DEDUP HELPER ──────────────────────────────────────

function isSameTrack(a: { artist: string; title: string }, b: { artist: string; title: string }): boolean {
  return a.artist.toLowerCase().trim() === b.artist.toLowerCase().trim() &&
    a.title.toLowerCase().trim() === b.title.toLowerCase().trim();
}

interface Candidate {
  artist: string;
  title: string;
  source: string;
  source_url: string;
  source_context: string;
  co_occurrence: number;
  episode_id: string | null;
}

const SOURCE_MAX_EPISODES = 10;

async function discoverFromSource(
  sourceName: string,
  seedArtist: string,
  seedTitle: string,
  seedId: string,
  coMap: Map<string, Candidate>,
  episodePositions: Map<string, Array<{ key: string; position: number }>>,
  seedPositionsByEpisode: Map<string, number>,
  stats: { crawled: number; skipped: number; emptyTracklists: number; failedEpisodes: string[]; fullMatchEpisodeIds: string[] },
): Promise<void> {
  const source = SOURCES.find((s) => s.name === sourceName);
  if (!source) return;

  let sourceEpisodes: Array<{ url: string; title: string; date: string | null }> = [];

  if (sourceName === "lotradio") {
    // Lot Radio: tracklist matching ONLY — find episodes where a DJ played the seed track
    // No artist-as-host search — that's not the thesis
    try {
      const seedArtistLower = seedArtist.toLowerCase().trim();
      const seedTitleLower = seedTitle.toLowerCase().trim();
      const allDbEpisodes: any[] = [];
      const PAGE_SIZE = 1000;
      let from = 0;
      while (true) {
        const { data: page } = await db
          .from("episodes")
          .select("url, title, aired_date, metadata")
          .eq("source", "lotradio")
          .not("metadata", "is", null)
          .range(from, from + PAGE_SIZE - 1);
        if (!page || page.length === 0) break;
        allDbEpisodes.push(...page);
        if (page.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
      }
      const dbEpisodes = allDbEpisodes;

      if (dbEpisodes.length > 0) {
        for (const ep of dbEpisodes as any[]) {
          const tracklist: Array<{ artist: string; title: string }> = ep.metadata?.tracklist || [];
          if (tracklist.length === 0) continue;
          // Match: same artist AND same title (the seed track was played in this episode)
          const hasMatch = tracklist.some((t) =>
            t.artist?.toLowerCase().trim() === seedArtistLower &&
            t.title?.toLowerCase().trim() === seedTitleLower
          );
          if (hasMatch) {
            sourceEpisodes.push({ url: ep.url, title: ep.title || ep.url, date: ep.aired_date || null });
          }
        }
      }
      log("info", `Lot Radio: checked ${dbEpisodes?.length || 0} episodes, found ${sourceEpisodes.length} tracklist matches for "${seedArtist} - ${seedTitle}"`);
    } catch (err) {
      log("fail", `Lot Radio tracklist search error: ${err instanceof Error ? err.message : err}`);
    }
  } else {
    // NTS and other sources: use searchForSeed directly
    try {
      const searchResults = await source.searchForSeed(seedArtist, seedTitle);
      sourceEpisodes = searchResults.map((e) => ({ url: e.url, title: e.title, date: e.date }));
    } catch (err) {
      log("fail", `${sourceName} search error: ${err instanceof Error ? err.message : err}`);
      return;
    }
  }

  console.log(`  Found ${sourceEpisodes.length} ${sourceName} episodes`);

  for (const ep of sourceEpisodes.slice(0, SOURCE_MAX_EPISODES)) {
    await sleep(1000);

    const episodeUrl = ep.url;
    const context = `${ep.title}${ep.date ? ` (${ep.date})` : ""}`;
    const airedDate = ep.date || null;

    // Check if episode already crawled
    const { data: existingEp } = await db.from("episodes")
      .select("id").eq("url", episodeUrl).limit(1).single();

    let episodeId: string;

    if (existingEp) {
      episodeId = existingEp.id;
      await db.from("episode_seeds").upsert(
        { episode_id: episodeId, seed_id: seedId },
        { onConflict: "episode_id,seed_id" }
      );

      const { count: trackCount } = await db.from("tracks")
        .select("*", { count: "exact", head: true })
        .eq("episode_id", episodeId);

      if (trackCount && trackCount > 0) {
        log("skip", `Already crawled (${trackCount} tracks): ${context}`);
        stats.skipped++;
        continue;
      }

      log("warn", `Episode exists but has 0 tracks — re-fetching tracklist: ${context}`);
    } else {
      const artworkUrl = await source.getArtwork(episodeUrl);
      const { data: newEp, error: epErr } = await db.from("episodes").insert({
        url: episodeUrl,
        title: ep.title || null,
        source: sourceName,
        aired_date: airedDate,
        artwork_url: artworkUrl,
      }).select("id").single();

      if (!newEp) {
        log("fail", `Episode insert failed: ${context} — ${epErr?.message ?? "no data returned"}`);
        continue;
      }
      episodeId = newEp.id;
    }

    const rawTracks = await source.getTracklist(episodeUrl);

    if (rawTracks.length === 0) {
      stats.emptyTracklists++;
      stats.failedEpisodes.push(context);
      log("fail", `EMPTY TRACKLIST: ${context} — ${episodeUrl}`);
      continue;
    }

    const hasFullMatch = rawTracks.some((t) => isSameTrack(t, { artist: seedArtist, title: seedTitle }));
    const hasArtistMatch = !hasFullMatch && rawTracks.some(
      (t) => t.artist.toLowerCase().trim() === seedArtist.toLowerCase().trim()
    );
    const matchType = hasFullMatch ? "full" : hasArtistMatch ? "artist" : null;
    if (!matchType) {
      log("skip", `No match found for seed "${seedArtist} - ${seedTitle}" in ${context} — skipping`);
      continue;
    }

    await db.from("episode_seeds").upsert(
      { episode_id: episodeId, seed_id: seedId, match_type: matchType },
      { onConflict: "episode_id,seed_id" }
    );

    log("info", `Match type: ${matchType} for ${context}`);

    if (matchType === "full") {
      stats.fullMatchEpisodeIds.push(episodeId);
    }

    let epNew = 0;
    for (let pos = 0; pos < rawTracks.length; pos++) {
      const track = rawTracks[pos];
      if (isSameTrack(track, { artist: seedArtist, title: seedTitle })) {
        // Track the seed track's position in this episode for episode_tracks linking
        if (!seedPositionsByEpisode.has(episodeId)) {
          seedPositionsByEpisode.set(episodeId, pos);
        }
        continue;
      }

      const key = `${track.artist.toLowerCase().trim()}::${track.title.toLowerCase().trim()}`;
      const existing = coMap.get(key);
      if (existing) {
        existing.co_occurrence++;
      } else {
        coMap.set(key, {
          artist: track.artist.trim(),
          title: track.title.trim(),
          source: sourceName,
          source_url: episodeUrl,
          source_context: context,
          co_occurrence: 1,
          episode_id: episodeId,
        });
        epNew++;
      }

      if (!episodePositions.has(episodeId)) episodePositions.set(episodeId, []);
      episodePositions.get(episodeId)!.push({ key, position: pos });
    }
    stats.crawled++;
    log("ok", `${context} — ${rawTracks.length} tracks, ${epNew} new candidates`);
  }
}

async function discover(seedArtist: string, seedTitle: string, seedId: string): Promise<{ candidates: Candidate[]; emptyTracklists: number; failedEpisodes: string[]; episodePositions: Map<string, Array<{ key: string; position: number }>>; seedPositionsByEpisode: Map<string, number>; fullMatchEpisodeIds: string[] }> {
  const coMap = new Map<string, Candidate>();
  const episodePositions = new Map<string, Array<{ key: string; position: number }>>();
  const seedPositionsByEpisode = new Map<string, number>();
  const stats = { crawled: 0, skipped: 0, emptyTracklists: 0, failedEpisodes: [] as string[], fullMatchEpisodeIds: [] as string[] };

  for (const source of SOURCES) {
    await discoverFromSource(source.name, seedArtist, seedTitle, seedId, coMap, episodePositions, seedPositionsByEpisode, stats);
  }

  log("info", `Discovery scan: ${stats.crawled} crawled, ${stats.skipped} already known, ${coMap.size} unique candidates`);
  if (stats.emptyTracklists > 0) {
    console.log(`\n  ⚠️  ${stats.emptyTracklists} episode(s) returned EMPTY tracklists:`);
    for (const name of stats.failedEpisodes) {
      console.log(`     - ${name}`);
    }
    console.log(`     These episodes exist in DB but have 0 tracks.\n`);
  }

  const candidates = Array.from(coMap.values())
    .sort((a, b) => b.co_occurrence - a.co_occurrence);
  return { candidates, emptyTracklists: stats.emptyTracklists, failedEpisodes: stats.failedEpisodes, episodePositions, seedPositionsByEpisode, fullMatchEpisodeIds: stats.fullMatchEpisodeIds };
}

async function runDiscover(): Promise<number> {
  const t0 = Date.now();
  console.log(`\n━━━ DISCOVER ━━━`);

  const { data: seeds } = await db.from("seeds").select("*").eq("active", true);
  if (!seeds || seeds.length === 0) {
    log("warn", "No active seeds in database");
    return 0;
  }

  log("info", `${seeds.length} active seed(s): ${seeds.map((s: any) => `${s.artist} - ${s.title}`).join(", ")}`);

  // Prioritize seeds with no episodes and no discovery runs yet
  const seedIds = seeds.map((s: any) => s.id);
  const { data: episodeLinks } = await db.from("episode_seeds")
    .select("seed_id").in("seed_id", seedIds);
  const { data: runLinks } = await db.from("discovery_runs")
    .select("seed_id").in("seed_id", seedIds);

  const seedsWithEpisodes = new Set((episodeLinks || []).map((l: any) => l.seed_id));
  const seedsWithRuns = new Set((runLinks || []).map((l: any) => l.seed_id));

  // Fresh seeds: no episodes AND no runs
  const freshSeeds = seeds.filter((s: any) => !seedsWithEpisodes.has(s.id) && !seedsWithRuns.has(s.id));

  let seed: any;
  if (freshSeeds.length > 0) {
    // Pick oldest fresh seed first
    seed = freshSeeds[0];
    log("info", `Prioritizing fresh seed (no episodes/runs yet)`);
  } else {
    // Round-robin among remaining seeds
    const seedIndex = Math.floor(Date.now() / 1000) % seeds.length;
    seed = seeds[seedIndex];
  }
  console.log(`  Seed: ${seed.artist} - ${seed.title}`);

  const { candidates, emptyTracklists, failedEpisodes, episodePositions, seedPositionsByEpisode, fullMatchEpisodeIds } = await discover(seed.artist, seed.title, seed.id);
  console.log(`  ${candidates.length} candidates found`);

  if (candidates.length > 0) {
    const top3 = candidates.slice(0, 3).map((c) => `${c.artist} – ${c.title} (x${c.co_occurrence})`);
    log("info", `Top candidates: ${top3.join(", ")}`);
  }

  // Dedup against DB
  const seen = new Set<string>();
  const toInsert: Candidate[] = [];
  let dupCount = 0;

  for (const c of candidates) {
    if (toInsert.length >= candidateLimit) break;
    const key = `${c.artist.toLowerCase()}::${c.title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const { data: existing } = await db.from("tracks")
      .select("id").ilike("artist", c.artist).ilike("title", c.title).limit(1);
    if (existing && existing.length > 0) { dupCount++; continue; }

    toInsert.push(c);
  }

  log("info", `Dedup: ${candidates.length} candidates → ${toInsert.length} new, ${dupCount} already in DB`);

  // Filter out garbage tracks before insertion
  const GARBAGE_TITLES = new Set(["unknown track", "untitled", "id", "?", "unknown", ""]);
  const preFilterCount = toInsert.length;
  const filtered = toInsert.filter((c) => {
    const lTitle = c.title.toLowerCase().trim();
    const lArtist = c.artist.toLowerCase().trim();
    // Reject tracks with garbage titles
    if (GARBAGE_TITLES.has(lTitle)) {
      log("skip", `Filtered garbage title: ${c.artist} – ${c.title}`);
      return false;
    }
    // Reject tracks where artist or title is just a single character
    if (lTitle.length <= 1 || lArtist.length <= 1) {
      log("skip", `Filtered too-short: ${c.artist} – ${c.title}`);
      return false;
    }
    return true;
  });
  if (filtered.length < preFilterCount) {
    log("info", `Garbage filter: removed ${preFilterCount - filtered.length} tracks`);
  }

  // Insert tracks and link to episodes with position
  let added = 0;
  for (const c of filtered) {
    const { data: inserted, error } = await db.from("tracks").insert({
      artist: c.artist,
      title: c.title,
      source: c.source,
      source_url: c.source_url,
      source_context: c.source_context,
      metadata: { co_occurrence: c.co_occurrence, seed_artist: seed.artist, seed_title: seed.title },
      status: "pending",
      episode_id: c.episode_id,
      seed_track_id: seed.track_id || null,
    }).select("id").single();
    if (error || !inserted) {
      log("fail", `Insert failed: ${c.artist} – ${c.title} — ${error?.message ?? "no data"}`);
      continue;
    }
    added++;

    // Insert episode_tracks with position for all episodes this track appeared in
    const key = `${c.artist.toLowerCase()}::${c.title.toLowerCase()}`;
    for (const [epId, positions] of episodePositions) {
      for (const p of positions) {
        if (p.key === key) {
          await db.from("episode_tracks").upsert(
            { episode_id: epId, track_id: inserted.id, position: p.position },
            { onConflict: "episode_id,track_id" }
          );
        }
      }
    }
  }

  // Ensure the seed track itself exists in the tracks table
  {
    const { data: existingSeedTrack } = await db.from("tracks")
      .select("id")
      .ilike("artist", seed.artist)
      .ilike("title", seed.title)
      .limit(1)
      .maybeSingle();

    let seedTrackId: string | null = existingSeedTrack?.id || null;

    if (!existingSeedTrack) {
      // Find first full-match episode for episode_id linkage
      const firstFullMatchEpId = fullMatchEpisodeIds[0] || null;
      const { data: newSeedTrack } = await db.from("tracks").insert({
        artist: seed.artist,
        title: seed.title,
        source: "seed",
        source_url: "",
        source_context: "Seed track",
        status: "approved",
        episode_id: firstFullMatchEpId,
        metadata: { is_seed: true },
      }).select("id").single();

      if (newSeedTrack) {
        seedTrackId = newSeedTrack.id;
        log("ok", `Created seed track entry: ${seed.artist} - ${seed.title}`);
      }
    }

    if (seedTrackId) {
      // Update seed.track_id if not already set
      if (!seed.track_id) {
        await db.from("seeds").update({ track_id: seedTrackId }).eq("id", seed.id);
      }

      // Link seed track to episodes where it was directly found (full match)
      for (const epId of fullMatchEpisodeIds) {
        const pos = seedPositionsByEpisode.get(epId);
        await db.from("episode_tracks").upsert(
          { episode_id: epId, track_id: seedTrackId, position: pos ?? 0 },
          { onConflict: "episode_id,track_id" }
        );
      }
    }
  }

  // Log the run
  await db.from("discovery_runs").insert({
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    seed_id: seed.id,
    seed_track_id: seed.track_id || null,
    sources_searched: SOURCES.map((s) => s.name),
    tracks_found: candidates.length,
    tracks_added: added,
    notes: candidates.length === 0
      ? `No episodes matched for "${seed.artist} - ${seed.title}"`
      : emptyTracklists > 0
        ? `${emptyTracklists} episode(s) had empty tracklists: ${failedEpisodes.join(", ")}`
        : null,
  });

  console.log(`  Added: ${added} new tracks (${elapsed(t0)})`);
  return added;
}

// ─── ENRICH (Spotify + YouTube metadata) ─────────────────────

const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_API = "https://api.spotify.com/v1";
let cachedToken: string | null = null;
let tokenExpiry = 0;

async function getSpotifyToken(): Promise<string> {
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
  if (!res.ok) {
    log("fail", `Spotify auth HTTP ${res.status}`);
    throw new Error(`Spotify auth failed: ${res.status}`);
  }
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

async function spotifySearch(query: string, token: string, artist: string, title: string): Promise<SpotifyTrackItem[]> {
  const q = encodeURIComponent(query);
  const res = await fetch(`${SPOTIFY_API}/search?q=${q}&type=track&limit=5`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 429) {
    const waitSec = parseInt(res.headers.get("Retry-After") || "5", 10);
    log("wait", `Spotify rate-limited — waiting ${waitSec}s (${artist} – ${title})`);
    await sleep(waitSec * 1000);
    return spotifySearch(query, token, artist, title);
  }
  if (!res.ok) {
    log("fail", `Spotify search HTTP ${res.status} for "${query}"`);
    return [];
  }
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

  // Score artist: best of primary vs first artist, or full vs all artists
  const artistScore = Math.max(
    stringSimilarity(primaryArtist, item.artists[0]?.name || ""),
    stringSimilarity(fullArtist, candidateArtist),
  );

  // Score title: best of cleaned title or original title vs spotify track name
  const cleanedSpotifyTitle = stripFeaturing(trackName);
  const titleScore = Math.max(
    stringSimilarity(cleanTitle, trackName),
    stringSimilarity(cleanTitle, cleanedSpotifyTitle),
    stringSimilarity(originalTitle, trackName),
  );

  // Hard artist floor: if artist match is terrible, reject regardless of title
  if (artistScore < 40) {
    return { score: Math.min(artistScore, 30), artistScore, titleScore };
  }

  return { score: artistScore * 0.4 + titleScore * 0.6, artistScore, titleScore };
}

async function spotifyLookup(artist: string, title: string) {
  const token = await getSpotifyToken();
  const { primaryArtist, cleanTitle, fullArtist } = normalizeForSearch(artist, title);

  // Multi-strategy search: structured queries first, then freeform
  // NOTE: title-only fallback removed — it caused false matches for generic titles
  const strategies = [
    `track:${cleanTitle} artist:${primaryArtist}`,
    `${primaryArtist} ${cleanTitle}`,
    `${cleanTitle} ${primaryArtist}`,
  ];

  const seen = new Set<string>();
  const allCandidates: SpotifyTrackItem[] = [];

  for (const strategy of strategies) {
    // If we already have high-confidence matches, skip weaker strategies
    if (allCandidates.length > 5) break;

    const items = await spotifySearch(strategy, token, artist, title);
    for (const item of items) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        allCandidates.push(item);
      }
    }
    await sleep(100);
  }

  if (!allCandidates.length) return null;

  // Score each candidate
  let bestMatch = allCandidates[0];
  let bestScore = -1;
  let bestArtistScore = 0;
  let bestTitleScore = 0;

  for (const item of allCandidates) {
    const { score, artistScore, titleScore } = scoreSpotifyCandidate(item, primaryArtist, fullArtist, cleanTitle, title);
    if (score > bestScore) {
      bestScore = score;
      bestArtistScore = artistScore;
      bestTitleScore = titleScore;
      bestMatch = item;
    }
  }

  const confidence = Math.round(bestScore);

  // Reject matches with low overall confidence (raised from 50 → 65)
  if (confidence < 65) {
    log("skip", `Spotify: score ${confidence} too low for ${artist} – ${title} (artist:${Math.round(bestArtistScore)} title:${Math.round(bestTitleScore)})`);
    return null;
  }

  // Post-match validation: verify artist actually matches
  // This catches cases where the title matched but the artist is completely different
  if (bestArtistScore < 50) {
    const spotArtist = bestMatch.artists.map((a) => a.name).join(", ");
    log("skip", `Spotify: artist mismatch for ${artist} – ${title} → got "${spotArtist}" (artist:${Math.round(bestArtistScore)})`);
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

interface YouTubeResult {
  url: string;
  thumbnail: string | null;
}

async function youtubeLookup(artist: string, title: string): Promise<YouTubeResult | null> {
  try {
    const { primaryArtist, cleanTitle } = normalizeForSearch(artist, title);
    const searchQuery = `${primaryArtist} ${cleanTitle}`;
    const proc = Bun.spawn(
      [YT_DLP_BIN, "--dump-json", "--no-download", "--flat-playlist", "--no-warnings",
       `ytsearch3:${searchQuery}`],
      { stdout: "pipe", stderr: "pipe" },
    );
    // Read stdout+stderr and wait for exit concurrently to avoid pipe buffer deadlock
    const [stdout, stderr, exitCode] = await Promise.all([
      withTimeout(new Response(proc.stdout).text(), 30_000, "yt-search"),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      log("fail", `yt-dlp exit ${exitCode} for "${searchQuery}"${stderr.trim() ? `: ${stderr.trim().slice(0, 120)}` : ""}`);
      return null;
    }
    if (!stdout.trim()) {
      log("skip", `yt-dlp returned empty for "${searchQuery}"`);
      return null;
    }
    const results = stdout.trim().split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const filtered = results.filter((r: any) => {
      const dur = r.duration || 0;
      const t = (r.title || "").toLowerCase();
      if (dur > 0 && (dur < 60 || dur > 900)) return false;
      if (t.includes("live at") || t.includes("live from")) return false;
      return true;
    });
    const chosen = (filtered[0] || results[0]);
    if (!chosen?.webpage_url) {
      log("skip", `YouTube: ${results.length} results but none usable for "${searchQuery}" (${filtered.length} passed filter)`);
      return null;
    }
    // Extract the best thumbnail — yt-dlp provides thumbnails array or a single thumbnail field
    let thumbnail: string | null = null;
    if (chosen.thumbnails?.length) {
      // Pick the largest thumbnail (last in the array, typically highest res)
      thumbnail = chosen.thumbnails[chosen.thumbnails.length - 1]?.url || null;
    } else if (chosen.thumbnail) {
      thumbnail = chosen.thumbnail;
    }
    return { url: chosen.webpage_url, thumbnail };
  } catch (err) {
    log("fail", `YouTube lookup error: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

async function spotifyArtistGenres(artistIds: string[]): Promise<string[]> {
  if (!artistIds.length) return [];
  try {
    const token = await getSpotifyToken();
    // Spotify /v1/artists accepts up to 50 IDs
    const ids = artistIds.slice(0, 50).join(",");
    const res = await fetch(`${SPOTIFY_API}/artists?ids=${ids}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 429) {
      const waitSec = parseInt(res.headers.get("Retry-After") || "5", 10);
      log("wait", `Spotify artist rate-limited — waiting ${waitSec}s`);
      await sleep(waitSec * 1000);
      return spotifyArtistGenres(artistIds);
    }
    if (!res.ok) {
      log("fail", `Spotify artists HTTP ${res.status}`);
      return [];
    }
    const data = await res.json() as { artists: Array<{ genres: string[] }> };
    const genres = new Set<string>();
    for (const artist of data.artists || []) {
      for (const g of artist.genres || []) genres.add(g);
    }
    return Array.from(genres);
  } catch (err) {
    log("fail", `Spotify artist genres error: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

async function enrichOne(track: any): Promise<boolean> {
  const label = `${track.artist} – ${track.title}`;
  const t0 = Date.now();
  const updates: Record<string, unknown> = {};
  let spotFound = !!track.spotify_url;
  let ytFound = !!track.youtube_url;

  let spotConfidence = 0;
  let ytThumbnail: string | null = null;

  if (!track.spotify_url) {
    try {
      const spot = await spotifyLookup(track.artist, track.title);
      if (spot) {
        spotFound = true;
        spotConfidence = spot.spotify_confidence;
        updates.spotify_url = spot.spotify_url;
        if (!track.preview_url && spot.preview_url) updates.preview_url = spot.preview_url;

        // Only use Spotify cover art when confidence is high (strong match)
        // The 65 floor in spotifyLookup already filters the worst, but we want
        // extra confidence before trusting artwork since wrong art is very visible
        if (!track.cover_art_url && spot.cover_art_url && spot.spotify_confidence >= 75) {
          updates.cover_art_url = spot.cover_art_url;
        }

        // Fetch artist genres from Spotify
        const genres = await spotifyArtistGenres(spot.artist_ids);

        updates.metadata = {
          ...(track.metadata || {}),
          spotify_id: spot.spotify_id,
          album: spot.album,
          spotify_confidence: spot.spotify_confidence,
          ...(genres.length > 0 ? { genres } : {}),
        };
      } else {
        // Mark as checked with empty string so future repair passes can focus on YouTube.
        updates.spotify_url = "";
      }
    } catch (err) {
      log("fail", `Spotify error for ${label}: ${err instanceof Error ? err.message : err}`);
      updates.spotify_url = "";
    }
  }

  if (!track.youtube_url) {
    try {
      const yt = await youtubeLookup(track.artist, track.title);
      if (yt) {
        updates.youtube_url = yt.url;
        ytFound = true;
        ytThumbnail = yt.thumbnail;
      }
    } catch (err) {
      log("fail", `YouTube error for ${label}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Artwork fallback: use NTS episode artwork (always contextually correct)
  if (!track.cover_art_url && !updates.cover_art_url && track.episode_id) {
    const { data: ep } = await db.from("episodes")
      .select("artwork_url")
      .eq("id", track.episode_id)
      .single();
    if (ep?.artwork_url) {
      updates.cover_art_url = ep.artwork_url;
      log("info", `Using episode artwork as cover art for ${label}`);
    }
  }

  const { error } = await db.from("tracks").update(updates).eq("id", track.id);
  if (error) {
    log("fail", `DB update failed for ${label}: ${error.message}`);
    return false;
  }

  const sp = spotFound ? "spotify" : "no-spotify";
  const yt = ytFound ? "youtube" : "no-youtube";
  log(spotFound || ytFound ? "ok" : "skip", `${label} [${sp}, ${yt}] (${elapsed(t0)})`);
  return true;
}

async function runEnrich(): Promise<number> {
  const t0 = Date.now();
  console.log(`\n━━━ ENRICH ━━━`);

  // Count total pending before we start
  const { count: pendingCount } = await db.from("tracks")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending")
    .or("spotify_url.is.null,and(youtube_url.is.null,storage_path.is.null)");
  console.log(`  ${pendingCount ?? "?"} tracks pending enrichment`);

  if (pendingCount === 0) {
    log("info", "Nothing to enrich");
    return 0;
  }

  let total = 0;
  let failed = 0;
  let round = 0;
  const failCounts = new Map<string, number>(); // track id -> retry count
  const processedIds = new Set<string>();

  while (true) {
    round++;
    const { data: tracks } = await db.from("tracks").select("*")
      .eq("status", "pending")
      .or("spotify_url.is.null,and(youtube_url.is.null,storage_path.is.null)")
      .order("created_at").limit(30);
    if (!tracks?.length) break;

    // Filter out tracks that have exceeded max retries
    const eligible = tracks.filter((t) => {
      if (processedIds.has(t.id)) return false;
      const retries = failCounts.get(t.id) || 0;
      if (retries >= ENRICH_MAX_RETRIES) {
        log("warn", `Giving up after ${retries} failures: ${t.artist} – ${t.title}`);
        return false;
      }
      return true;
    });

    if (!eligible.length) {
      // If we've exhausted the current window of tracks, move on.
      if (tracks.every((t) => processedIds.has(t.id))) {
        break;
      }

      // All remaining tracks have been retried too many times — mark them and bail
      for (const t of tracks) {
        if (processedIds.has(t.id)) continue;
        await db.from("tracks").update({ spotify_url: "", metadata: { ...(t.metadata || {}), enrich_error: "max retries exceeded" } }).eq("id", t.id);
      }
      log("warn", `${tracks.length} tracks failed after ${ENRICH_MAX_RETRIES} retries — marked and moving on`);
      break;
    }

    console.log(`  Round ${round}: ${eligible.length} tracks (${elapsed(t0)} elapsed)`);
    for (const track of eligible) {
      processedIds.add(track.id);
    }

    for (let i = 0; i < eligible.length; i += ENRICH_CONCURRENCY) {
      const batch = eligible.slice(i, i + ENRICH_CONCURRENCY);
      const results = await Promise.allSettled(batch.map(enrichOne));

      for (let j = 0; j < results.length; j++) {
        const r = results[j];
        if (r.status === "fulfilled" && r.value) {
          total++;
        } else {
          failed++;
          const trackId = batch[j].id;
          const retries = (failCounts.get(trackId) || 0) + 1;
          failCounts.set(trackId, retries);
          if (r.status === "rejected") {
            log("fail", `Unhandled error (attempt ${retries}/${ENRICH_MAX_RETRIES}): ${r.reason}`);
          }
        }
      }
    }
  }

  console.log(`  Enriched: ${total}, Failed: ${failed} (${elapsed(t0)})`);
  return total;
}

// ─── MAIN ────────────────────────────────────────────────────

// Graceful shutdown
let shuttingDown = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (shuttingDown) { console.log("\n  Force quit."); process.exit(1); }
    shuttingDown = true;
    console.log(`\n  ${sig} received — finishing current batch then exiting...`);
    console.log(`  (press again to force quit)`);
  });
}

async function runOnce(): Promise<{ discovered: number; enriched: number }> {
  let discovered = 0;
  if (!skipDiscover) {
    discovered = await runDiscover();
  } else {
    console.log(`\n━━━ DISCOVER ━━━\n  Skipped`);
  }
  const enriched = await runEnrich();
  return { discovered, enriched };
}

async function main() {
  const start = Date.now();
  const mode = deadline ? `looping for ${durationMinutes}m` : "single run";
  console.log(`\n  The Stacks — Pipeline (Discover + Enrich)`);
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Options: limit=${candidateLimit}, skip-discover=${skipDiscover}, mode=${mode}\n`);

  let totalDiscovered = 0;
  let totalEnriched = 0;
  let runs = 0;

  do {
    if (shuttingDown) break;
    runs++;
    if (deadline) console.log(`\n  ── Run #${runs} (${Math.max(0, Math.ceil((deadline - Date.now()) / 60_000))}m remaining) ──`);

    const { discovered, enriched } = await runOnce();
    totalDiscovered += discovered;
    totalEnriched += enriched;

    // If looping, cooldown between runs (skip if time's almost up)
    if (deadline && !shuttingDown && Date.now() < deadline) {
      const cooldown = Math.min(30_000, deadline - Date.now());
      if (cooldown > 2_000) {
        console.log(`  Cooling down ${(cooldown / 1000).toFixed(0)}s before next run...`);
        await sleep(cooldown);
      }
    }
  } while (deadline && Date.now() < deadline && !shuttingDown);

  const totalElapsed = ((Date.now() - start) / 1000);
  const elapsedStr = totalElapsed < 60 ? `${totalElapsed.toFixed(1)}s` : `${(totalElapsed / 60).toFixed(1)}m`;

  console.log(`\n  ── Done (${elapsedStr}, ${runs} run${runs > 1 ? "s" : ""}) ──`);
  console.log(`  Discovered: ${totalDiscovered}`);
  console.log(`  Enriched:   ${totalEnriched}`);
  console.log(`  Run \`bun run download\` separately to fetch audio.\n`);
}

main().catch((err) => {
  console.error("\n  !! Pipeline crashed !!");
  console.error(`  ${err instanceof Error ? err.stack || err.message : err}`);
  process.exit(1);
});
