import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
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
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = getServiceClient();

    // Counts from user_tracks for this user
    const [approvedResult, rejectedResult] = await Promise.all([
      db.from("user_tracks").select("id", { count: "exact", head: true }).eq("user_id", user.id).eq("status", "approved"),
      db.from("user_tracks").select("id", { count: "exact", head: true }).eq("user_id", user.id).eq("status", "rejected"),
    ]);

    const totalApproved = approvedResult.count || 0;
    const totalRejected = rejectedResult.count || 0;
    const totalReviewed = totalApproved + totalRejected;
    const approvalRate = totalReviewed > 0 ? totalApproved / totalReviewed : 0;

    // Pending = total pipeline-pending tracks minus user's voted tracks
    const { count: totalPipelinePending } = await db
      .from("tracks")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending");

    // Count user's voted tracks (any non-pending vote)
    const { count: userVotedCount } = await db
      .from("user_tracks")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .in("status", ["approved", "rejected", "skipped", "bad_source", "listened"]);

    const totalPending = Math.max(0, (totalPipelinePending || 0) - (userVotedCount || 0));

    // Top approved artists — from user_tracks
    const approvedTrackIds: string[] = [];
    let idPage = 0;
    while (true) {
      const { data: batch } = await db
        .from("user_tracks")
        .select("track_id")
        .eq("user_id", user.id)
        .eq("status", "approved")
        .range(idPage * 1000, (idPage + 1) * 1000 - 1);
      if (!batch || batch.length === 0) break;
      approvedTrackIds.push(...batch.map((r: any) => r.track_id));
      if (batch.length < 1000) break;
      idPage++;
    }

    let topArtists: Array<{ artist: string; count: number }> = [];
    if (approvedTrackIds.length > 0) {
      const approvedArtists: { artist: string }[] = [];
      let artistPage = 0;
      while (true) {
        const pageIds = approvedTrackIds.slice(artistPage * 1000, (artistPage + 1) * 1000);
        if (pageIds.length === 0) break;
        const { data: batch } = await db
          .from("tracks")
          .select("artist")
          .in("id", pageIds);
        if (!batch || batch.length === 0) break;
        approvedArtists.push(...(batch as { artist: string }[]));
        artistPage++;
        if (pageIds.length < 1000) break;
      }

      const artistCounts: Record<string, number> = {};
      approvedArtists.forEach((t) => {
        artistCounts[t.artist] = (artistCounts[t.artist] || 0) + 1;
      });

      topArtists = Object.entries(artistCounts)
        .map(([artist, count]) => ({ artist, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);
    }

    // Source breakdown — pipeline-level, not user-specific
    const allSources: { source: string }[] = [];
    let sourcePage = 0;
    while (true) {
      const { data: batch } = await db
        .from("tracks")
        .select("source")
        .range(sourcePage * 1000, (sourcePage + 1) * 1000 - 1);
      if (!batch || batch.length === 0) break;
      allSources.push(...(batch as { source: string }[]));
      if (batch.length < 1000) break;
      sourcePage++;
    }

    const sourceCounts: Record<string, number> = {};
    allSources.forEach((t) => {
      sourceCounts[t.source] = (sourceCounts[t.source] || 0) + 1;
    });

    const sourceBreakdown = Object.entries(sourceCounts)
      .map(([source, count]) => ({ source, count }))
      .sort((a, b) => b.count - a.count);

    // Recent discovery runs
    const { data: recentRuns } = await db
      .from("discovery_runs")
      .select("id, seed_id, seed_track_id, sources_searched, tracks_found, tracks_added, started_at, completed_at, notes")
      .order("started_at", { ascending: false })
      .limit(10);

    return NextResponse.json({
      total_reviewed: totalReviewed,
      total_approved: totalApproved,
      total_rejected: totalRejected,
      approval_rate: approvalRate,
      total_pending: totalPending,
      top_artists: topArtists,
      source_breakdown: sourceBreakdown,
      recent_runs: recentRuns || [],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
