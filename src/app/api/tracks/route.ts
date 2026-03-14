import { NextRequest, NextResponse } from "next/server";
import { supabase, getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

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
      .select("*, seed_track:tracks!seed_track_id(artist, title), episode:episodes!episode_id(id, title, source, aired_date, artwork_url), seeds!track_id(id)", { count: "exact" })
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
    return NextResponse.json({ tracks, total: count });
  }

  let query = supabase
    .from("tracks")
    .select("*, seed_track:tracks!seed_track_id(artist, title), episode:episodes!episode_id(id, title, source, aired_date, artwork_url), seeds!track_id(id)", { count: "exact" });

  query = query.eq("status", status);

  // taste_score: highest first; created_at for pending: oldest first; voted_at: newest first
  const ascending = orderBy === "taste_score" ? false : isPending;
  query = query.order(orderCol, { ascending, nullsFirst: false })
    .range(offset, offset + limit - 1);
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

  return NextResponse.json({ tracks, total: count });
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
