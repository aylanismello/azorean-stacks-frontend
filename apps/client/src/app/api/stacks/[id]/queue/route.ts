import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { getServiceClient } from "@/lib/supabase";
import { diversifyTracks } from "@/lib/diversify";

export const dynamic = "force-dynamic";

// GET /api/stacks/[id]/queue
// Returns pending tracks for a seed, sorted by pre-computed taste_score.
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

  // 2. Get episode IDs + match types for this seed
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

  const episodeMatchTypes = new Map<string, string>(
    (episodeSeedLinks as any[]).map((l) => [
      l.episode_id,
      l.match_type || "artist",
    ])
  );
  const episodeIds = Array.from(episodeMatchTypes.keys());

  // 3. Fetch tracks with audio from these episodes, sorted by pre-computed taste_score
  const { data: rawTracks } = await db
    .from("tracks")
    .select(
      "id, artist, title, source, source_url, source_context, status, episode_id, cover_art_url, spotify_url, youtube_url, storage_path, preview_url, metadata, created_at, seed_track_id, taste_score, seed_track:tracks!seed_track_id(artist, title), episode:episodes!episode_id(id, title, source, aired_date, artwork_url, url)"
    )
    .in("episode_id", episodeIds)
    .eq("status", "pending")
    .not("storage_path", "is", null)
    .order("taste_score", { ascending: false, nullsFirst: false });

  // 4. Filter out ALL tracks the user has voted on (any status in user_tracks)
  const allExcluded: string[] = [];
  let excludePage = 0;
  while (true) {
    const { data: batch } = await db
      .from("user_tracks")
      .select("track_id")
      .eq("user_id", user.id)
      .in("status", ["approved", "rejected", "skipped", "bad_source", "listened"])
      .range(excludePage * 1000, (excludePage + 1) * 1000 - 1);
    if (!batch || batch.length === 0) break;
    allExcluded.push(...batch.map((r: any) => r.track_id));
    if (batch.length < 1000) break;
    excludePage++;
  }

  const excludedIds = new Set(allExcluded);
  const pendingTracks = (rawTracks || []).filter((t: any) => !excludedIds.has(t.id));

  // Fetch user votes for these tracks
  const trackIds = pendingTracks.map((t: any) => t.id);
  const userVoteMap = new Map<string, { status: string; super_liked: boolean }>();
  if (trackIds.length > 0) {
    const { data: votes } = await db
      .from("user_tracks")
      .select("track_id, status, super_liked")
      .eq("user_id", user.id)
      .in("track_id", trackIds);
    for (const v of (votes || []) as any[]) {
      userVoteMap.set(v.track_id, { status: v.status, super_liked: !!v.super_liked });
    }
  }

  if (!pendingTracks.length) {
    return NextResponse.json({
      tracks: [],
      total: 0,
      seed: { id: seed.id, artist: seed.artist, title: seed.title },
    });
  }

  // 5. Normalize joins & enrich response
  const seedLabel = `${seed.artist} — ${seed.title}`;

  const enriched = pendingTracks.map((t: any) => {
    const seedTrack = Array.isArray(t.seed_track)
      ? t.seed_track[0] || null
      : t.seed_track;
    const episode = Array.isArray(t.episode)
      ? t.episode[0] || null
      : t.episode;
    const normalizedSeedTrack = seedTrack?.artist ? seedTrack : null;

    const isSeed = !!(
      normalizedSeedTrack &&
      normalizedSeedTrack.artist.toLowerCase().trim() === (t.artist || "").toLowerCase().trim() &&
      normalizedSeedTrack.title.toLowerCase().trim() === (t.title || "").toLowerCase().trim()
    );

    const meta = (t.metadata || {}) as Record<string, unknown>;
    const userVote = userVoteMap.get(t.id);

    return {
      ...t,
      seed_track: normalizedSeedTrack,
      episode,
      is_seed: isSeed,
      status: userVote?.status || t.status || "pending",
      super_liked: userVote?.super_liked || false,
      vote_status: userVote?.status || null,
      _ranked_score: t.taste_score ?? 0,
      _score_components: (meta._score_components as Record<string, number>) || {},
      _match_type: episodeMatchTypes.get(t.episode_id) || "unknown",
      _seed_name: seedLabel,
      _seed_artist: seed.artist,
      _seed_title: seed.title,
    };
  });

  // 6. Apply diversity rules
  const diversified = diversifyTracks(enriched);

  // 7. Generate signed audio URLs (use allSettled so one failure doesn't break the queue)
  const signPromises: Promise<void>[] = [];
  for (const t of diversified) {
    if (t.storage_path) {
      signPromises.push(
        db.storage
          .from("tracks")
          .createSignedUrl(t.storage_path, 3600)
          .then(({ data: signed }: any) => {
            if (signed) t.audio_url = signed.signedUrl;
          })
          .catch(() => {}) // individual sign failure shouldn't break the queue
      );
    }
  }
  await Promise.all(signPromises);

  return NextResponse.json({
    tracks: diversified,
    total: diversified.length,
    seed: { id: seed.id, artist: seed.artist, title: seed.title },
  });
}
