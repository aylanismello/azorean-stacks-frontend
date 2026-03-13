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

  // Get episodes linked to each seed via episode_seeds
  const seedIds = (data || []).map((s) => s.id);
  let episodesBySeed: Record<string, Array<{ id: string; title: string | null; url: string; source: string; aired_date: string | null }>> = {};

  if (seedIds.length > 0) {
    const { data: episodeLinks } = await supabase
      .from("episode_seeds")
      .select("seed_id, episodes(id, title, url, source, aired_date)")
      .in("seed_id", seedIds);

    (episodeLinks || []).forEach((link: any) => {
      if (!link.episodes) return;
      if (!episodesBySeed[link.seed_id]) episodesBySeed[link.seed_id] = [];
      episodesBySeed[link.seed_id].push(link.episodes);
    });
  }

  // Get latest discovery run per seed
  const { data: runs } = await supabase
    .from("discovery_runs")
    .select("seed_id, tracks_found, tracks_added, started_at")
    .in("seed_id", seedIds)
    .order("started_at", { ascending: false });

  const lastRunBySeed: Record<string, { tracks_found: number; tracks_added: number; started_at: string }> = {};
  (runs || []).forEach((r: any) => {
    if (r.seed_id && !lastRunBySeed[r.seed_id]) {
      lastRunBySeed[r.seed_id] = { tracks_found: r.tracks_found, tracks_added: r.tracks_added, started_at: r.started_at };
    }
  });

  const seedsWithCounts = (data || []).map((seed) => ({
    ...seed,
    discovery_count: seed.track_id ? (trackCounts[seed.track_id] || 0) : 0,
    episodes: episodesBySeed[seed.id] || [],
    last_run: lastRunBySeed[seed.id] || null,
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
