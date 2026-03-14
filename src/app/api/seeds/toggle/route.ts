import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// POST /api/seeds/toggle — create or remove a re-seed for a track
export async function POST(req: NextRequest) {
  const db = getServiceClient();
  const { track_id, artist, title } = await req.json();

  if (!artist || !title) {
    return NextResponse.json({ error: "artist and title required" }, { status: 400 });
  }

  // Check if seed already exists — by track_id first, then artist+title
  let existingSeed: { id: string } | null = null;

  if (track_id) {
    const { data } = await db
      .from("seeds")
      .select("id")
      .eq("track_id", track_id)
      .limit(1)
      .maybeSingle();
    existingSeed = data;
  }

  if (!existingSeed) {
    const escArtist = artist.trim().replace(/[%_\\]/g, (c: string) => `\\${c}`);
    const escTitle = title.trim().replace(/[%_\\]/g, (c: string) => `\\${c}`);
    const { data } = await db
      .from("seeds")
      .select("id")
      .ilike("artist", escArtist)
      .ilike("title", escTitle)
      .limit(1)
      .maybeSingle();
    existingSeed = data;
  }

  if (existingSeed) {
    // Remove it
    await db.from("seeds").delete().eq("id", existingSeed.id);
    return NextResponse.json({ action: "removed", seed_id: existingSeed.id });
  }

  // Create new re-seed
  const { data: newSeed, error } = await db
    .from("seeds")
    .insert({
      artist: artist.trim(),
      title: title.trim(),
      track_id: track_id || null,
      source: "re-seed",
    })
    .select("id")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ action: "created", seed_id: newSeed.id }, { status: 201 });
}
