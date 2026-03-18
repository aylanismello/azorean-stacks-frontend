import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

interface CuratorAffinity {
  curator_key: string;
  source: string;
  show_slug: string;
  approved: number;
  rejected: number;
  total: number;
  approval_rate: number;
  tier: "high" | "medium";
  episodes: Array<{
    id: string;
    title: string | null;
    url: string;
    source: string;
    aired_date: string | null;
    artwork_url: string | null;
    track_count: number;
    enriched_count: number;
    downloaded_count: number;
    pending_count: number;
    discovery_method: string | null;
  }>;
  track_stats: {
    total: number;
    enriched: number;
    downloaded: number;
    pending: number;
  };
}

function getCuratorKey(episode: { source: string; url: string; title: string | null }): string | null {
  if (episode.source === "nts") {
    const match = episode.url.match(/\/shows\/([^/]+)\//);
    return match ? `nts:${match[1]}` : null;
  }
  if (episode.source === "lotradio") {
    return episode.title ? `lotradio:${episode.title}` : null;
  }
  return episode.title ? `${episode.source}:${episode.title}` : null;
}

function formatShowName(curatorKey: string): string {
  const colonIdx = curatorKey.indexOf(":");
  const slug = curatorKey.substring(colonIdx + 1);
  // Convert slug to title case: "my-cool-show" → "My Cool Show"
  return slug
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// GET /api/radar/curators
export async function GET(req: NextRequest) {
  const db = getServiceClient();

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

  // 1. Get user's approved/rejected votes
  const { data: userVotes, error: uvError } = await db
    .from("user_tracks")
    .select("track_id, status")
    .eq("user_id", user.id)
    .in("status", ["approved", "rejected"]);

  if (uvError) {
    return NextResponse.json({ error: uvError.message }, { status: 500 });
  }

  if (!userVotes || userVotes.length === 0) {
    return NextResponse.json({ curators: [], message: "No votes yet" });
  }

  const votedTrackIds = userVotes.map((v: any) => v.track_id);
  const userVoteMap = new Map(userVotes.map((v: any) => [v.track_id, v.status]));

  // 2. Get tracks with their episodes
  const { data: trackData, error: trackError } = await db
    .from("tracks")
    .select("id, episode_id, episode:episodes!episode_id(id, url, title, source, aired_date, artwork_url)")
    .in("id", votedTrackIds)
    .not("episode_id", "is", null);

  if (trackError) {
    return NextResponse.json({ error: trackError.message }, { status: 500 });
  }

  // 3. Group by curator key and compute affinity
  const showStats = new Map<string, {
    approved: number;
    rejected: number;
    source: string;
    showSlug: string;
    episodeIds: Set<string>;
  }>();

  for (const track of (trackData || []) as any[]) {
    const ep = Array.isArray(track.episode) ? track.episode[0] : track.episode;
    if (!ep?.url) continue;
    if (ep.source !== "nts" && ep.source !== "lotradio") continue;

    const curatorKey = getCuratorKey({ source: ep.source, url: ep.url, title: ep.title ?? null });
    if (!curatorKey) continue;

    if (!showStats.has(curatorKey)) {
      const showSlug = curatorKey.substring(curatorKey.indexOf(":") + 1);
      showStats.set(curatorKey, { approved: 0, rejected: 0, source: ep.source, showSlug, episodeIds: new Set() });
    }

    const stats = showStats.get(curatorKey)!;
    const voteStatus = userVoteMap.get(track.id);
    if (voteStatus === "approved") stats.approved++;
    else if (voteStatus === "rejected") stats.rejected++;
    if (ep.id) stats.episodeIds.add(ep.id);
  }

  // 4. Filter to qualifying curators
  const qualifyingCurators: Array<{
    curator_key: string;
    source: string;
    show_slug: string;
    approved: number;
    rejected: number;
    total: number;
    approval_rate: number;
    tier: "high" | "medium";
    voted_episode_ids: string[];
  }> = [];

  showStats.forEach((stats, curatorKey) => {
    const total = stats.approved + stats.rejected;
    if (total < 3) return;

    const approvalRate = stats.approved / total;
    if (approvalRate <= 0.4) return;

    let tier: "high" | "medium" | null = null;
    if (approvalRate > 0.5 && total >= 5) tier = "high";
    else if (approvalRate > 0.4 && total >= 3) tier = "medium";

    if (tier) {
      qualifyingCurators.push({
        curator_key: curatorKey,
        source: stats.source,
        show_slug: stats.showSlug,
        approved: stats.approved,
        rejected: stats.rejected,
        total,
        approval_rate: Math.round(approvalRate * 100) / 100,
        tier,
        voted_episode_ids: Array.from(stats.episodeIds),
      });
    }
  });

  qualifyingCurators.sort((a, b) => b.approval_rate - a.approval_rate);

  if (qualifyingCurators.length === 0) {
    return NextResponse.json({ curators: [], message: "No curators meet affinity thresholds yet" });
  }

  // 5. For each curator, find ALL their episodes in DB (voted + radar-pulled)
  const curators: CuratorAffinity[] = [];

  for (const c of qualifyingCurators) {
    let allEpisodes: any[] = [];

    if (c.source === "nts") {
      // NTS: episodes whose URL contains the show slug
      const { data: eps } = await db
        .from("episodes")
        .select("id, url, title, source, aired_date, artwork_url")
        .eq("source", "nts")
        .like("url", `%/shows/${c.show_slug}/%`)
        .order("aired_date", { ascending: false })
        .limit(30);
      allEpisodes = eps || [];
    } else if (c.source === "lotradio") {
      const { data: eps } = await db
        .from("episodes")
        .select("id, url, title, source, aired_date, artwork_url")
        .eq("source", "lotradio")
        .ilike("title", c.show_slug)
        .order("aired_date", { ascending: false })
        .limit(30);
      allEpisodes = eps || [];
    }

    if (allEpisodes.length === 0) continue;

    // Get track stats for these episodes
    const episodeIds = allEpisodes.map((e: any) => e.id);

    const { data: etLinks } = await db
      .from("episode_tracks")
      .select("episode_id, tracks(status, storage_path, spotify_url, youtube_url, metadata)")
      .in("episode_id", episodeIds)
      .limit(10000);

    const epStats = new Map<string, { total: number; enriched: number; downloaded: number; pending: number; hasRadarTracks: boolean }>();

    for (const row of (etLinks || []) as any[]) {
      const t = row.tracks;
      if (!t) continue;
      const epId = row.episode_id;
      if (!epStats.has(epId)) epStats.set(epId, { total: 0, enriched: 0, downloaded: 0, pending: 0, hasRadarTracks: false });
      const s = epStats.get(epId)!;
      s.total++;
      if (t.spotify_url || t.youtube_url) s.enriched++;
      if (t.storage_path) s.downloaded++;
      if (t.status === "pending") s.pending++;
      if (t.metadata?.discovery_method === "radar:curator") s.hasRadarTracks = true;
    }

    const votedEpSet = new Set(c.voted_episode_ids);

    const episodes = allEpisodes.map((ep: any) => {
      const stats = epStats.get(ep.id) || { total: 0, enriched: 0, downloaded: 0, pending: 0, hasRadarTracks: false };
      return {
        id: ep.id,
        title: ep.title,
        url: ep.url,
        source: ep.source,
        aired_date: ep.aired_date,
        artwork_url: ep.artwork_url,
        track_count: stats.total,
        enriched_count: stats.enriched,
        downloaded_count: stats.downloaded,
        pending_count: stats.pending,
        discovery_method: stats.hasRadarTracks ? "radar" : votedEpSet.has(ep.id) ? "voted" : "backfill",
      };
    });

    // Aggregate stats
    let totalTracks = 0, totalEnriched = 0, totalDownloaded = 0, totalPending = 0;
    for (const ep of episodes) {
      totalTracks += ep.track_count;
      totalEnriched += ep.enriched_count;
      totalDownloaded += ep.downloaded_count;
      totalPending += ep.pending_count;
    }

    curators.push({
      curator_key: c.curator_key,
      source: c.source,
      show_slug: c.show_slug,
      approved: c.approved,
      rejected: c.rejected,
      total: c.total,
      approval_rate: c.approval_rate,
      tier: c.tier,
      episodes,
      track_stats: {
        total: totalTracks,
        enriched: totalEnriched,
        downloaded: totalDownloaded,
        pending: totalPending,
      },
    });
  }

  return NextResponse.json({ curators });
}
