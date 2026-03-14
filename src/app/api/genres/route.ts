import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// GET /api/genres — returns genres with pending track counts, for the stacks launcher
export async function GET() {
  // Fetch pending tracks that have genres
  const allTracks: any[] = [];
  let page = 0;
  while (true) {
    const { data, error } = await supabase
      .from("tracks")
      .select("metadata->genres")
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

  // Count genre occurrences across pending tracks
  const counts = new Map<string, number>();
  for (const track of allTracks) {
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
