import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // Use anon client for track counts (same RLS view as tracks endpoint)
    // Service client only for discovery_runs which has no RLS equivalent

    // Counts by status — use limit(0) with count to stay compatible with RLS
    const [pending, approved, rejected] = await Promise.all([
      supabase.from("tracks").select("id", { count: "exact" }).eq("status", "pending").limit(0),
      supabase.from("tracks").select("id", { count: "exact" }).eq("status", "approved").limit(0),
      supabase.from("tracks").select("id", { count: "exact" }).eq("status", "rejected").limit(0),
    ]);

    const totalApproved = approved.count || 0;
    const totalRejected = rejected.count || 0;
    const totalReviewed = totalApproved + totalRejected;
    const approvalRate = totalReviewed > 0 ? totalApproved / totalReviewed : 0;

    // Top approved artists — fetch only artist column, capped to prevent memory issues
    const { data: approvedTracks } = await supabase
      .from("tracks")
      .select("artist")
      .eq("status", "approved")
      .limit(5000);

    const artistCounts: Record<string, number> = {};
    (approvedTracks || []).forEach((t) => {
      artistCounts[t.artist] = (artistCounts[t.artist] || 0) + 1;
    });

    const topArtists = Object.entries(artistCounts)
      .map(([artist, count]) => ({ artist, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // Source breakdown — fetch only source column, capped
    const { data: allSources } = await supabase
      .from("tracks")
      .select("source")
      .limit(10000);

    const sourceCounts: Record<string, number> = {};
    (allSources || []).forEach((t) => {
      sourceCounts[t.source] = (sourceCounts[t.source] || 0) + 1;
    });

    const sourceBreakdown = Object.entries(sourceCounts)
      .map(([source, count]) => ({ source, count }))
      .sort((a, b) => b.count - a.count);

    // Recent discovery runs (use service client — no RLS on this table)
    const serviceDb = getServiceClient();
    const { data: recentRuns } = await serviceDb
      .from("discovery_runs")
      .select("*")
      .order("started_at", { ascending: false })
      .limit(10);

    return NextResponse.json({
      total_reviewed: totalReviewed,
      total_approved: totalApproved,
      total_rejected: totalRejected,
      approval_rate: approvalRate,
      total_pending: pending.count || 0,
      top_artists: topArtists,
      source_breakdown: sourceBreakdown,
      recent_runs: recentRuns || [],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
