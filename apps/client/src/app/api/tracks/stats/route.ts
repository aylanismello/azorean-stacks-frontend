import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// GET /api/tracks/stats — taste score distribution for tracks the user hasn't voted on
export async function GET(req: NextRequest) {
  try {
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

    // Fetch all pending tracks with their taste_score and id
    const allPending: Array<{ id: string; taste_score: number | null }> = [];
    let page = 0;
    while (true) {
      const { data: batch } = await db
        .from("tracks")
        .select("id, taste_score")
        .eq("status", "pending")
        .range(page * 1000, (page + 1) * 1000 - 1);
      if (!batch || batch.length === 0) break;
      allPending.push(...(batch as any));
      if (batch.length < 1000) break;
      page++;
    }

    // Filter out user's voted tracks and count by score bucket
    let recommended = 0;
    let unscored = 0;
    let likelySkip = 0;

    for (const t of allPending) {
      if (votedTrackIds.has(t.id)) continue;
      const score = t.taste_score ?? 0;
      if (score > 0) recommended++;
      else if (score < 0) likelySkip++;
      else unscored++;
    }

    return NextResponse.json({
      recommended,
      unscored,
      likely_skip: likelySkip,
      total: recommended + unscored + likelySkip,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
