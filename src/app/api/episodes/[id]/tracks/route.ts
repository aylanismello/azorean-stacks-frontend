import { NextRequest, NextResponse } from "next/server";
import { supabase, getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// GET /api/episodes/[id]/tracks
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const db = getServiceClient();
  // Query through episode_tracks junction table, order by tracklist position
  const { data: junctionRows, error } = await db
    .from("episode_tracks")
    .select("position, tracks(id, artist, title, status, spotify_url, youtube_url, storage_path, cover_art_url, preview_url, dl_attempts, dl_failed_at)")
    .eq("episode_id", params.id)
    .order("position", { ascending: true, nullsFirst: false });

  // Flatten: extract the nested track object from each junction row
  const data = (junctionRows || [])
    .map((row: any) => row.tracks)
    .filter(Boolean);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Generate signed URLs for tracks with storage_path
  const tracks = data || [];
  const signPromises: Promise<void>[] = [];

  for (const track of tracks) {
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
