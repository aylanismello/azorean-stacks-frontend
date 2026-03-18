import { NextRequest, NextResponse } from "next/server";
import { supabase, getServiceClient } from "@/lib/supabase";
import { createServerClient } from "@supabase/ssr";

export const dynamic = "force-dynamic";

// GET /api/episodes/[id]/tracks
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const db = getServiceClient();
  // Query through episode_tracks junction table, order by tracklist position
  // Include seed_track_id so we can identify the seed track in the tracklist
  const { data: junctionRows, error } = await db
    .from("episode_tracks")
    .select("position, tracks(id, artist, title, status, spotify_url, youtube_url, storage_path, cover_art_url, preview_url, dl_attempts, dl_failed_at, seed_track_id)")
    .eq("episode_id", params.id)
    .order("position", { ascending: true, nullsFirst: false });

  // Flatten: extract the nested track object from each junction row
  const data = (junctionRows || [])
    .map((row: any) => row.tracks)
    .filter(Boolean);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Optional seed_id scoping — when viewing from a specific seed context,
  // only mark tracks relative to that seed (not all seeds linked to this episode)
  const contextSeedId = req.nextUrl.searchParams.get("seed_id");

  // Look up which seeds are connected to this episode
  let episodeSeedQuery = db
    .from("episode_seeds")
    .select("seed_id, match_type, seeds(id, artist, title, source, track_id)")
    .eq("episode_id", params.id);

  if (contextSeedId) {
    episodeSeedQuery = episodeSeedQuery.eq("seed_id", contextSeedId);
  }

  const { data: episodeSeedRows } = await episodeSeedQuery;

  // Build sets for seed matching: prefer direct track_id, fall back to artist::title
  const seedTrackIds = new Set<string>();
  const reSeedTrackIds = new Set<string>();
  const seedPairs = new Set<string>();
  const reSeedPairs = new Set<string>();
  const seedArtists = new Set<string>();
  for (const row of (episodeSeedRows || []) as any[]) {
    const seed = Array.isArray(row.seeds) ? row.seeds[0] : row.seeds;
    const isReSeed = row.match_type === "re_seed" || row.match_type === "re-seed";
    const isArtistMatch = row.match_type === "artist" || row.match_type === "artist_match";
    if (isArtistMatch) {
      if (seed?.artist) {
        // Split comma-separated seed artists so each individual name matches
        for (const a of seed.artist.split(/,\s*/)) {
          seedArtists.add(a.toLowerCase().trim());
        }
      }
    } else {
      if (seed?.track_id) {
        if (isReSeed) {
          reSeedTrackIds.add(seed.track_id);
        } else {
          seedTrackIds.add(seed.track_id);
        }
      }
      if (seed?.artist && seed?.title) {
        const key = `${seed.artist.toLowerCase().trim()}::${seed.title.toLowerCase().trim()}`;
        if (isReSeed) {
          reSeedPairs.add(key);
        } else {
          seedPairs.add(key);
        }
      }
    }
  }

  const trackIds = data.map((t: any) => t.id);

  // Get super_liked + vote status from user_tracks (try to get authed user)
  const superLikedIds = new Set<string>();
  const voteStatusMap = new Map<string, string>();
  try {
    const authClient = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() { return req.cookies.getAll(); },
          setAll() {},
        },
      }
    );
    const { data: { user } } = await authClient.auth.getUser();
    if (user && trackIds.length > 0) {
      const { data: utRows } = await db
        .from("user_tracks")
        .select("track_id, super_liked, status")
        .eq("user_id", user.id)
        .in("track_id", trackIds);
      for (const ut of (utRows || []) as any[]) {
        if (ut.super_liked) superLikedIds.add(ut.track_id);
        if (ut.status) voteStatusMap.set(ut.track_id, ut.status);
      }
    }
  } catch {}

  // Generate signed URLs for tracks with storage_path
  const tracks = data || [];
  const signPromises: Promise<void>[] = [];

  for (const track of tracks) {
    // Add seed/re-seed/super_liked flags (prefer direct track_id match, fall back to artist::title)
    const trackKey = `${track.artist.toLowerCase().trim()}::${track.title.toLowerCase().trim()}`;
    (track as any).is_seed = seedTrackIds.has(track.id) || seedPairs.has(trackKey);
    (track as any).is_re_seed = reSeedTrackIds.has(track.id) || reSeedPairs.has(trackKey);
    // Multi-artist matching: split comma-separated artists and check each individually
    const trackArtists = track.artist.split(/,\s*/).map((a: string) => a.toLowerCase().trim());
    (track as any).is_artist_seed = !(track as any).is_seed && trackArtists.some((a: string) => seedArtists.has(a));
    (track as any).super_liked = superLikedIds.has(track.id);
    (track as any).vote_status = voteStatusMap.get(track.id) || null;

    if (track.storage_path) {
      signPromises.push(
        supabase.storage
          .from("tracks")
          .createSignedUrl(track.storage_path, 3600)
          .then(({ data: signed }) => {
            if (signed) (track as any).audio_url = signed.signedUrl;
          })
      );
    }
  }

  await Promise.all(signPromises);

  return NextResponse.json(tracks);
}
