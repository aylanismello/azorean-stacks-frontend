import { NextRequest, NextResponse } from "next/server";
import { supabase, getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// Reorder tracks to avoid repetition: no more than 2 consecutive from same episode,
// no more than 3 from same seed_artist, and sprinkle unscored wildcards every 5th slot.
function diversifyTracks(tracks: any[]): any[] {
  const scored = tracks.filter((t) => t.taste_score != null && t.taste_score !== 0);
  const unscored = tracks.filter((t) => t.taste_score == null || t.taste_score === 0);

  const result: any[] = [];
  const pool = [...scored];
  let unscoredIdx = 0;
  let consecEpId: string | null = null;
  let consecEpCount = 0;
  let consecSeed: string | null = null;
  let consecSeedCount = 0;

  while (pool.length > 0) {
    // Insert unscored wildcard at every 5th position (indices 4, 9, 14…)
    if (result.length > 0 && result.length % 5 === 4 && unscoredIdx < unscored.length) {
      const u = unscored[unscoredIdx++];
      result.push(u);
      consecEpId = u.episode_id || null;
      consecEpCount = 1;
      consecSeed = (u.metadata?.seed_artist as string) || null;
      consecSeedCount = 1;
      continue;
    }

    // Find first pool track that doesn't violate consecutive constraints
    let idx = -1;
    for (let i = 0; i < pool.length; i++) {
      const t = pool[i];
      const epId = t.episode_id || null;
      const seed = (t.metadata?.seed_artist as string) || null;
      const episodeViolation = epId !== null && epId === consecEpId && consecEpCount >= 2;
      const seedViolation = seed !== null && seed === consecSeed && consecSeedCount >= 3;
      if (!episodeViolation && !seedViolation) {
        idx = i;
        break;
      }
    }
    if (idx === -1) idx = 0; // fallback — can't satisfy constraints

    const [track] = pool.splice(idx, 1);
    result.push(track);

    const epId = track.episode_id || null;
    const seed = (track.metadata?.seed_artist as string) || null;
    if (epId !== null && epId === consecEpId) consecEpCount++;
    else { consecEpId = epId; consecEpCount = 1; }
    if (seed !== null && seed === consecSeed) consecSeedCount++;
    else { consecSeed = seed; consecSeedCount = 1; }
  }

  result.push(...unscored.slice(unscoredIdx));
  return result;
}

// Enrich tracks with episode_seeds match_type for discovery method differentiation
async function attachMatchTypes(tracks: any[]) {
  const episodeIds = Array.from(new Set(tracks.map((t: any) => t.episode_id).filter(Boolean)));
  if (episodeIds.length === 0) return;

  const { data: esLinks } = await supabase
    .from("episode_seeds")
    .select("episode_id, match_type")
    .in("episode_id", episodeIds);

  if (!esLinks?.length) return;

  // Per episode, prefer 'full' over 'artist' over 'unknown'
  const matchTypeMap = new Map<string, string>();
  for (const link of esLinks) {
    const existing = matchTypeMap.get(link.episode_id);
    if (!existing || link.match_type === "full") {
      matchTypeMap.set(link.episode_id, link.match_type || "unknown");
    }
  }

  for (const track of tracks) {
    if (track.episode_id && matchTypeMap.has(track.episode_id)) {
      track._match_type = matchTypeMap.get(track.episode_id);
    }
  }
}

// GET /api/tracks?status=pending&limit=20
// TODO(user-isolation): When multi-user taste scoring is implemented, add per-user filtering
// here so that status, taste_score, and super_liked queries are scoped to the authenticated user.
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const status = searchParams.get("status") || "pending";
  const limit = parseInt(searchParams.get("limit") || "20", 10);
  const offset = parseInt(searchParams.get("offset") || "0", 10);
  const search = searchParams.get("search");
  const source = searchParams.get("source");
  const episodeId = searchParams.get("episode_id");
  const orderBy = searchParams.get("order_by"); // "taste_score" or default
  const hideLow = searchParams.get("hide_low") === "true";
  const genre = searchParams.get("genre");
  const seedId = searchParams.get("seed_id");
  const seedArtist = searchParams.get("seed_artist");

  const isPending = status === "pending";
  const orderCol = orderBy === "taste_score"
    ? "taste_score"
    : isPending ? "created_at" : status === "approved" || status === "rejected" ? "voted_at" : "created_at";

  // When episode_id is set, fetch ALL tracks in episode order (not filtered by status)
  if (episodeId) {
    const db = getServiceClient();
    const { data: etLinks } = await db
      .from("episode_tracks")
      .select("track_id, position")
      .eq("episode_id", episodeId)
      .order("position", { ascending: true, nullsFirst: false });

    const trackIdsForEpisode = (etLinks || []).map((r: any) => r.track_id);
    if (trackIdsForEpisode.length === 0) {
      return NextResponse.json({ tracks: [], total: 0 });
    }

    // Build an order map from the junction query (already sorted by position)
    const orderMap = new Map(trackIdsForEpisode.map((id: string, i: number) => [id, i]));

    let query = supabase
      .from("tracks")
      .select("*, seed_track:tracks!seed_track_id(artist, title), episode:episodes!episode_id(id, title, source, aired_date, artwork_url, url), seeds!track_id(id)", { count: "exact" })
      .in("id", trackIdsForEpisode);

    if (search) {
      const escaped = search.replace(/[%_\\]/g, (c) => `\\${c}`);
      query = query.or(`artist.ilike.%${escaped}%,title.ilike.%${escaped}%`);
    }
    if (source) {
      query = query.eq("source", source);
    }

    const { data, error, count } = await query;
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Sort by junction table order (preserves position + insertion order for null positions)
    const tracks = (data || []).sort((a: any, b: any) =>
      (orderMap.get(a.id) ?? 999) - (orderMap.get(b.id) ?? 999)
    );

    const signPromises: Promise<void>[] = [];
    for (const track of tracks) {
      if (Array.isArray(track.seed_track)) {
        track.seed_track = track.seed_track[0] || null;
      }
      if (track.seed_track && !track.seed_track.artist) {
        track.seed_track = null;
      }
      if (Array.isArray(track.episode)) {
        track.episode = track.episode[0] || null;
      }
      const seedArr = Array.isArray(track.seeds) ? track.seeds : [];
      track.seed_id = seedArr.length > 0 ? seedArr[0].id : null;
      delete track.seeds;
      if (track.storage_path) {
        signPromises.push(
          supabase.storage
            .from("tracks")
            .createSignedUrl(track.storage_path, 3600)
            .then(({ data: signed }) => {
              if (signed) track.audio_url = signed.signedUrl;
            })
        );
      }
    }
    await Promise.all(signPromises);
    await attachMatchTypes(tracks);
    return NextResponse.json({ tracks, total: count });
  }

  // Super-liked tab: resolve track IDs from user_tracks, then fetch tracks
  if (status === "super_liked") {
    const db = getServiceClient();
    const { data: utRows, error: utError } = await db
      .from("user_tracks")
      .select("track_id")
      .eq("super_liked", true)
      .order("voted_at", { ascending: false });

    if (utError) return NextResponse.json({ error: utError.message }, { status: 500 });

    const superLikedIds = (utRows || []).map((r: any) => r.track_id);
    if (superLikedIds.length === 0) return NextResponse.json({ tracks: [], total: 0 });

    const paged = superLikedIds.slice(offset, offset + limit);
    const { data, error } = await supabase
      .from("tracks")
      .select("*, seed_track:tracks!seed_track_id(artist, title), episode:episodes!episode_id(id, title, source, aired_date, artwork_url, url), seeds!track_id(id)")
      .in("id", paged);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const tracks = (data || []).sort((a: any, b: any) => superLikedIds.indexOf(a.id) - superLikedIds.indexOf(b.id));
    const signPromises: Promise<void>[] = [];
    for (const track of tracks) {
      if (Array.isArray(track.seed_track)) track.seed_track = track.seed_track[0] || null;
      if (track.seed_track && !track.seed_track.artist) track.seed_track = null;
      if (Array.isArray(track.episode)) track.episode = track.episode[0] || null;
      const seedArr = Array.isArray(track.seeds) ? track.seeds : [];
      track.seed_id = seedArr.length > 0 ? seedArr[0].id : null;
      delete track.seeds;
      if (track.storage_path) {
        signPromises.push(
          supabase.storage.from("tracks").createSignedUrl(track.storage_path, 3600)
            .then(({ data: signed }) => { if (signed) track.audio_url = signed.signedUrl; })
        );
      }
    }
    await Promise.all(signPromises);
    return NextResponse.json({ tracks, total: superLikedIds.length });
  }

  let query = supabase
    .from("tracks")
    .select("*, seed_track:tracks!seed_track_id(artist, title), episode:episodes!episode_id(id, title, source, aired_date, artwork_url, url), seeds!track_id(id)", { count: "exact" });

  query = query.eq("status", status);

  // Only return playable tracks for pending queries (has storage_path, spotify_url, or preview_url)
  if (isPending) {
    query = query.or("storage_path.not.is.null,spotify_url.neq.,preview_url.not.is.null");
  }

  // taste_score: highest first; created_at for pending: oldest first; voted_at: newest first
  const ascending = orderBy === "taste_score" ? false : isPending;
  // In taste mode fetch double the limit so diversification has enough material to work with
  const fetchLimit = orderBy === "taste_score" ? limit * 2 : limit;
  query = query.order(orderCol, { ascending, nullsFirst: false })
    .range(offset, offset + fetchLimit - 1);
  if (search) {
    // Escape special ilike pattern characters
    const escaped = search.replace(/[%_\\]/g, (c) => `\\${c}`);
    query = query.or(`artist.ilike.%${escaped}%,title.ilike.%${escaped}%`);
  }
  if (source) {
    query = query.eq("source", source);
  }
  if (genre) {
    query = query.contains("metadata", { genres: [genre] });
  }
  if (seedId) {
    query = query.eq("seed_track_id", seedId);
  }
  if (seedArtist) {
    query = query.contains("metadata", { seed_artist: seedArtist });
  }
  if (hideLow && orderBy === "taste_score") {
    query = query.gt("taste_score", -0.3);
  }

  const { data, error, count } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Normalize joins & generate signed URLs in parallel
  const tracks = data || [];
  const signPromises: Promise<void>[] = [];

  for (const track of tracks) {
    // Self-referential join can return [] instead of null — normalize
    if (Array.isArray(track.seed_track)) {
      track.seed_track = track.seed_track[0] || null;
    }
    if (track.seed_track && !track.seed_track.artist) {
      track.seed_track = null;
    }
    // Normalize episode join
    if (Array.isArray(track.episode)) {
      track.episode = track.episode[0] || null;
    }
    // Normalize seeds join → boolean is_seeded + seed_id
    const seedArr = Array.isArray(track.seeds) ? track.seeds : [];
    track.seed_id = seedArr.length > 0 ? seedArr[0].id : null;
    delete track.seeds;
    if (track.storage_path) {
      signPromises.push(
        supabase.storage
          .from("tracks")
          .createSignedUrl(track.storage_path, 3600)
          .then(({ data: signed }) => {
            if (signed) track.audio_url = signed.signedUrl;
          })
      );
    }
  }

  await Promise.all(signPromises);

  // Apply diversification in taste mode then trim to requested limit
  const finalTracks = orderBy === "taste_score"
    ? diversifyTracks(tracks).slice(0, limit)
    : tracks;

  await attachMatchTypes(finalTracks);

  return NextResponse.json({ tracks: finalTracks, total: count });
}

// POST /api/tracks — agent pushes new discoveries (service role)
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // Simple auth: require service role key as bearer token
  if (!authHeader || authHeader !== `Bearer ${serviceKey}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const tracks: Array<{
    artist: string;
    title: string;
    source: string;
    source_url?: string;
    source_context?: string;
    seed_track_id?: string;
    preview_url?: string;
    cover_art_url?: string;
    metadata?: Record<string, unknown>;
  }> = Array.isArray(body) ? body : [body];

  const client = getServiceClient();
  const results = { added: 0, skipped: 0, errors: [] as string[] };

  for (const track of tracks) {
    if (!track.artist || !track.title || !track.source) {
      results.errors.push(`Missing required fields: ${JSON.stringify(track)}`);
      continue;
    }

    // Dedup check: artist + title (escape ilike pattern chars)
    const escArt = track.artist.replace(/[%_\\]/g, (c: string) => `\\${c}`);
    const escTtl = track.title.replace(/[%_\\]/g, (c: string) => `\\${c}`);
    const { data: existing } = await client
      .from("tracks")
      .select("id")
      .ilike("artist", escArt)
      .ilike("title", escTtl)
      .limit(1);

    if (existing && existing.length > 0) {
      results.skipped++;
      continue;
    }

    const { error } = await client.from("tracks").insert({
      artist: track.artist,
      title: track.title,
      source: track.source,
      source_url: track.source_url || null,
      source_context: track.source_context || null,
      seed_track_id: track.seed_track_id || null,
      preview_url: track.preview_url || null,
      cover_art_url: track.cover_art_url || null,
      metadata: track.metadata || {},
    });

    if (error) {
      results.errors.push(error.message);
    } else {
      results.added++;
    }
  }

  return NextResponse.json(results, { status: 201 });
}
