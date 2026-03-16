import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const NTS_API = "https://www.nts.live/api/v2";
const NTS_SEARCH_LIMIT = 30;
const NTS_MAX_EPISODES = 3; // Keep low for Vercel timeout

// Decode common HTML entities from NTS API responses
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

interface NTSSearchResult {
  path: string;
  title: string;
  date: string;
}

interface NTSTrack {
  artist: string;
  title: string;
}

async function ntsSearch(query: string): Promise<NTSSearchResult[]> {
  const url = `${NTS_API}/search?q=${encodeURIComponent(query)}&version=2&offset=0&limit=${NTS_SEARCH_LIMIT}&types[]=track`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`NTS search failed: ${res.status}`);

  const data = (await res.json()) as {
    results: Array<{
      local_date: string;
      article: { path: string; title: string };
    }>;
  };

  const seen = new Set<string>();
  const episodes: NTSSearchResult[] = [];
  for (const r of data.results || []) {
    const path = r.article?.path;
    if (!path || seen.has(path)) continue;
    seen.add(path);
    episodes.push({
      path,
      title: decodeEntities(r.article.title || ""),
      date: r.local_date || "",
    });
  }
  return episodes;
}

async function ntsTracklist(episodePath: string): Promise<NTSTrack[]> {
  const url = `${NTS_API}${episodePath}/tracklist`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return [];

  const data = await res.json();
  const tracks = data.results || (data as unknown as NTSTrack[]);
  if (!Array.isArray(tracks)) return [];
  return tracks
    .filter((t: { artist?: string; title?: string }) => t.artist?.trim() && t.title?.trim())
    .map((t: { artist: string; title: string }) => ({
      artist: decodeEntities(t.artist.trim()),
      title: decodeEntities(t.title.trim()),
    }));
}

function isSameTrack(
  a: { artist: string; title: string },
  b: { artist: string; title: string }
): boolean {
  return (
    a.artist.toLowerCase().trim() === b.artist.toLowerCase().trim() &&
    a.title.toLowerCase().trim() === b.title.toLowerCase().trim()
  );
}

// POST /api/discover
export async function POST(req: NextRequest) {
  const db = getServiceClient();
  const { seed_id, user_id } = await req.json();

  if (!seed_id || !user_id) {
    return NextResponse.json(
      { error: "seed_id and user_id are required" },
      { status: 400 }
    );
  }

  // 1. Load the seed
  const { data: seed, error: seedErr } = await db
    .from("seeds")
    .select("*")
    .eq("id", seed_id)
    .single();

  if (!seed || seedErr) {
    return NextResponse.json({ error: "Seed not found" }, { status: 404 });
  }

  const seedArtist = seed.artist as string;
  const seedTitle = seed.title as string;

  // 2. Check for existing tracks via episode_seeds → episodes → tracks
  const { data: episodeLinks } = await db
    .from("episode_seeds")
    .select("episode_id")
    .eq("seed_id", seed_id);

  const episodeIds = (episodeLinks || []).map(
    (l: { episode_id: string }) => l.episode_id
  );

  let existingTrackIds: string[] = [];

  if (episodeIds.length > 0) {
    const { data: etLinks } = await db
      .from("episode_tracks")
      .select("track_id")
      .in("episode_id", episodeIds);
    existingTrackIds = (etLinks || []).map((t: { track_id: string }) => t.track_id);
  }

  // Also check tracks linked via seed_track_id
  if (seed.track_id) {
    const { data: seedTracks } = await db
      .from("tracks")
      .select("id")
      .eq("seed_track_id", seed.track_id);
    const ids = (seedTracks || []).map((t: { id: string }) => t.id);
    const combined = new Set(existingTrackIds.concat(ids));
    existingTrackIds = Array.from(combined);
  }

  // 3. If we have existing tracks, create user_tracks and return
  if (existingTrackIds.length > 0) {
    const created = await createUserTracks(db, user_id, existingTrackIds);
    return NextResponse.json({
      tracks_found: existingTrackIds.length,
      tracks_new: 0,
      tracks_existing: existingTrackIds.length,
      user_tracks_created: created,
    });
  }

  // 4. No existing tracks — run NTS crawl + lot radio DB matching in parallel
  try {
    const [ntsResult, lotResult] = await Promise.all([
      crawlNTS(db, seedArtist, seedTitle, seed_id, seed.track_id, user_id),
      findLotRadioMatches(db, seedArtist, seedTitle, seed_id, seed.track_id),
    ]);

    // Create user_tracks for lot radio tracks (NTS already did its own)
    const lotUserTracksCreated = await createUserTracks(db, user_id, [
      ...lotResult.newTrackIds,
      ...lotResult.existingTrackIds,
    ]);

    const totalNew = ntsResult.tracks_new + lotResult.newTrackIds.length;
    const totalExisting = ntsResult.tracks_existing + lotResult.existingTrackIds.length;
    const sourcesSearched = ["nts"];
    if (lotResult.newTrackIds.length > 0 || lotResult.existingTrackIds.length > 0) {
      sourcesSearched.push("lotradio");
    }

    await db.from("discovery_runs").insert({
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      seed_id: seed_id,
      seed_track_id: seed.track_id || null,
      sources_searched: sourcesSearched,
      tracks_found: totalNew + totalExisting,
      tracks_added: totalNew,
      notes: `On-demand discover: ${totalNew} new, ${totalExisting} existing`,
    });

    return NextResponse.json({
      tracks_found: totalNew + totalExisting,
      tracks_new: totalNew,
      tracks_existing: totalExisting,
      user_tracks_created: ntsResult.user_tracks_created + lotUserTracksCreated,
    });
  } catch (err) {
    console.error("Discover crawl error:", err);
    return NextResponse.json(
      {
        error: "Discovery failed",
        detail: err instanceof Error ? err.message : String(err),
        tracks_found: 0,
        tracks_new: 0,
        tracks_existing: 0,
      },
      { status: 500 }
    );
  }
}

async function crawlNTS(
  db: ReturnType<typeof getServiceClient>,
  seedArtist: string,
  seedTitle: string,
  seedId: string,
  seedTrackId: string | null,
  userId: string
): Promise<{
  tracks_found: number;
  tracks_new: number;
  tracks_existing: number;
  user_tracks_created: number;
  newTrackIds: string[];
  existingTrackIds: string[];
}> {
  const query = `${seedArtist} ${seedTitle}`;
  const episodes = await ntsSearch(query);

  const newTrackIds: string[] = [];
  const existingTrackIds: string[] = [];
  const seenKeys = new Set<string>();

  for (const ep of episodes.slice(0, NTS_MAX_EPISODES)) {
    const episodeUrl = `https://www.nts.live${ep.path}`;
    const context = `${ep.title}${ep.date ? ` (${ep.date.split("T")[0]})` : ""}`;
    const airedDate = ep.date ? ep.date.split("T")[0] : null;

    // Check if episode already exists
    const { data: existingEp } = await db
      .from("episodes")
      .select("id")
      .eq("url", episodeUrl)
      .limit(1)
      .single();

    let episodeId: string;

    // Extract show slug for curator linkage
    const showSlug = ep.path.match(/^\/shows\/([^/]+)\//)?.[1] || null;

    if (existingEp) {
      episodeId = existingEp.id;
    } else {
      // Find or create curator from show slug
      let curatorId: string | null = null;
      if (showSlug) {
        const { data: existingCurator } = await db
          .from("curators")
          .select("id")
          .eq("slug", showSlug)
          .limit(1)
          .maybeSingle();

        if (existingCurator) {
          curatorId = existingCurator.id;
        } else {
          const { data: newCurator } = await db
            .from("curators")
            .insert({
              name: showSlug.replace(/-/g, " "),
              slug: showSlug,
              source: "nts",
              source_url: `https://www.nts.live/shows/${showSlug}`,
            })
            .select("id")
            .single();
          if (newCurator) curatorId = newCurator.id;
        }
      }

      const { data: newEp, error: epErr } = await db
        .from("episodes")
        .insert({
          url: episodeUrl,
          title: ep.title || null,
          source: "nts",
          aired_date: airedDate,
          curator_id: curatorId,
        })
        .select("id")
        .single();

      if (!newEp || epErr) continue;
      episodeId = newEp.id;
    }

    // Link episode to seed
    await db
      .from("episode_seeds")
      .upsert(
        { episode_id: episodeId, seed_id: seedId },
        { onConflict: "episode_id,seed_id" }
      );

    // If episode already has tracks in junction table, collect them instead of re-crawling
    const { data: epTracks, count: trackCount } = await db
      .from("episode_tracks")
      .select("track_id", { count: "exact" })
      .eq("episode_id", episodeId);

    if (trackCount && trackCount > 0) {
      for (const t of epTracks || []) {
        existingTrackIds.push(t.track_id);
      }
      continue;
    }

    // Fetch tracklist from NTS
    const tracks = await ntsTracklist(ep.path);
    if (tracks.length === 0) continue;

    // Determine match type
    const hasFullMatch = tracks.some((t) =>
      isSameTrack(t, { artist: seedArtist, title: seedTitle })
    );
    const hasArtistMatch =
      !hasFullMatch &&
      tracks.some(
        (t) =>
          t.artist.toLowerCase().trim() === seedArtist.toLowerCase().trim()
      );
    const matchType = hasFullMatch ? "full" : hasArtistMatch ? "artist" : "artist";

    await db
      .from("episode_seeds")
      .upsert(
        { episode_id: episodeId, seed_id: seedId, match_type: matchType },
        { onConflict: "episode_id,seed_id" }
      );

    // Insert tracks (skip garbage)
    const GARBAGE_TITLES = new Set(["unknown track", "untitled", "id", "?", "unknown", ""]);
    for (let pos = 0; pos < tracks.length; pos++) {
      const track = tracks[pos];
      if (isSameTrack(track, { artist: seedArtist, title: seedTitle }))
        continue;

      const lTitle = track.title.toLowerCase().trim();
      const lArtist = track.artist.toLowerCase().trim();
      if (GARBAGE_TITLES.has(lTitle) || lTitle.length <= 1 || lArtist.length <= 1)
        continue;

      const key = `${lArtist}::${lTitle}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      // Dedup against DB — escape ilike pattern characters
      const escArtist = track.artist.trim().replace(/[%_\\]/g, (c) => `\\${c}`);
      const escTitle = track.title.trim().replace(/[%_\\]/g, (c) => `\\${c}`);
      const { data: existing } = await db
        .from("tracks")
        .select("id")
        .ilike("artist", escArtist)
        .ilike("title", escTitle)
        .limit(1);

      if (existing && existing.length > 0) {
        // Track exists — link it to this episode (it may have been discovered via another)
        existingTrackIds.push(existing[0].id);
        await db
          .from("episode_tracks")
          .upsert(
            { episode_id: episodeId, track_id: existing[0].id, position: pos },
            { onConflict: "episode_id,track_id" }
          );
        continue;
      }

      const { data: inserted, error: insertErr } = await db
        .from("tracks")
        .insert({
          artist: track.artist.trim(),
          title: track.title.trim(),
          source: "nts",
          source_url: episodeUrl,
          source_context: context,
          metadata: { seed_artist: seedArtist, seed_title: seedTitle, discovered_by: "on-demand" },
          status: "pending",
          episode_id: episodeId,
          seed_track_id: seedTrackId || null,
        })
        .select("id")
        .single();

      if (inserted && !insertErr) {
        newTrackIds.push(inserted.id);
        // Link new track to this episode
        await db
          .from("episode_tracks")
          .upsert(
            { episode_id: episodeId, track_id: inserted.id, position: pos },
            { onConflict: "episode_id,track_id" }
          );
      }
    }
  }

  // Create user_tracks for all discovered tracks
  const allTrackIds = Array.from(new Set(newTrackIds.concat(existingTrackIds)));
  const userTracksCreated = await createUserTracks(db, userId, allTrackIds);

  return {
    tracks_found: allTrackIds.length,
    tracks_new: newTrackIds.length,
    tracks_existing: existingTrackIds.length,
    user_tracks_created: userTracksCreated,
    newTrackIds,
    existingTrackIds,
  };
}

async function findLotRadioMatches(
  db: ReturnType<typeof getServiceClient>,
  seedArtist: string,
  seedTitle: string,
  seedId: string,
  seedTrackId: string | null,
): Promise<{ newTrackIds: string[]; existingTrackIds: string[] }> {
  const seedArtistLower = seedArtist.toLowerCase().trim();
  const seedTitleLower = seedTitle.toLowerCase().trim();

  const { data: episodes } = await db
    .from("episodes")
    .select("id, url, title, aired_date, metadata")
    .eq("source", "lotradio")
    .not("metadata", "is", null);

  const newTrackIds: string[] = [];
  const existingTrackIds: string[] = [];
  const seenKeys = new Set<string>();
  const GARBAGE_TITLES = new Set(["unknown track", "untitled", "id", "?", "unknown", ""]);

  for (const ep of episodes || []) {
    const tracklist = (ep.metadata as { tracklist?: Array<{ artist?: string; title?: string }> })?.tracklist || [];
    if (!Array.isArray(tracklist) || tracklist.length === 0) continue;

    const hasMatch = tracklist.some(
      (t) =>
        t.artist?.toLowerCase().trim() === seedArtistLower &&
        t.title?.toLowerCase().trim() === seedTitleLower
    );
    if (!hasMatch) continue;

    // Link episode to seed
    await db
      .from("episode_seeds")
      .upsert(
        { episode_id: ep.id, seed_id: seedId, match_type: "full" },
        { onConflict: "episode_id,seed_id" }
      );

    // Check if episode already has tracks in junction table
    const { data: epTracks, count: trackCount } = await db
      .from("episode_tracks")
      .select("track_id", { count: "exact" })
      .eq("episode_id", ep.id);

    if (trackCount && trackCount > 0) {
      for (const t of epTracks || []) existingTrackIds.push(t.track_id);
      continue;
    }

    // Insert tracks from the pre-crawled tracklist
    for (let pos = 0; pos < tracklist.length; pos++) {
      const track = tracklist[pos];
      const artist = track.artist?.trim() || "";
      const title = track.title?.trim() || "";
      if (!artist || !title) continue;

      // Skip the seed track itself
      if (
        artist.toLowerCase() === seedArtistLower &&
        title.toLowerCase() === seedTitleLower
      ) continue;

      const lArtist = artist.toLowerCase();
      const lTitle = title.toLowerCase();
      if (GARBAGE_TITLES.has(lTitle) || lTitle.length <= 1 || lArtist.length <= 1) continue;

      const key = `${lArtist}::${lTitle}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      const escArtist = artist.replace(/[%_\\]/g, (c) => `\\${c}`);
      const escTitle = title.replace(/[%_\\]/g, (c) => `\\${c}`);
      const { data: existing } = await db
        .from("tracks")
        .select("id")
        .ilike("artist", escArtist)
        .ilike("title", escTitle)
        .limit(1);

      if (existing && existing.length > 0) {
        existingTrackIds.push(existing[0].id);
        await db
          .from("episode_tracks")
          .upsert(
            { episode_id: ep.id, track_id: existing[0].id, position: pos },
            { onConflict: "episode_id,track_id" }
          );
        continue;
      }

      const { data: inserted, error: insertErr } = await db
        .from("tracks")
        .insert({
          artist,
          title,
          source: "lotradio",
          source_url: ep.url,
          source_context: ep.title || ep.url,
          metadata: { seed_artist: seedArtist, seed_title: seedTitle, discovered_by: "on-demand" },
          status: "pending",
          episode_id: ep.id,
          seed_track_id: seedTrackId || null,
        })
        .select("id")
        .single();

      if (inserted && !insertErr) {
        newTrackIds.push(inserted.id);
        await db
          .from("episode_tracks")
          .upsert(
            { episode_id: ep.id, track_id: inserted.id, position: pos },
            { onConflict: "episode_id,track_id" }
          );
      }
    }
  }

  return { newTrackIds, existingTrackIds };
}

async function createUserTracks(
  db: ReturnType<typeof getServiceClient>,
  userId: string,
  trackIds: string[]
): Promise<number> {
  if (trackIds.length === 0) return 0;

  // Check which user_tracks already exist
  const { data: existing } = await db
    .from("user_tracks")
    .select("track_id")
    .eq("user_id", userId)
    .in("track_id", trackIds);

  const existingSet = new Set(
    (existing || []).map((ut: { track_id: string }) => ut.track_id)
  );
  const toCreate = trackIds.filter((id) => !existingSet.has(id));

  if (toCreate.length === 0) return 0;

  // Batch insert in chunks of 50
  let created = 0;
  for (let i = 0; i < toCreate.length; i += 50) {
    const batch = toCreate.slice(i, i + 50).map((track_id) => ({
      user_id: userId,
      track_id,
      status: "pending",
    }));

    const { error } = await db.from("user_tracks").insert(batch);
    if (!error) created += batch.length;
  }

  return created;
}
