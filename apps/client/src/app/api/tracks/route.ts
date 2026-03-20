import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { supabase, getServiceClient } from "@/lib/supabase";
import { diversifyTracks } from "@/lib/diversify";

export const dynamic = "force-dynamic";

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

function getAuthClient(req: NextRequest) {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return req.cookies.getAll(); },
        setAll() {},
      },
    }
  );
}

// Normalize track joins and generate signed URLs
async function normalizeAndSign(tracks: any[]) {
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
    const meta = (track.metadata || {}) as Record<string, unknown>;
    track._score_components = (meta._score_components as Record<string, number>) || {};
    track._ranked_score = track.taste_score ?? 0;
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
}

// Paginated fetch of track_ids from user_tracks by status
async function getUserTrackIds(db: ReturnType<typeof getServiceClient>, userId: string, statuses: string[]): Promise<string[]> {
  const ids: string[] = [];
  let page = 0;
  while (true) {
    const { data: batch } = await db
      .from("user_tracks")
      .select("track_id")
      .eq("user_id", userId)
      .in("status", statuses)
      .range(page * 1000, (page + 1) * 1000 - 1);
    if (!batch || batch.length === 0) break;
    ids.push(...batch.map((r: any) => r.track_id));
    if (batch.length < 1000) break;
    page++;
  }
  return ids;
}

// GET /api/tracks?status=pending&limit=20
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

  // Get current user
  const auth = getAuthClient(req);
  const { data: { user } } = await auth.auth.getUser();

  const db = getServiceClient();

  // When episode_id is set, fetch ALL tracks in episode order (not filtered by status)
  if (episodeId) {
    const { data: etLinks } = await db
      .from("episode_tracks")
      .select("track_id, position")
      .eq("episode_id", episodeId)
      .order("position", { ascending: true, nullsFirst: false });

    const trackIdsForEpisode = (etLinks || []).map((r: any) => r.track_id);
    if (trackIdsForEpisode.length === 0) {
      return NextResponse.json({ tracks: [], total: 0 });
    }

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

    const tracks = (data || []).sort((a: any, b: any) =>
      (orderMap.get(a.id) ?? 999) - (orderMap.get(b.id) ?? 999)
    );

    await normalizeAndSign(tracks);
    await attachMatchTypes(tracks);
    return NextResponse.json({ tracks, total: count });
  }

  // Super-liked tab: resolve track IDs from user_tracks for current user
  if (status === "super_liked") {
    let utQuery = db
      .from("user_tracks")
      .select("track_id")
      .eq("super_liked", true);
    if (user) utQuery = utQuery.eq("user_id", user.id);
    const { data: utRows, error: utError } = await utQuery
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
    await normalizeAndSign(tracks);
    return NextResponse.json({ tracks, total: superLikedIds.length });
  }

  // ── User-isolated status views ──────────────────────────────────────────

  // For approved/rejected: fetch from user_tracks, then load those tracks
  if (user && (status === "approved" || status === "rejected")) {
    const utIds = await getUserTrackIds(db, user.id, [status]);
    if (utIds.length === 0) return NextResponse.json({ tracks: [], total: 0 });

    const paged = utIds.slice(offset, offset + limit);
    let query = supabase
      .from("tracks")
      .select("*, seed_track:tracks!seed_track_id(artist, title), episode:episodes!episode_id(id, title, source, aired_date, artwork_url, url), seeds!track_id(id)")
      .in("id", paged);

    if (search) {
      const escaped = search.replace(/[%_\\]/g, (c) => `\\${c}`);
      query = query.or(`artist.ilike.%${escaped}%,title.ilike.%${escaped}%`);
    }
    if (source) query = query.eq("source", source);
    if (genre) query = query.contains("metadata", { genres: [genre] });

    const { data, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const tracks = data || [];
    // Overlay user status
    for (const t of tracks) {
      (t as any).status = status;
    }
    await normalizeAndSign(tracks);
    await attachMatchTypes(tracks);
    return NextResponse.json({ tracks, total: utIds.length });
  }

  // For pending: fetch tracks the user HASN'T voted on
  // Get all track_ids this user has voted on (any non-pending status)
  let excludedTrackIds = new Set<string>();
  if (user && isPending) {
    const votedIds = await getUserTrackIds(db, user.id, ["approved", "rejected", "skipped", "listened"]);
    excludedTrackIds = new Set(votedIds);
  }

  const orderCol = orderBy === "taste_score"
    ? "taste_score"
    : isPending ? "created_at" : "created_at";

  let query = supabase
    .from("tracks")
    .select("*, seed_track:tracks!seed_track_id(artist, title), episode:episodes!episode_id(id, title, source, aired_date, artwork_url, url), seeds!track_id(id)", { count: "exact" });

  // For pending: don't filter by tracks.status (it's always 'pending' in the pipeline sense)
  // Instead we rely on excluding voted tracks above
  if (isPending) {
    // Only show tracks that are pipeline-pending (not failed/skipped)
    query = query.eq("status", "pending");
    query = query.or("storage_path.not.is.null,spotify_url.neq.,preview_url.not.is.null");
  } else {
    // Fallback for any other status value
    query = query.eq("status", status);
  }

  const ascending = orderBy === "taste_score" ? false : isPending;
  const fetchLimit = orderBy === "taste_score" ? limit * 2 : limit;
  query = query.order(orderCol, { ascending, nullsFirst: false })
    .range(offset, offset + fetchLimit - 1);
  if (search) {
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

  // Filter out user's voted tracks
  const tracks = (data || []).filter((t: any) => !excludedTrackIds.has(t.id));

  await normalizeAndSign(tracks);

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
