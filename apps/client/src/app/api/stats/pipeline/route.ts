import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const db = getServiceClient();

    // Total super-liked tracks
    const { count: totalSuperLikes } = await db
      .from("user_tracks")
      .select("track_id", { count: "exact", head: true })
      .eq("super_liked", true);

    // Distinct tracks that have a completed super-like download
    const { data: completedEvents } = await db
      .from("engine_events")
      .select("metadata")
      .eq("type", "super_like_completed");

    const downloadedTrackIds = new Set(
      (completedEvents || [])
        .map((e: any) => e.metadata?.track_id)
        .filter(Boolean),
    );

    const total = totalSuperLikes ?? 0;
    const downloaded = downloadedTrackIds.size;
    const pending = Math.max(0, total - downloaded);

    // Last watcher_connected event
    const { data: connectedEvents } = await db
      .from("engine_events")
      .select("created_at")
      .eq("type", "watcher_connected")
      .order("created_at", { ascending: false })
      .limit(1);

    const connectedAt = connectedEvents?.[0]?.created_at ?? null;

    // Last engine event of any type
    const { data: lastEventRows } = await db
      .from("engine_events")
      .select("type, status, created_at, metadata")
      .order("created_at", { ascending: false })
      .limit(1);

    const lastEvent = lastEventRows?.[0] ?? null;

    // Last 10 engine events for display
    const { data: recentEvents } = await db
      .from("engine_events")
      .select("type, status, created_at, metadata")
      .order("created_at", { ascending: false })
      .limit(10);

    return NextResponse.json({
      super_likes: { total, downloaded, pending },
      watcher: {
        connected_at: connectedAt,
        last_event: lastEvent?.created_at ?? null,
      },
      last_events: recentEvents || [],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
