import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

// GET /api/seeds
export async function GET() {
  const { data, error } = await supabase
    .from("seeds")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Get discovery counts — batch query all tracks with seed_track_ids in one go
  const seedTrackIds = (data || [])
    .map((s) => s.track_id)
    .filter(Boolean);

  let trackCounts: Record<string, number> = {};

  if (seedTrackIds.length > 0) {
    const { data: tracks } = await supabase
      .from("tracks")
      .select("seed_track_id")
      .in("seed_track_id", seedTrackIds);

    (tracks || []).forEach((t) => {
      if (t.seed_track_id) {
        trackCounts[t.seed_track_id] = (trackCounts[t.seed_track_id] || 0) + 1;
      }
    });
  }

  const seedsWithCounts = (data || []).map((seed) => ({
    ...seed,
    discovery_count: seed.track_id ? (trackCounts[seed.track_id] || 0) : 0,
  }));

  return NextResponse.json(seedsWithCounts);
}

// POST /api/seeds
export async function POST(req: NextRequest) {
  const { artist, title } = await req.json();

  if (!artist?.trim() || !title?.trim()) {
    return NextResponse.json(
      { error: "Artist and title are required" },
      { status: 400 }
    );
  }

  // Optionally link to existing track
  const { data: existingTrack } = await supabase
    .from("tracks")
    .select("id")
    .ilike("artist", artist.trim())
    .ilike("title", title.trim())
    .limit(1)
    .maybeSingle();

  const { data, error } = await supabase
    .from("seeds")
    .insert({
      artist: artist.trim(),
      title: title.trim(),
      track_id: existingTrack?.id || null,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data, { status: 201 });
}
