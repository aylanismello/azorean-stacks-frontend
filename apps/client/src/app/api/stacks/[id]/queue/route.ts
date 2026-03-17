import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// Weighted scoring for ranked playback queue.
// Returns a score 0-100 for each pending track based on taste signals.
function scoreTrack({
  matchType,
  episodeApprovalRate,
  episodeSampleSize,
  artistFamiliar,
  artistInSeeds,
  recencyNorm,
  coOccurrenceCount,
  maxCoOccurrence,
}: {
  matchType: "full" | "artist" | "unknown";
  episodeApprovalRate: number;
  episodeSampleSize: number;
  artistFamiliar: boolean;
  artistInSeeds: boolean;
  recencyNorm: number;
  coOccurrenceCount: number;
  maxCoOccurrence: number;
}) {
  // Seed proximity (0-30): full match episodes are stronger signal
  const proximity = matchType === "full" ? 30 : matchType === "artist" ? 10 : 0;

  // Source quality (0-25): episodes where A.F.M approved tracks rank higher
  // Default to 50% if fewer than 3 samples to avoid cold-start penalty
  const rate = episodeSampleSize >= 3 ? episodeApprovalRate : 0.5;
  const quality = rate * 25;

  // Artist familiarity (0-20): known approved artists or seeded artists rank higher
  const familiarity = artistFamiliar ? 20 : artistInSeeds ? 10 : 0;

  // Recency (0-15): newer discoveries get a slight boost
  const recency = recencyNorm * 15;

  // Co-occurrence (0-10): artist appearing in more episodes tied to this seed = stronger signal
  const coOccurrence =
    maxCoOccurrence > 0
      ? (Math.min(coOccurrenceCount, maxCoOccurrence) / maxCoOccurrence) * 10
      : 0;

  const total = proximity + quality + familiarity + recency + coOccurrence;

  return {
    total,
    components: {
      proximity: Math.round(proximity),
      quality: Math.round(quality),
      familiarity: Math.round(familiarity),
      recency: Math.round(recency),
      co_occurrence: Math.round(coOccurrence),
    },
  };
}

// GET /api/stacks/[id]/queue
// Returns pending tracks for a seed, ranked by taste-weighted scoring.
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const db = getServiceClient();

  // Auth via anon key (reads user session from cookies)
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

  const seedId = params.id;

  // 1. Verify seed ownership
  const { data: seed, error: seedErr } = await db
    .from("seeds")
    .select("id, artist, title")
    .eq("id", seedId)
    .or(`user_id.eq.${user.id},user_id.is.null`)
    .single();

  if (seedErr || !seed) {
    return NextResponse.json({ error: "Seed not found" }, { status: 404 });
  }

  // 2. Get episode_seeds for this seed → episode IDs + match types
  const { data: episodeSeedLinks } = await db
    .from("episode_seeds")
    .select("episode_id, match_type")
    .eq("seed_id", seedId);

  if (!episodeSeedLinks?.length) {
    return NextResponse.json({
      tracks: [],
      total: 0,
      seed: { id: seed.id, artist: seed.artist, title: seed.title },
    });
  }

  const episodeMatchTypes = new Map<string, "full" | "artist">(
    (episodeSeedLinks as any[]).map((l) => [
      l.episode_id,
      (l.match_type as "full" | "artist") || "artist",
    ])
  );
  const episodeIds = Array.from(episodeMatchTypes.keys());

  // 3. Fetch all pending tracks from those episodes
  const { data: pendingTracks } = await db
    .from("tracks")
    .select(
      "id, artist, title, source, status, episode_id, cover_art_url, spotify_url, youtube_url, storage_path, preview_url, metadata, created_at, seed_track_id, taste_score, seed_track:tracks!seed_track_id(artist, title), episode:episodes!episode_id(id, title, source, aired_date, artwork_url)"
    )
    .in("episode_id", episodeIds)
    .eq("status", "pending");

  if (!pendingTracks?.length) {
    return NextResponse.json({
      tracks: [],
      total: 0,
      seed: { id: seed.id, artist: seed.artist, title: seed.title },
    });
  }

  // 4. Per-episode approval stats (for quality score)
  const { data: votedTracks } = await db
    .from("tracks")
    .select("episode_id, status")
    .in("episode_id", episodeIds)
    .in("status", ["approved", "rejected"]);

  const episodeStats = new Map<string, { approved: number; rejected: number }>();
  for (const t of (votedTracks || []) as any[]) {
    const s = episodeStats.get(t.episode_id) || { approved: 0, rejected: 0 };
    if (t.status === "approved") s.approved++;
    else s.rejected++;
    episodeStats.set(t.episode_id, s);
  }

  // 5. Approved artists globally (familiarity signal)
  const { data: approvedArtistRows } = await db
    .from("tracks")
    .select("artist")
    .eq("status", "approved")
    .limit(1000);

  const approvedArtistsLower = new Set(
    (approvedArtistRows || []).map((t: any) => (t.artist || "").toLowerCase())
  );

  // 6. All seed artists (secondary familiarity boost)
  const { data: allSeeds } = await db
    .from("seeds")
    .select("artist")
    .or(`user_id.eq.${user.id},user_id.is.null`);

  const seedArtistsLower = new Set(
    (allSeeds || []).map((s: any) => (s.artist || "").toLowerCase())
  );

  // 7. Co-occurrence: for each artist, how many of this seed's episodes feature them
  const artistEpisodeSets = new Map<string, Set<string>>();
  for (const t of pendingTracks as any[]) {
    const key = (t.artist || "").toLowerCase();
    if (!artistEpisodeSets.has(key)) artistEpisodeSets.set(key, new Set());
    if (t.episode_id) artistEpisodeSets.get(key)!.add(t.episode_id);
  }
  const maxCoOccurrence = Math.max(
    ...Array.from(artistEpisodeSets.values()).map((s) => s.size),
    1
  );

  // 8. Recency normalization across all pending tracks
  const timestamps = (pendingTracks as any[]).map((t) =>
    new Date(t.created_at).getTime()
  );
  const minTs = Math.min(...timestamps);
  const maxTs = Math.max(...timestamps);
  const tsRange = maxTs - minTs || 1;

  // 9. Score and sort
  const seedLabel = `${seed.artist} — ${seed.title}`;

  const scored = (pendingTracks as any[]).map((t) => {
    const epId = t.episode_id;
    const matchType = episodeMatchTypes.get(epId) ?? "unknown";
    const artistLower = (t.artist || "").toLowerCase();

    const epStat = episodeStats.get(epId) || { approved: 0, rejected: 0 };
    const epTotal = epStat.approved + epStat.rejected;
    const approvalRate =
      epTotal > 0 ? epStat.approved / epTotal : 0.5;

    const ts = new Date(t.created_at).getTime();
    const recencyNorm = (ts - minTs) / tsRange;
    const coCount = artistEpisodeSets.get(artistLower)?.size ?? 1;

    const { total, components } = scoreTrack({
      matchType: matchType as "full" | "artist" | "unknown",
      episodeApprovalRate: approvalRate,
      episodeSampleSize: epTotal,
      artistFamiliar: approvedArtistsLower.has(artistLower),
      artistInSeeds: seedArtistsLower.has(artistLower),
      recencyNorm,
      coOccurrenceCount: coCount,
      maxCoOccurrence,
    });

    // Normalize joins
    const seedTrack = Array.isArray(t.seed_track)
      ? t.seed_track[0] || null
      : t.seed_track;
    const episode = Array.isArray(t.episode)
      ? t.episode[0] || null
      : t.episode;

    return {
      ...t,
      seed_track: seedTrack?.artist ? seedTrack : null,
      episode,
      _ranked_score: Math.round(total),
      _score_components: components,
      _match_type: matchType,
      _seed_name: seedLabel,
    };
  });

  scored.sort((a: any, b: any) => b._ranked_score - a._ranked_score);

  // 10. Generate signed audio URLs in parallel
  const signPromises: Promise<void>[] = [];
  for (const t of scored) {
    if (t.storage_path) {
      signPromises.push(
        db.storage
          .from("tracks")
          .createSignedUrl(t.storage_path, 3600)
          .then(({ data: signed }) => {
            if (signed) t.audio_url = signed.signedUrl;
          })
      );
    }
  }
  await Promise.all(signPromises);

  return NextResponse.json({
    tracks: scored,
    total: scored.length,
    seed: { id: seed.id, artist: seed.artist, title: seed.title },
  });
}
