import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// GET /api/curators/[id]/episodes — episodes for a curator with seed match info
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const db = getServiceClient();

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

  // Get seed links for these episodes
  const { data: seedLinks } = await db
    .from("episode_seeds")
    .select("episode_id, match_type, seeds(id, artist, title)")
    .in("episode_id", episodeIds);

  // Build seed info per episode
  const seedsByEpisode: Record<string, Array<{ seed_id: string; artist: string; title: string; match_type: string }>> = {};
  for (const link of (seedLinks || []) as any[]) {
    if (!link.seeds) continue;
    if (!seedsByEpisode[link.episode_id]) seedsByEpisode[link.episode_id] = [];
    seedsByEpisode[link.episode_id].push({
      seed_id: link.seeds.id,
      artist: link.seeds.artist,
      title: link.seeds.title,
      match_type: link.match_type || "unknown",
    });
  }

  // Get track stats per episode via episode_tracks
  const { data: trackRows } = await db
    .from("episode_tracks")
    .select("episode_id, tracks(status)")
    .in("episode_id", episodeIds);

  const statsByEpisode: Record<string, { total: number; pending: number; approved: number; rejected: number }> = {};
  for (const row of (trackRows || []) as any[]) {
    const eid = row.episode_id;
    if (!statsByEpisode[eid]) statsByEpisode[eid] = { total: 0, pending: 0, approved: 0, rejected: 0 };
    statsByEpisode[eid].total++;
    const s = row.tracks?.status;
    if (s === "pending") statsByEpisode[eid].pending++;
    else if (s === "approved") statsByEpisode[eid].approved++;
    else if (s === "rejected") statsByEpisode[eid].rejected++;
  }

  const shaped = episodes.map((ep) => ({
    ...ep,
    seeds: seedsByEpisode[ep.id] || [],
    track_stats: statsByEpisode[ep.id] || { total: 0, pending: 0, approved: 0, rejected: 0 },
  }));

  return NextResponse.json({ episodes: shaped });
}
