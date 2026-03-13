import { NextRequest, NextResponse } from "next/server";
import { supabase, getServiceClient } from "@/lib/supabase";

// GET /api/tracks?status=pending&limit=20
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const status = searchParams.get("status") || "pending";
  const limit = parseInt(searchParams.get("limit") || "20", 10);
  const offset = parseInt(searchParams.get("offset") || "0", 10);
  const search = searchParams.get("search");
  const source = searchParams.get("source");
  const episodeId = searchParams.get("episode_id");

  let query = supabase
    .from("tracks")
    .select("*", { count: "exact" })
    .eq("status", status)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (episodeId) {
    query = query.eq("episode_id", episodeId);
  }
  if (search) {
    // Escape special ilike pattern characters
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

  // Generate fresh signed URLs for tracks with audio in storage
  const tracks = data || [];
  for (const track of tracks) {
    if (track.storage_path) {
      const { data: signed } = await supabase.storage
        .from("tracks")
        .createSignedUrl(track.storage_path, 3600); // 1 hour
      if (signed) {
        track.audio_url = signed.signedUrl;
      }
    }
  }

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

    // Dedup check: artist + title
    const { data: existing } = await client
      .from("tracks")
      .select("id")
      .ilike("artist", track.artist)
      .ilike("title", track.title)
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
