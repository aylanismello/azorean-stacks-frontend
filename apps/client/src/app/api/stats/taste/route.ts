import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// GET /api/stats/taste — per-day approval rate trend from user_tracks
export async function GET(req: NextRequest) {
  const auth = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return req.cookies.getAll();
        },
        setAll() {},
      },
    }
  );
  const {
    data: { user },
  } = await auth.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = getServiceClient();

  // Fetch last 30 days of votes for this user
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: votes } = await db
    .from("user_tracks")
    .select("status, voted_at")
    .eq("user_id", user.id)
    .in("status", ["approved", "rejected"])
    .gte("voted_at", since)
    .order("voted_at", { ascending: true });

  // Aggregate by day
  const byDay: Record<string, { approved: number; rejected: number }> = {};
  for (const v of (votes || []) as any[]) {
    if (!v.voted_at) continue;
    const day = v.voted_at.slice(0, 10); // "YYYY-MM-DD"
    if (!byDay[day]) byDay[day] = { approved: 0, rejected: 0 };
    if (v.status === "approved") byDay[day].approved++;
    else byDay[day].rejected++;
  }

  const daily = Object.entries(byDay)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, { approved, rejected }]) => ({
      day,
      approved,
      rejected,
      total: approved + rejected,
      rate: approved + rejected > 0 ? Math.round((approved / (approved + rejected)) * 100) : null,
    }));

  // Overall stats (all time for this user)
  const { count: totalVotesCount } = await db
    .from("user_tracks")
    .select("status", { count: "exact", head: true })
    .eq("user_id", user.id)
    .in("status", ["approved", "rejected"]);

  const { count: totalApprovedCount } = await db
    .from("user_tracks")
    .select("status", { count: "exact", head: true })
    .eq("user_id", user.id)
    .eq("status", "approved");

  const totalVotes = totalVotesCount ?? 0;
  const totalApproved = totalApprovedCount ?? 0;

  // Recent 7-day rate
  const last7 = daily.slice(-7);
  const last7Approved = last7.reduce((s, d) => s + d.approved, 0);
  const last7Total = last7.reduce((s, d) => s + d.total, 0);
  const last7Rate = last7Total > 0 ? Math.round((last7Approved / last7Total) * 100) : null;

  return NextResponse.json({
    daily,
    summary: {
      total_votes: totalVotes,
      total_approved: totalApproved,
      last_7d_rate: last7Rate,
      last_7d_votes: last7Total,
    },
  });
}
