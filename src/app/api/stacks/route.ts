import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// GET /api/stacks — seeds with their episodes and per-episode track stats
export async function GET() {
  const supabase = getServiceClient();

  // 1. Get all seeds
  const { data: seeds, error: seedErr } = await supabase
    .from("seeds")
    .select("id, artist, title, active")
    .order("created_at", { ascending: false });

  if (seedErr) {
    return NextResponse.json({ error: seedErr.message }, { status: 500 });
  }

  const seedIds = (seeds || []).map((s) => s.id);
  if (seedIds.length === 0) {
    return NextResponse.json({ stacks: [], total_pending: 0 });
  }

  // 2. Get episode_seeds links with episode info
  const { data: episodeLinks } = await supabase
    .from("episode_seeds")
    .select("seed_id, match_type, episodes(id, title, url, source, aired_date, skipped)")
    .in("seed_id", seedIds);

  // Build seed → episodes map
  const episodesBySeed: Record<string, Array<{
    id: string; title: string | null; url: string; source: string;
    aired_date: string | null; skipped: boolean; match_type: string;
  }>> = {};

  const allEpisodeIds = new Set<string>();

  for (const link of (episodeLinks || []) as any[]) {
    if (!link.episodes) continue;
    const ep = link.episodes;
    allEpisodeIds.add(ep.id);
    if (!episodesBySeed[link.seed_id]) episodesBySeed[link.seed_id] = [];
    episodesBySeed[link.seed_id].push({
      id: ep.id,
      title: ep.title,
      url: ep.url,
      source: ep.source,
      aired_date: ep.aired_date,
      skipped: ep.skipped || false,
      match_type: link.match_type || "unknown",
    });
  }

  if (allEpisodeIds.size === 0) {
    return NextResponse.json({
      stacks: (seeds || []).map((s) => ({ ...s, episodes: [], total_pending: 0, total_approved: 0, total_rejected: 0, total: 0 })),
      total_pending: 0,
    });
  }

  // 3. Get per-episode track stats in one query
  const { data: tracks } = await supabase
    .from("tracks")
    .select("episode_id, status, cover_art_url, artist, title")
    .in("episode_id", Array.from(allEpisodeIds));

  // Aggregate stats per episode
  const episodeStats: Record<string, {
    pending: number; approved: number; rejected: number; total: number;
    cover_art_url: string | null;
    sample_tracks: { artist: string; title: string }[];
  }> = {};

  for (const t of (tracks || []) as any[]) {
    const epId = t.episode_id;
    if (!epId) continue;

    if (!episodeStats[epId]) {
      episodeStats[epId] = { pending: 0, approved: 0, rejected: 0, total: 0, cover_art_url: null, sample_tracks: [] };
    }

    const s = episodeStats[epId];
    s.total++;
    if (t.status === "pending") s.pending++;
    else if (t.status === "approved" || t.status === "downloaded") s.approved++;
    else if (t.status === "rejected") s.rejected++;

    if (!s.cover_art_url && t.cover_art_url) s.cover_art_url = t.cover_art_url;
    if (s.sample_tracks.length < 3 && t.status === "pending") {
      s.sample_tracks.push({ artist: t.artist, title: t.title });
    }
  }

  // 4. Build per-episode, per-artist matched tracks for artist-only episodes
  // Key: `${episodeId}::${artistLower}` → tracks by that artist in that episode
  const artistTracksByEpisode: Record<string, { artist: string; title: string }[]> = {};
  for (const t of (tracks || []) as any[]) {
    if (!t.episode_id) continue;
    const key = `${t.episode_id}::${(t.artist || "").toLowerCase()}`;
    if (!artistTracksByEpisode[key]) artistTracksByEpisode[key] = [];
    if (artistTracksByEpisode[key].length < 5) {
      artistTracksByEpisode[key].push({ artist: t.artist, title: t.title });
    }
  }

  // 5. Build response: seeds with enriched episodes
  let globalPending = 0;

  const stacks = (seeds || []).map((seed) => {
    const seedArtistLower = (seed.artist || "").toLowerCase();
    const eps = (episodesBySeed[seed.id] || [])
      .filter((ep) => !ep.skipped)
      .map((ep) => {
        const stats = episodeStats[ep.id] || { pending: 0, approved: 0, rejected: 0, total: 0, cover_art_url: null, sample_tracks: [] };
        // For artist-only matches, show which tracks by that artist are in this episode
        const matched_tracks = ep.match_type !== "full"
          ? (artistTracksByEpisode[`${ep.id}::${seedArtistLower}`] || [])
          : [];
        return { ...ep, ...stats, matched_tracks };
      })
      .sort((a, b) => b.pending - a.pending); // pending-heavy first

    const totalPending = eps.reduce((s, e) => s + e.pending, 0);
    const totalApproved = eps.reduce((s, e) => s + e.approved, 0);
    const totalRejected = eps.reduce((s, e) => s + e.rejected, 0);
    const total = eps.reduce((s, e) => s + e.total, 0);
    globalPending += totalPending;

    // Pick first non-null cover_art_url from episodes
    const cover_art_url = eps.find((e) => e.cover_art_url)?.cover_art_url ?? null;

    return {
      id: seed.id,
      artist: seed.artist,
      title: seed.title,
      active: seed.active,
      episodes: eps,
      total_pending: totalPending,
      total_approved: totalApproved,
      total_rejected: totalRejected,
      total,
      cover_art_url,
    };
  })
    .filter((s) => s.episodes.length > 0) // Only seeds with episodes
    .sort((a, b) => b.total_pending - a.total_pending); // Most pending first

  return NextResponse.json({ stacks, total_pending: globalPending });
}
