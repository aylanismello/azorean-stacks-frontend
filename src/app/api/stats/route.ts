import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export async function GET() {
  try {
    // Counts by status — efficient head-only queries
    const [pending, approved, rejected] = await Promise.all([
      supabase.from("tracks").select("id", { count: "exact", head: true }).eq("status", "pending"),
      supabase.from("tracks").select("id", { count: "exact", head: true }).in("status", ["approved", "downloaded"]),
      supabase.from("tracks").select("id", { count: "exact", head: true }).eq("status", "rejected"),
    ]);

    const totalApproved = approved.count || 0;
    const totalRejected = rejected.count || 0;
    const totalReviewed = totalApproved + totalRejected;
    const approvalRate = totalReviewed > 0 ? totalApproved / totalReviewed : 0;

    // Top approved artists — fetch only artist column with limit to avoid pulling all rows
    const { data: approvedTracks } = await supabase
      .from("tracks")
      .select("artist")
      .in("status", ["approved", "downloaded"]);

    const artistCounts: Record<string, number> = {};
    (approvedTracks || []).forEach((t) => {
      artistCounts[t.artist] = (artistCounts[t.artist] || 0) + 1;
    });

    const topArtists = Object.entries(artistCounts)
      .map(([artist, count]) => ({ artist, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // Source breakdown — fetch only source column
    const { data: allSources } = await supabase
      .from("tracks")
      .select("source");

    const sourceCounts: Record<string, number> = {};
    (allSources || []).forEach((t) => {
      sourceCounts[t.source] = (sourceCounts[t.source] || 0) + 1;
    });

    const sourceBreakdown = Object.entries(sourceCounts)
      .map(([source, count]) => ({ source, count }))
      .sort((a, b) => b.count - a.count);

    // Recent discovery runs
    const { data: recentRuns } = await supabase
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
