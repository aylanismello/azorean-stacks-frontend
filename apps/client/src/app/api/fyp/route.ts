import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { getServiceClient } from "@/lib/supabase";
import { diversifyTracks } from "@/lib/diversify";

export const dynamic = "force-dynamic";

function getAuthClient(req: NextRequest) {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return req.cookies.getAll(); },
        setAll() {},
      },
    }
  );
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const limit = parseInt(searchParams.get("limit") || "20", 10);
  const offset = parseInt(searchParams.get("offset") || "0", 10);
  const seedId = searchParams.get("seed_id") || null;
  const genre = searchParams.get("genre") || null;
  const seedArtist = searchParams.get("seed_artist") || null;
  const hideLow = searchParams.get("hide_low") === "true";

  // Auth
  const auth = getAuthClient(req);
  const { data: { user } } = await auth.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = getServiceClient();

  // Call the RPC
  const { data: tracks, error } = await db.rpc("get_fyp_tracks", {
    p_user_id: user.id,
    p_limit: limit,
    p_offset: offset,
    p_seed_id: seedId,
    p_genre: genre,
    p_seed_artist: seedArtist,
    p_hide_low: hideLow,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = tracks || [];

  // Fetch seed_track and episode joins in bulk
  const trackIds = rows.map((t: any) => t.id);
  const seedTrackIds = Array.from(new Set(rows.map((t: any) => t.seed_track_id).filter(Boolean)));
  const episodeIds = Array.from(new Set(rows.map((t: any) => t.episode_id).filter(Boolean)));

  const [seedTrackRes, episodeRes, esRes] = await Promise.all([
    seedTrackIds.length > 0
      ? db.from("tracks").select("id, artist, title").in("id", seedTrackIds)
      : { data: [] },
    episodeIds.length > 0
      ? db.from("episodes").select("id, title, source, aired_date, artwork_url, url").in("id", episodeIds)
      : { data: [] },
    episodeIds.length > 0
      ? db.from("episode_seeds").select("episode_id, match_type").in("episode_id", episodeIds)
      : { data: [] },
  ]);

  const seedTrackMap = new Map((seedTrackRes.data || []).map((s: any) => [s.id, s]));
  const episodeMap = new Map((episodeRes.data || []).map((e: any) => [e.id, e]));

  // Best match_type per episode
  const matchTypeMap = new Map<string, string>();
  for (const link of (esRes.data || [])) {
    const existing = matchTypeMap.get(link.episode_id);
    if (!existing || link.match_type === "full") {
      matchTypeMap.set(link.episode_id, link.match_type || "unknown");
    }
  }

  // Sign audio URLs and attach joins
  const signPromises: Promise<void>[] = [];
  for (const track of rows) {
    track.seed_track = seedTrackMap.get(track.seed_track_id) || null;
    track.episode = episodeMap.get(track.episode_id) || null;
    track._match_type = matchTypeMap.get(track.episode_id) || null;
    // Seed classification columns from RPC (stored on tracks table)
    track.is_seed = track.is_seed ?? false;
    track.is_re_seed = track.is_re_seed ?? false;
    track.is_artist_seed = track.is_artist_seed ?? false;
    const meta = (track.metadata || {}) as Record<string, unknown>;
    track._score_components = (meta._score_components as Record<string, number>) || {};
    track._ranked_score = track.taste_score ?? 0;

    if (track.storage_path) {
      signPromises.push(
        db.storage
          .from("tracks")
          .createSignedUrl(track.storage_path, 3600)
          .then(({ data: signed }) => {
            if (signed) track.audio_url = signed.signedUrl;
          })
      );
    }
  }
  await Promise.all(signPromises);

  // Diversify and return
  const diversified = diversifyTracks(rows);

  // Estimate total from a count query
  const { count } = await db
    .from("tracks")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending")
    .not("storage_path", "is", null);

  return NextResponse.json({ tracks: diversified, total: count ?? rows.length });
}
