import { NextRequest, NextResponse } from "next/server";
import { supabase, getServiceClient } from "@/lib/supabase";
import { createServerClient } from "@supabase/ssr";

export const dynamic = "force-dynamic";

// GET /api/episodes/[id]/tracks
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const db = getServiceClient();
  // Query through episode_tracks junction table, order by tracklist position
  // Include seed_track_id so we can identify the seed track in the tracklist
  const { data: junctionRows, error } = await db
    .from("episode_tracks")
    .select("position, tracks(id, artist, title, status, spotify_url, youtube_url, storage_path, cover_art_url, preview_url, dl_attempts, dl_failed_at, seed_track_id)")
    .eq("episode_id", params.id)
    .order("position", { ascending: true, nullsFirst: false });

  // Flatten: extract the nested track object from each junction row
  const data = (junctionRows || [])
    .map((row: any) => row.tracks)
    .filter(Boolean);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Look up which seeds are connected to this episode
  const { data: episodeSeedRows } = await db
    .from("episode_seeds")
    .select("seed_id, match_type, seeds(id, artist, title, track_id)")
    .eq("episode_id", params.id);

  // Build a set of seed track IDs (the actual track that is a seed)
  // and a map of seed_track_id → seed info for re-seeds
  const seedTrackIds = new Set<string>();
  const reSeedTrackIds = new Set<string>(); // tracks that are seeds via re-seed (source = 're-seed')
  for (const row of (episodeSeedRows || []) as any[]) {
    const seed = Array.isArray(row.seeds) ? row.seeds[0] : row.seeds;
    if (seed?.track_id) {
      seedTrackIds.add(seed.track_id);
    }
  }

  // Check which tracks have been re-seeded (are seeds themselves)
  const trackIds = data.map((t: any) => t.id);
  if (trackIds.length > 0) {
    const { data: seedRows } = await db
      .from("seeds")
      .select("track_id, source")
      .in("track_id", trackIds);
    for (const s of (seedRows || []) as any[]) {
      if (s.source === "re-seed") {
        reSeedTrackIds.add(s.track_id);
      } else {
        seedTrackIds.add(s.track_id);
      }
    }
  }

  // Get super_liked status from user_tracks (try to get authed user)
  const superLikedIds = new Set<string>();
  try {
    const authClient = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() { return req.cookies.getAll(); },
          setAll() {},
        },
      }
    );
    const { data: { user } } = await authClient.auth.getUser();
    if (user && trackIds.length > 0) {
      const { data: utRows } = await db
        .from("user_tracks")
        .select("track_id")
        .eq("user_id", user.id)
        .eq("super_liked", true)
        .in("track_id", trackIds);
      for (const ut of (utRows || []) as any[]) {
        superLikedIds.add(ut.track_id);
      }
    }
  } catch {}

  // Generate signed URLs for tracks with storage_path
  const tracks = data || [];
  const signPromises: Promise<void>[] = [];

  for (const track of tracks) {
    // Add seed/re-seed/super_liked flags
    (track as any).is_seed = seedTrackIds.has(track.id);
    (track as any).is_re_seed = reSeedTrackIds.has(track.id);
    (track as any).super_liked = superLikedIds.has(track.id);

    if (track.storage_path) {
      signPromises.push(
        supabase.storage
          .from("tracks")
          .createSignedUrl(track.storage_path, 3600)
          .then(({ data: signed }) => {
            if (signed) (track as any).audio_url = signed.signedUrl;
          })
      );
    }
  }

  await Promise.all(signPromises);

  return NextResponse.json(tracks);
}
