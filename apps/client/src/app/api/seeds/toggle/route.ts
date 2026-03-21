import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// POST /api/seeds/toggle — create or remove a re-seed for a track
export async function POST(req: NextRequest) {
  const db = getServiceClient();
  const { track_id, artist, title } = await req.json();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return req.cookies.getAll();
        },
        setAll() {
          // Route only needs read access to auth cookies here.
        },
      },
    }
  );
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!artist || !title) {
    return NextResponse.json({ error: "artist and title required" }, { status: 400 });
  }

  // Re-seeds are stored as user-owned seed rows so they don't collide with shared base seeds.
  let existingSeed: { id: string } | null = null;

  if (track_id) {
    const { data } = await db
      .from("seeds")
      .select("id")
      .eq("user_id", user.id)
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
      .eq("user_id", user.id)
      .eq("source", "re-seed")
      .ilike("artist", escArtist)
      .ilike("title", escTitle)
      .limit(1)
      .maybeSingle();
    existingSeed = data;
  }

  if (existingSeed) {
    // Remove it
    await db.from("seeds").delete().eq("id", existingSeed.id);
    // Clear re-seed flag on the matching track
    if (track_id) {
      await db.from("tracks").update({ is_re_seed: false }).eq("id", track_id);
    } else {
      await db
        .from("tracks")
        .update({ is_re_seed: false })
        .ilike("artist", artist.trim())
        .ilike("title", title.trim());
    }
    return NextResponse.json({ action: "removed", seed_id: existingSeed.id });
  }

  // Create new re-seed
  const { data: newSeed, error } = await db
    .from("seeds")
    .insert({
      artist: artist.trim(),
      title: title.trim(),
      track_id: track_id || null,
      user_id: user.id,
      source: "re-seed",
    })
    .select("id")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Mark the track as a re-seed
  if (track_id) {
    await db.from("tracks").update({ is_re_seed: true }).eq("id", track_id);
  } else {
    await db
      .from("tracks")
      .update({ is_re_seed: true })
      .ilike("artist", artist.trim())
      .ilike("title", title.trim());
  }

  let discoverTriggered = false;
  let discoverError: string | null = null;

  try {
    const discoverUrl = new URL("/api/discover", req.url);
    const response = await fetch(discoverUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        seed_id: newSeed.id,
        user_id: user.id,
      }),
    });
    discoverTriggered = response.ok;
    if (!response.ok) {
      discoverError = await response.text();
    }
  } catch (err) {
    discoverError = err instanceof Error ? err.message : String(err);
  }

  return NextResponse.json(
    {
      action: "created",
      seed_id: newSeed.id,
      discover_triggered: discoverTriggered,
      discover_error: discoverError,
    },
    { status: 201 }
  );
}
