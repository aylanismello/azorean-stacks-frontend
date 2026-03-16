import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// POST /api/tracks/auto-skip — marks all pending tracks with taste_score < -0.3 as 'skipped'
export async function POST() {
  try {
    const db = getServiceClient();

    // Fetch IDs of pending tracks with taste_score < -0.3
    // We paginate to avoid hitting row limits
    const ids: string[] = [];
    let page = 0;
    while (true) {
      const { data: batch, error } = await db
        .from("tracks")
        .select("id")
        .eq("status", "pending")
        .lt("taste_score", -0.3)
        .range(page * 1000, (page + 1) * 1000 - 1);

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }

      if (!batch || batch.length === 0) break;
      ids.push(...batch.map((t: any) => t.id));
      if (batch.length < 1000) break;
      page++;
    }

    if (ids.length === 0) {
      return NextResponse.json({ skipped: 0, message: "No tracks to skip" });
    }

    // Update in batches of 500
    let skipped = 0;
    const votedAt = new Date().toISOString();
    for (let i = 0; i < ids.length; i += 500) {
      const batch = ids.slice(i, i + 500);
      const { error } = await db
        .from("tracks")
        .update({ status: "skipped", voted_at: votedAt })
        .in("id", batch);

      if (error) {
        return NextResponse.json({ error: error.message, skipped }, { status: 500 });
      }
      skipped += batch.length;
    }

    return NextResponse.json({ skipped, message: `Skipped ${skipped} low-scored tracks` });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
