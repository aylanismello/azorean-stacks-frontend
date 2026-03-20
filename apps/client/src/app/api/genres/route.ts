import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// GET /api/genres — returns genres with pending track counts for this user
export async function GET(req: NextRequest) {
  const db = getServiceClient();

  // Auth for per-user filtering
  const auth = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return req.cookies.getAll(); },
        setAll() {},
      },
    }
  );
  const { data: { user } } = await auth.auth.getUser();

  // Get user's voted track IDs to exclude
  let votedTrackIds = new Set<string>();
  if (user) {
    let page = 0;
    while (true) {
      const { data: batch } = await db
        .from("user_tracks")
        .select("track_id")
        .eq("user_id", user.id)
        .in("status", ["approved", "rejected", "skipped", "listened"])
        .range(page * 1000, (page + 1) * 1000 - 1);
      if (!batch || batch.length === 0) break;
      for (const r of batch) votedTrackIds.add((r as any).track_id);
      if (batch.length < 1000) break;
      page++;
    }
  }

  // Fetch pipeline-pending tracks that have genres
  const allTracks: any[] = [];
  let page = 0;
  while (true) {
    const { data, error } = await db
      .from("tracks")
      .select("id, metadata->genres")
      .eq("status", "pending")
      .not("metadata->genres", "is", null)
      .range(page * 1000, (page + 1) * 1000 - 1);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (!data || data.length === 0) break;
    allTracks.push(...data);
    if (data.length < 1000) break;
    page++;
  }

  // Count genre occurrences across tracks the user hasn't voted on
  const counts = new Map<string, number>();
  for (const track of allTracks) {
    if (votedTrackIds.has(track.id)) continue;
    const genres = track.genres;
    if (!Array.isArray(genres)) continue;
    for (const g of genres) {
      if (typeof g === "string") {
        counts.set(g, (counts.get(g) || 0) + 1);
      }
    }
  }

  // Return genres with 20+ pending tracks, sorted by count
  const genres = Array.from(counts.entries())
    .filter(([, count]) => count >= 20)
    .sort((a, b) => b[1] - a[1])
    .map(([genre, pending]) => ({ genre, pending }));

  return NextResponse.json({ genres });
}
