import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const DEFAULT_WEIGHTS = {
  seed_proximity: 30,
  source_quality: 25,
  artist_familiarity: 20,
  recency: 15,
  co_occurrence: 10,
};

// GET /api/stats/algorithm
// Returns algorithm performance data for the stats dashboard:
//   - current_weights: latest taste_weights row (or defaults)
//   - weight_history: last 30 days of weight snapshots
//   - session_breakdown: last 5 "sessions" (groups of votes by time gap)
//   - per_seed_hit_rate: per-seed approval rates
export async function GET(req: NextRequest) {
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

  // ── Current weights ───────────────────────────────────────────────────────
  const { data: latestWeights } = await db
    .from("taste_weights")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const currentWeights = latestWeights
    ? {
        seed_proximity: latestWeights.seed_proximity,
        source_quality: latestWeights.source_quality,
        artist_familiarity: latestWeights.artist_familiarity,
        recency: latestWeights.recency,
        co_occurrence: latestWeights.co_occurrence,
        updated_at: latestWeights.created_at,
      }
    : { ...DEFAULT_WEIGHTS, updated_at: null };

  // ── Weight history (last 30 days) ─────────────────────────────────────────
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: weightHistory } = await db
    .from("taste_weights")
    .select("seed_proximity, source_quality, artist_familiarity, recency, co_occurrence, created_at")
    .eq("user_id", user.id)
    .gte("created_at", thirtyDaysAgo)
    .order("created_at", { ascending: true });

  // ── Session breakdown ─────────────────────────────────────────────────────
  // Fetch last 200 votes, group into "sessions" (gap > 2h = new session)
  const { data: recentVotes } = await db
    .from("user_tracks")
    .select("status, voted_at, track_id, listen_pct")
    .eq("user_id", user.id)
    .in("status", ["approved", "rejected", "skipped"])
    .order("voted_at", { ascending: false })
    .limit(200);

  const sessions: Array<{
    votes: Array<{ status: string; track_id: string; listen_pct: number | null }>;
    start: string;
    end: string;
  }> = [];

  if (recentVotes && recentVotes.length > 0) {
    let currentSession: typeof sessions[0] = {
      votes: [],
      start: (recentVotes[0] as any).voted_at,
      end: (recentVotes[0] as any).voted_at,
    };

    for (const vote of recentVotes as any[]) {
      if (!vote.voted_at) continue;
      const gap = new Date(currentSession.end).getTime() - new Date(vote.voted_at).getTime();
      // 2+ hour gap = new session (votes are desc, so gap is positive when current is newer)
      if (currentSession.votes.length > 0 && gap > 2 * 60 * 60 * 1000) {
        sessions.push(currentSession);
        currentSession = {
          votes: [],
          start: vote.voted_at,
          end: vote.voted_at,
        };
      }
      currentSession.votes.push({
        status: vote.status,
        track_id: vote.track_id,
        listen_pct: vote.listen_pct,
      });
      currentSession.end = vote.voted_at;
    }
    if (currentSession.votes.length > 0) sessions.push(currentSession);
  }

  const sessionBreakdown = sessions.slice(0, 5).map((s) => {
    const approved = s.votes.filter((v) => v.status === "approved").length;
    const rejected = s.votes.filter((v) => v.status === "rejected").length;
    const skipped = s.votes.filter((v) => v.status === "skipped").length;
    const listenPcts = s.votes.map((v) => v.listen_pct).filter((p): p is number => p !== null);
    const avgListenPct = listenPcts.length > 0
      ? Math.round(listenPcts.reduce((a, b) => a + b, 0) / listenPcts.length)
      : null;
    const total = s.votes.length;
    const rate = total > 0 ? Math.round((approved / total) * 100) : null;

    return {
      start: s.start,
      end: s.end,
      total,
      approved,
      rejected,
      skipped,
      approval_rate: rate,
      avg_listen_pct: avgListenPct,
    };
  });

  // ── Per-seed hit rate ─────────────────────────────────────────────────────
  // Get all seeds for this user with their episode-linked tracks + vote stats
  const { data: userSeeds } = await db
    .from("seeds")
    .select("id, artist, title, active, cover_art_url")
    .or(`user_id.eq.${user.id},user_id.is.null`)
    .eq("active", true)
    .order("created_at", { ascending: false })
    .limit(30);

  const perSeedHitRate: Array<{
    seed_id: string;
    artist: string;
    title: string;
    cover_art_url: string | null;
    approved: number;
    rejected: number;
    skipped: number;
    total_voted: number;
    approval_rate: number | null;
    flag: boolean;
  }> = [];

  if (userSeeds && userSeeds.length > 0) {
    // Get episode_seeds for all seeds
    const seedIds = (userSeeds as any[]).map((s) => s.id);
    const { data: epSeedLinks } = await db
      .from("episode_seeds")
      .select("seed_id, episode_id")
      .in("seed_id", seedIds);

    // Map seed_id → episode_ids
    const seedToEps = new Map<string, string[]>();
    for (const link of (epSeedLinks || []) as any[]) {
      const arr = seedToEps.get(link.seed_id) || [];
      arr.push(link.episode_id);
      seedToEps.set(link.seed_id, arr);
    }

    // For each seed, count approved/rejected tracks from its episodes (via user_tracks)
    const allEpIds = [...new Set((epSeedLinks || []).map((l: any) => l.episode_id))];
    if (allEpIds.length > 0) {
      // Get all tracks from these episodes with user's vote status
      const { data: epTracks } = await db
        .from("tracks")
        .select("id, episode_id")
        .in("episode_id", allEpIds);

      const epTrackIds = (epTracks || []).map((t: any) => t.id);
      const epIdByTrack = new Map((epTracks || []).map((t: any) => [t.id, t.episode_id]));

      let votedStats: any[] = [];
      if (epTrackIds.length > 0) {
        const { data: voted } = await db
          .from("user_tracks")
          .select("track_id, status")
          .eq("user_id", user.id)
          .in("track_id", epTrackIds)
          .in("status", ["approved", "rejected", "skipped"]);
        votedStats = (voted || []) as any[];
      }

      // Roll up per episode
      const epVoteStats = new Map<string, { approved: number; rejected: number; skipped: number }>();
      for (const v of votedStats) {
        const epId = epIdByTrack.get(v.track_id);
        if (!epId) continue;
        const s = epVoteStats.get(epId) || { approved: 0, rejected: 0, skipped: 0 };
        if (v.status === "approved") s.approved++;
        else if (v.status === "rejected") s.rejected++;
        else s.skipped++;
        epVoteStats.set(epId, s);
      }

      for (const seed of userSeeds as any[]) {
        const eps = seedToEps.get(seed.id) || [];
        let approved = 0, rejected = 0, skipped = 0;
        for (const epId of eps) {
          const s = epVoteStats.get(epId);
          if (s) { approved += s.approved; rejected += s.rejected; skipped += s.skipped; }
        }
        const totalVoted = approved + rejected + skipped;
        const approvalRate = totalVoted > 0
          ? Math.round((approved / totalVoted) * 100)
          : null;

        perSeedHitRate.push({
          seed_id: seed.id,
          artist: seed.artist,
          title: seed.title,
          cover_art_url: seed.cover_art_url || null,
          approved,
          rejected,
          skipped,
          total_voted: totalVoted,
          approval_rate: approvalRate,
          flag: approvalRate !== null && approvalRate < 20 && totalVoted >= 5,
        });
      }

      perSeedHitRate.sort((a, b) => {
        // Sort: flagged first, then by total voted desc
        if (a.flag && !b.flag) return -1;
        if (!a.flag && b.flag) return 1;
        return b.total_voted - a.total_voted;
      });
    }
  }

  // ── Approval trend by day (last 30 days) ──────────────────────────────────
  // We already have this in /api/stats/taste — keep it there, just include
  // the summary here for convenience.
  const { data: recentVotesForTrend } = await db
    .from("user_tracks")
    .select("status, voted_at")
    .eq("user_id", user.id)
    .in("status", ["approved", "rejected"])
    .gte("voted_at", thirtyDaysAgo)
    .order("voted_at", { ascending: true });

  const byDay: Record<string, { approved: number; rejected: number }> = {};
  for (const v of (recentVotesForTrend || []) as any[]) {
    if (!v.voted_at) continue;
    const day = v.voted_at.slice(0, 10);
    if (!byDay[day]) byDay[day] = { approved: 0, rejected: 0 };
    if (v.status === "approved") byDay[day].approved++;
    else byDay[day].rejected++;
  }
  const approvalTrend = Object.entries(byDay)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, { approved, rejected }]) => ({
      day,
      approved,
      rejected,
      total: approved + rejected,
      rate: approved + rejected > 0 ? Math.round((approved / (approved + rejected)) * 100) : null,
    }));

  return NextResponse.json({
    current_weights: currentWeights,
    weight_history: weightHistory || [],
    session_breakdown: sessionBreakdown,
    per_seed_hit_rate: perSeedHitRate,
    approval_trend: approvalTrend,
    using_defaults: !latestWeights,
  });
}
