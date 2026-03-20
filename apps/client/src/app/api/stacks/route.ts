import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// GET /api/stacks — seeds with their episodes and per-episode track stats
export async function GET(req: NextRequest) {
  const supabase = getServiceClient();
  const auth = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return req.cookies.getAll();
        },
        setAll() {
          // Read-only access to auth cookies in route handlers.
        },
      },
    }
  );
  const {
    data: { user },
  } = await auth.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 1. Get seeds for the authenticated user (including legacy null-user seeds)
  const { data: seeds, error: seedErr } = await supabase
    .from("seeds")
    .select("id, artist, title, active, cover_art_url, created_at")
    .or(`user_id.eq.${user.id},user_id.is.null`)
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
      stacks: (seeds || []).map((s) => ({ ...s, episodes: [], total_pending: 0, total_approved: 0, total_rejected: 0, total: 0, total_playable: 0, total_processing: 0, total_unavailable: 0 })),
      total_pending: 0,
    });
  }

  // 3. Get per-episode track stats — paginate past Supabase 1000-row cap
  const allTracks: any[] = [];
  let tracksPage = 0;
  while (true) {
    const { data: batch } = await supabase
      .from("tracks")
      .select("episode_id, status, cover_art_url, artist, title, source_url, source_context, storage_path")
      .in("episode_id", Array.from(allEpisodeIds))
      .range(tracksPage * 1000, (tracksPage + 1) * 1000 - 1);
    if (!batch || batch.length === 0) break;
    allTracks.push(...batch);
    if (batch.length < 1000) break;
    tracksPage++;
  }
  const tracks = allTracks;

  // Aggregate stats per episode
  const episodeStats: Record<string, {
    pending: number; approved: number; rejected: number; total: number;
    playable: number; processing: number; unavailable: number;
    cover_art_url: string | null;
    sample_tracks: { artist: string; title: string }[];
  }> = {};

  for (const t of (tracks || []) as any[]) {
    const epId = t.episode_id;
    if (!epId) continue;

    if (!episodeStats[epId]) {
      episodeStats[epId] = { pending: 0, approved: 0, rejected: 0, total: 0, playable: 0, processing: 0, unavailable: 0, cover_art_url: null, sample_tracks: [] };
    }

    const s = episodeStats[epId];
    s.total++;
    if (t.storage_path) s.playable++;
    if (t.status === "pending") s.pending++;
    else if (t.status === "approved") s.approved++;
    else if (t.status === "rejected") s.rejected++;

    // Processing: pending enrichment or download (no storage_path yet, not terminal)
    if (t.status === "pending" && !t.storage_path) s.processing++;
    // Unavailable: skipped, failed, or dead-end (no online source found)
    if (t.status === "skipped" || t.status === "failed" ||
        (t.status !== "pending" && t.status !== "approved" && t.status !== "rejected" && !t.storage_path)) {
      s.unavailable++;
    }

    if (!s.cover_art_url && t.cover_art_url) s.cover_art_url = t.cover_art_url;
    if (s.sample_tracks.length < 3 && t.status === "pending") {
      s.sample_tracks.push({ artist: t.artist, title: t.title });
    }
  }

  // 4. Build per-episode, per-artist matched tracks for artist-only episodes
  // Key: `${episodeId}::${artistLower}` → tracks by that artist in that episode
  const artistTracksByEpisode: Record<string, { artist: string; title: string }[]> = {};
  // Also track cover art by artist (across all episodes) for fallback
  const artistCoverArt: Record<string, string> = {};
  for (const t of (tracks || []) as any[]) {
    if (!t.episode_id) continue;
    const key = `${t.episode_id}::${(t.artist || "").toLowerCase()}`;
    if (!artistTracksByEpisode[key]) artistTracksByEpisode[key] = [];
    if (artistTracksByEpisode[key].length < 5) {
      artistTracksByEpisode[key].push({ artist: t.artist, title: t.title });
    }
    // Save first cover art we find for each artist
    const artistLower = (t.artist || "").toLowerCase();
    if (t.cover_art_url && !artistCoverArt[artistLower]) {
      artistCoverArt[artistLower] = t.cover_art_url;
    }
  }

  // 5. Build response: seeds with enriched episodes
  let globalPending = 0;

  const stacks = (seeds || []).map((seed) => {
    const seedArtistLower = (seed.artist || "").toLowerCase();
    const eps = (episodesBySeed[seed.id] || [])
      .filter((ep) => !ep.skipped)
      .map((ep) => {
        const stats = episodeStats[ep.id] || { pending: 0, approved: 0, rejected: 0, total: 0, playable: 0, processing: 0, unavailable: 0, cover_art_url: null, sample_tracks: [] };
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
    const totalPlayable = eps.reduce((s, e) => s + e.playable, 0);
    const totalProcessing = eps.reduce((s, e) => s + e.processing, 0);
    const totalUnavailable = eps.reduce((s, e) => s + e.unavailable, 0);
    globalPending += totalPending;

    // Use the seed's own cover art (from Spotify lookup of the seed song itself)
    // Fall back to cover art from a track by the SAME artist (not random episode art)
    // If no same-artist art exists, return null → UI shows gradient fallback
    const cover_art_url = seed.cover_art_url || artistCoverArt[seedArtistLower] || null;

    const has_exact_match = eps.some((e) => e.match_type === "full");

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
      total_playable: totalPlayable,
      total_processing: totalProcessing,
      total_unavailable: totalUnavailable,
      cover_art_url,
      has_exact_match,
    };
  })
    .filter((s) => s.episodes.length > 0); // Only seeds with episodes
    // Seeds are already sorted by created_at desc from the DB query (newest first)

  return NextResponse.json({ stacks, total_pending: globalPending });
}
