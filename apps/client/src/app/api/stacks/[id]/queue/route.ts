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
  weights,
}: {
  matchType: "full" | "artist" | "unknown";
  episodeApprovalRate: number;
  episodeSampleSize: number;
  artistFamiliar: boolean;
  artistInSeeds: boolean;
  recencyNorm: number;
  coOccurrenceCount: number;
  maxCoOccurrence: number;
  weights: typeof DEFAULT_WEIGHTS;
}) {
  // Seed proximity: full match episodes are stronger signal
  const proximity = matchType === "full" ? weights.seed_proximity : matchType === "artist" ? weights.seed_proximity / 3 : 0;

  // Source quality: episodes where A.F.M approved tracks rank higher
  // Default to 50% if fewer than 3 samples to avoid cold-start penalty
  const rate = episodeSampleSize >= 3 ? episodeApprovalRate : 0.5;
  const quality = rate * weights.source_quality;

  // Artist familiarity: known approved artists or seeded artists rank higher
  const familiarity = artistFamiliar ? weights.artist_familiarity : artistInSeeds ? weights.artist_familiarity / 2 : 0;

  // Recency: newer discoveries get a slight boost
  const recency = recencyNorm * weights.recency;

  // Co-occurrence: artist appearing in more episodes tied to this seed = stronger signal
  const coOccurrence =
    maxCoOccurrence > 0
      ? (Math.min(coOccurrenceCount, maxCoOccurrence) / maxCoOccurrence) * weights.co_occurrence
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
  const { data: rawPendingTracks } = await db
    .from("tracks")
    .select(
      "id, artist, title, source, status, episode_id, cover_art_url, spotify_url, youtube_url, storage_path, preview_url, metadata, created_at, seed_track_id, taste_score, seed_track:tracks!seed_track_id(artist, title), episode:episodes!episode_id(id, title, source, aired_date, artwork_url)"
    )
    .in("episode_id", episodeIds)
    .eq("status", "pending");

  // Filter out tracks the user has already listened to (heard past 80% without voting)
  const { data: listenedRows } = await db
    .from("user_tracks")
    .select("track_id")
    .eq("user_id", user.id)
    .eq("status", "listened");

  const listenedTrackIds = new Set((listenedRows || []).map((r: any) => r.track_id));
  const pendingTracks = (rawPendingTracks || []).filter((t: any) => !listenedTrackIds.has(t.id));

  if (!pendingTracks?.length) {
    return NextResponse.json({
      tracks: [],
      total: 0,
      seed: { id: seed.id, artist: seed.artist, title: seed.title },
    });
  }

  // 4. Load user's latest taste weights (fall back to defaults if not tuned yet)
  const { data: latestWeights } = await db
    .from("taste_weights")
    .select("seed_proximity, source_quality, artist_familiarity, recency, co_occurrence")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const weights: typeof DEFAULT_WEIGHTS = latestWeights
    ? {
        seed_proximity: latestWeights.seed_proximity,
        source_quality: latestWeights.source_quality,
        artist_familiarity: latestWeights.artist_familiarity,
        recency: latestWeights.recency,
        co_occurrence: latestWeights.co_occurrence,
      }
    : { ...DEFAULT_WEIGHTS };

  // 5. Per-episode approval stats (for quality score + negative scoring)
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

  // 6. Approved artists globally (familiarity signal)
  const { data: approvedArtistRows } = await db
    .from("tracks")
    .select("artist")
    .eq("status", "approved")
    .limit(1000);

  const approvedArtistsLower = new Set(
    (approvedArtistRows || []).map((t: any) => (t.artist || "").toLowerCase())
  );

  // 7. All seed artists (secondary familiarity boost)
  const { data: allSeeds } = await db
    .from("seeds")
    .select("artist")
    .or(`user_id.eq.${user.id},user_id.is.null`);

  const seedArtistsLower = new Set(
    (allSeeds || []).map((s: any) => (s.artist || "").toLowerCase())
  );

  // 8. Co-occurrence: for each artist, how many of this seed's episodes feature them
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

  // 9. Recency normalization across all pending tracks
  const timestamps = (pendingTracks as any[]).map((t) =>
    new Date(t.created_at).getTime()
  );
  const minTs = Math.min(...timestamps);
  const maxTs = Math.max(...timestamps);
  const tsRange = maxTs - minTs || 1;

  // ── Negative signal data ──────────────────────────────────────────────────

  // 10a. Artists the user has rejected (for -10pt penalty)
  const { data: userRejectedArtistRows } = await db
    .from("user_tracks")
    .select("track_id")
    .eq("user_id", user.id)
    .eq("status", "rejected");

  const rejectedTrackIds = (userRejectedArtistRows || []).map((r: any) => r.track_id);
  const rejectedArtistsLower = new Set<string>();
  if (rejectedTrackIds.length > 0) {
    const { data: rejectedArtistData } = await db
      .from("tracks")
      .select("artist")
      .in("id", rejectedTrackIds);
    for (const t of (rejectedArtistData || []) as any[]) {
      if (t.artist) rejectedArtistsLower.add(t.artist.toLowerCase());
    }
  }

  // 10b. Episode rejection rates for user (for -5pt and -15pt penalties)
  // Map: episode_id → { approved, rejected } from user_tracks
  const userEpStats = new Map<string, { approved: number; rejected: number }>();
  if (rejectedTrackIds.length > 0 || approvedArtistsLower.size > 0) {
    const { data: userEpVotes } = await db
      .from("user_tracks")
      .select("track_id, status")
      .eq("user_id", user.id)
      .in("status", ["approved", "rejected"]);

    // Get track→episode mapping for voted tracks
    const votedTrackIds = (userEpVotes || []).map((v: any) => v.track_id);
    if (votedTrackIds.length > 0) {
      const { data: votedTrackEpisodes } = await db
        .from("tracks")
        .select("id, episode_id")
        .in("id", votedTrackIds);

      const trackToEp = new Map((votedTrackEpisodes || []).map((t: any) => [t.id, t.episode_id]));
      for (const v of (userEpVotes || []) as any[]) {
        const epId = trackToEp.get(v.track_id);
        if (!epId) continue;
        const s = userEpStats.get(epId) || { approved: 0, rejected: 0 };
        if (v.status === "approved") s.approved++;
        else s.rejected++;
        userEpStats.set(epId, s);
      }
    }
  }

  // ── Momentum scoring (last 10 actions in current session = 2h) ────────────
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const { data: recentActions } = await db
    .from("user_tracks")
    .select("track_id, status, voted_at")
    .eq("user_id", user.id)
    .in("status", ["approved", "skipped"])
    .gte("voted_at", twoHoursAgo)
    .order("voted_at", { ascending: false })
    .limit(10);

  // Map: episode_id → { approvals, skips } from this session
  const sessionEpMomentum = new Map<string, { approvals: number; skips: number }>();
  if ((recentActions || []).length > 0) {
    const recentTrackIds = (recentActions || []).map((a: any) => a.track_id);
    const { data: recentTrackEps } = await db
      .from("tracks")
      .select("id, episode_id")
      .in("id", recentTrackIds);

    const recentTrackToEp = new Map((recentTrackEps || []).map((t: any) => [t.id, t.episode_id]));
    for (const a of (recentActions || []) as any[]) {
      const epId = recentTrackToEp.get(a.track_id);
      if (!epId) continue;
      const m = sessionEpMomentum.get(epId) || { approvals: 0, skips: 0 };
      if (a.status === "approved") m.approvals++;
      else m.skips++;
      sessionEpMomentum.set(epId, m);
    }
  }

  // 11. Score and sort
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

    const { total: baseTotal, components } = scoreTrack({
      matchType: matchType as "full" | "artist" | "unknown",
      episodeApprovalRate: approvalRate,
      episodeSampleSize: epTotal,
      artistFamiliar: approvedArtistsLower.has(artistLower),
      artistInSeeds: seedArtistsLower.has(artistLower),
      recencyNorm,
      coOccurrenceCount: coCount,
      maxCoOccurrence,
      weights,
    });

    // ── Negative signal penalties ──────────────────────────────────────────
    let penalty = 0;

    // Artist previously rejected by user → -10pts
    if (rejectedArtistsLower.has(artistLower)) {
      penalty += 10;
    }

    // Episode has >50% user rejection rate → -15pts (track from bad episode)
    const userEpStat = userEpStats.get(epId);
    if (userEpStat) {
      const userEpTotal = userEpStat.approved + userEpStat.rejected;
      if (userEpTotal >= 3) {
        const userRejRate = userEpStat.rejected / userEpTotal;
        if (userRejRate > 0.5) {
          penalty += 15;
        }
      }
    }

    // Episode source/curator global rejection rate >50% → -5pts
    if (epTotal >= 3 && (1 - approvalRate) > 0.5) {
      penalty += 5;
    }

    // ── Momentum boost/demotion ────────────────────────────────────────────
    let momentumDelta = 0;
    const momentum = sessionEpMomentum.get(epId);
    if (momentum) {
      if (momentum.approvals >= 3) momentumDelta = +15;
      else if (momentum.skips >= 3) momentumDelta = -10;
    }

    const total = Math.max(0, baseTotal - penalty + momentumDelta);

    // Normalize joins
    const seedTrack = Array.isArray(t.seed_track)
      ? t.seed_track[0] || null
      : t.seed_track;
    const episode = Array.isArray(t.episode)
      ? t.episode[0] || null
      : t.episode;

    // Mark as seed track if this track's artist+title matches the seed track it was discovered from
    const normalizedSeedTrack = seedTrack?.artist ? seedTrack : null;
    const isSeed = !!(
      normalizedSeedTrack &&
      normalizedSeedTrack.artist.toLowerCase().trim() === (t.artist || "").toLowerCase().trim() &&
      normalizedSeedTrack.title.toLowerCase().trim() === (t.title || "").toLowerCase().trim()
    );

    return {
      ...t,
      seed_track: normalizedSeedTrack,
      episode,
      is_seed: isSeed,
      _ranked_score: Math.round(total),
      _score_components: {
        ...components,
        penalty: -Math.round(penalty),
        momentum: Math.round(momentumDelta),
      },
      _match_type: matchType,
      _seed_name: seedLabel,
    };
  });

  scored.sort((a: any, b: any) => b._ranked_score - a._ranked_score);

  // 12. Generate signed audio URLs in parallel
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
    weights_used: weights,
    using_default_weights: !latestWeights,
  });
}
