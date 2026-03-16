import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// GET /api/tracks/stats — taste score distribution for pending tracks
export async function GET() {
  try {
    const db = getServiceClient();

    const [recommended, unscored, likelySkip] = await Promise.all([
      // recommended: taste_score > 0
      db.from("tracks").select("id", { count: "exact" }).eq("status", "pending").gt("taste_score", 0).limit(0),
      // unscored: taste_score = 0
      db.from("tracks").select("id", { count: "exact" }).eq("status", "pending").eq("taste_score", 0).limit(0),
      // likely_skip: taste_score < 0
      db.from("tracks").select("id", { count: "exact" }).eq("status", "pending").lt("taste_score", 0).limit(0),
    ]);

    return NextResponse.json({
      recommended: recommended.count || 0,
      unscored: unscored.count || 0,
      likely_skip: likelySkip.count || 0,
      total: (recommended.count || 0) + (unscored.count || 0) + (likelySkip.count || 0),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
