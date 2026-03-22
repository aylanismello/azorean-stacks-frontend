import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
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
    .select("position, tracks(id, artist, title, status, spotify_url, youtube_url, storage_path, cover_art_url, preview_url, dl_attempts, dl_failed_at, seed_track_id, is_seed, is_re_seed, is_artist_seed)")
    .eq("episode_id", params.id)
    .order("position", { ascending: true, nullsFirst: false });

  // Flatten: extract the nested track object from each junction row
  const data = (junctionRows || [])
    .map((row: any) => row.tracks)
    .filter(Boolean);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const trackIds = data.map((t: any) => t.id);

  // Get super_liked + vote status from user_tracks (try to get authed user)
  const superLikedIds = new Set<string>();
  const voteStatusMap = new Map<string, string>();
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
        .select("track_id, super_liked, status")
        .eq("user_id", user.id)
        .in("track_id", trackIds);
      for (const ut of (utRows || []) as any[]) {
        if (ut.super_liked) superLikedIds.add(ut.track_id);
        if (ut.status) voteStatusMap.set(ut.track_id, ut.status);
      }
    }
  } catch {}

  // Generate signed URLs for tracks with storage_path
  const tracks = data || [];
  const signPromises: Promise<void>[] = [];

  for (const track of tracks) {
    // Seed flags come directly from tracks table columns
    (track as any).super_liked = superLikedIds.has(track.id);
    (track as any).vote_status = voteStatusMap.get(track.id) || null;

    if (track.storage_path) {
      signPromises.push(
        db.storage
          .from("tracks")
          .createSignedUrl(track.storage_path, 3600)
          .then(({ data: signed }) => {
            if (signed) (track as any).audio_url = signed.signedUrl;
          })
          .catch(() => {}) // individual sign failure shouldn't break the tracklist
      );
    }
  }

  await Promise.all(signPromises);

  return NextResponse.json(tracks);
}
