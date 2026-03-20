import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// GET /api/curators/[id]/episodes — episodes for a curator with seed match info
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const db = getServiceClient();

  // Auth for per-user vote stats
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

  // Get episodes for this curator
  const { data: episodes, error } = await db
    .from("episodes")
    .select("id, url, title, source, aired_date, crawled_at")
    .eq("curator_id", params.id)
    .order("aired_date", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!episodes || episodes.length === 0) {
    return NextResponse.json({ episodes: [] });
  }

  const episodeIds = episodes.map((e) => e.id);

  // Get seed links for these episodes (paginated)
  const seedLinks: any[] = [];
  let seedPage = 0;
  while (true) {
    const { data: batch } = await db
      .from("episode_seeds")
      .select("episode_id, match_type, seeds(id, artist, title)")
      .in("episode_id", episodeIds)
      .range(seedPage * 1000, (seedPage + 1) * 1000 - 1);
    if (!batch || batch.length === 0) break;
    seedLinks.push(...batch);
    if (batch.length < 1000) break;
    seedPage++;
  }

  // Build seed info per episode
  const seedsByEpisode: Record<string, Array<{ seed_id: string; artist: string; title: string; match_type: string }>> = {};
  for (const link of seedLinks as any[]) {
    if (!link.seeds) continue;
    if (!seedsByEpisode[link.episode_id]) seedsByEpisode[link.episode_id] = [];
    seedsByEpisode[link.episode_id].push({
      seed_id: link.seeds.id,
      artist: link.seeds.artist,
      title: link.seeds.title,
      match_type: link.match_type || "unknown",
    });
  }

  // Get track IDs per episode via episode_tracks (paginated)
  const trackRows: any[] = [];
  let trackPage = 0;
  while (true) {
    const { data: batch } = await db
      .from("episode_tracks")
      .select("episode_id, track_id")
      .in("episode_id", episodeIds)
      .range(trackPage * 1000, (trackPage + 1) * 1000 - 1);
    if (!batch || batch.length === 0) break;
    trackRows.push(...batch);
    if (batch.length < 1000) break;
    trackPage++;
  }

  // Build per-episode stats from user_tracks
  const statsByEpisode: Record<string, { total: number; pending: number; approved: number; rejected: number }> = {};

  if (user && trackRows.length > 0) {
    const allTrackIds = trackRows.map((r: any) => r.track_id);
    const trackEpMap = new Map<string, string>();
    for (const r of trackRows) {
      trackEpMap.set(r.track_id, r.episode_id);
    }

    // Initialize totals
    for (const r of trackRows) {
      if (!statsByEpisode[r.episode_id]) statsByEpisode[r.episode_id] = { total: 0, pending: 0, approved: 0, rejected: 0 };
      statsByEpisode[r.episode_id].total++;
    }

    // Fetch user votes for these tracks (paginated)
    const userVotes = new Map<string, string>();
    let votePage = 0;
    while (true) {
      const pageIds = allTrackIds.slice(votePage * 1000, (votePage + 1) * 1000);
      if (pageIds.length === 0) break;
      const { data: batch } = await db
        .from("user_tracks")
        .select("track_id, status")
        .eq("user_id", user.id)
        .in("track_id", pageIds);
      if (batch) {
        for (const v of batch as any[]) {
          userVotes.set(v.track_id, v.status);
        }
      }
      votePage++;
      if (pageIds.length < 1000) break;
    }

    // Count per episode
    for (const r of trackRows) {
      const epStats = statsByEpisode[r.episode_id];
      const vote = userVotes.get(r.track_id);
      if (vote === "approved") epStats.approved++;
      else if (vote === "rejected") epStats.rejected++;
      else epStats.pending++;
    }
  } else {
    // No auth — just count totals
    for (const r of trackRows) {
      if (!statsByEpisode[r.episode_id]) statsByEpisode[r.episode_id] = { total: 0, pending: 0, approved: 0, rejected: 0 };
      statsByEpisode[r.episode_id].total++;
      statsByEpisode[r.episode_id].pending++;
    }
  }

  const shaped = episodes.map((ep) => ({
    ...ep,
    seeds: seedsByEpisode[ep.id] || [],
    track_stats: statsByEpisode[ep.id] || { total: 0, pending: 0, approved: 0, rejected: 0 },
  }));

  return NextResponse.json({ episodes: shaped });
}
