import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

// GET /api/tracks/[id]/download — get download URL
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const { data: track, error } = await supabase
    .from("tracks")
    .select("id, storage_path, download_url, artist, title")
    .eq("id", params.id)
    .single();

  if (error || !track) {
    return NextResponse.json({ error: "Track not found" }, { status: 404 });
  }

  // If we have a file in Supabase Storage, generate a signed URL
  if (track.storage_path) {
    const { data: signed, error: signError } = await supabase.storage
      .from("tracks")
      .createSignedUrl(track.storage_path, 3600); // 1 hour

    if (signError || !signed) {
      return NextResponse.json(
        { error: "Failed to generate download URL" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      url: signed.signedUrl,
      filename: `${track.artist} - ${track.title}`.replace(/[/\\?%*:|"<>]/g, ""),
    });
  }

  // If we have an external download URL
  if (track.download_url) {
    return NextResponse.json({
      url: track.download_url,
      filename: `${track.artist} - ${track.title}`.replace(/[/\\?%*:|"<>]/g, ""),
    });
  }

  return NextResponse.json(
    { error: "No download available yet", queued: true },
    { status: 202 }
  );
}
