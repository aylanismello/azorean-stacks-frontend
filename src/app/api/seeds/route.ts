import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

// GET /api/seeds
export async function GET() {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("seeds")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Get discovery counts — batch query all tracks with seed_track_ids in one go
  const seedTrackIds = (data || [])
    .map((s) => s.track_id)
    .filter(Boolean);

  let trackCounts: Record<string, number> = {};

  if (seedTrackIds.length > 0) {
    const { data: tracks } = await supabase
      .from("tracks")
      .select("seed_track_id")
      .in("seed_track_id", seedTrackIds);

    (tracks || []).forEach((t) => {
      if (t.seed_track_id) {
        trackCounts[t.seed_track_id] = (trackCounts[t.seed_track_id] || 0) + 1;
      }
    });
  }

  // Get episodes linked to each seed via episode_seeds
  const seedIds = (data || []).map((s) => s.id);
  let episodesBySeed: Record<string, Array<{ id: string; title: string | null; url: string; source: string; aired_date: string | null; match_type: string }>> = {};

  if (seedIds.length > 0) {
    const { data: episodeLinks } = await supabase
      .from("episode_seeds")
      .select("seed_id, match_type, episodes(id, title, url, source, aired_date)")
      .in("seed_id", seedIds);

    (episodeLinks || []).forEach((link: any) => {
      if (!link.episodes) return;
      if (!episodesBySeed[link.seed_id]) episodesBySeed[link.seed_id] = [];
      episodesBySeed[link.seed_id].push({ ...link.episodes, match_type: link.match_type || "unknown" });
    });
  }

  // Count curated episodes per seed (episodes where all tracks have been voted on)
  const allEpisodeIds = Array.from(new Set(Object.values(episodesBySeed).flat().map((ep) => ep.id)));
  const curatedEpisodeIds = new Set<string>();

  if (allEpisodeIds.length > 0) {
    // Get episodes that still have pending tracks
    const { data: pendingCounts } = await supabase
      .from("tracks")
      .select("episode_id")
      .in("episode_id", allEpisodeIds)
      .eq("status", "pending");

    const episodesWithPending = new Set((pendingCounts || []).map((t: any) => t.episode_id));

    // An episode is curated if it has no pending tracks
    allEpisodeIds.forEach((id) => {
      if (!episodesWithPending.has(id)) curatedEpisodeIds.add(id);
    });
  }

  const curatedCountBySeed: Record<string, number> = {};
  Object.entries(episodesBySeed).forEach(([seedId, eps]) => {
    curatedCountBySeed[seedId] = eps.filter((ep) => curatedEpisodeIds.has(ep.id)).length;
  });

  // Get latest completed discovery run per seed
  const { data: runs } = await supabase
    .from("discovery_runs")
    .select("seed_id, tracks_found, tracks_added, started_at")
    .in("seed_id", seedIds)
    .not("completed_at", "is", null)
    .order("started_at", { ascending: false });

  const lastRunBySeed: Record<string, { tracks_found: number; tracks_added: number; started_at: string }> = {};
  (runs || []).forEach((r: any) => {
    if (r.seed_id && !lastRunBySeed[r.seed_id]) {
      lastRunBySeed[r.seed_id] = { tracks_found: r.tracks_found, tracks_added: r.tracks_added, started_at: r.started_at };
    }
  });

  const seedsWithCounts = (data || []).map((seed) => ({
    ...seed,
    discovery_count: seed.track_id ? (trackCounts[seed.track_id] || 0) : 0,
    episodes: episodesBySeed[seed.id] || [],
    curated_count: curatedCountBySeed[seed.id] || 0,
    last_run: lastRunBySeed[seed.id] || null,
  }));

  return NextResponse.json(seedsWithCounts);
}

// Resolve a Spotify URL to artist + title (no API key needed)
async function resolveSpotifyUrl(url: string): Promise<{ artist: string; title: string } | null> {
  try {
    // Fetch the Spotify page HTML — <title> has format: "Track - song and lyrics by Artist | Spotify"
    // og:description has: "Artist · Album · Song · Year"
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; bot)" },
      redirect: "follow",
    });
    if (!res.ok) return null;
    const html = await res.text();

    // Try <title> first: "Track Name - song and lyrics by Artist | Spotify"
    const titleMatch = html.match(/<title>(.+?)<\/title>/);
    if (titleMatch) {
      const raw = titleMatch[1];
      const m = raw.match(/^(.+?)\s+-\s+song and lyrics by\s+(.+?)\s*\|\s*Spotify$/i)
        || raw.match(/^(.+?)\s+by\s+(.+?)\s*\|\s*Spotify$/i);
      if (m) {
        return { title: m[1].trim(), artist: m[2].trim() };
      }
    }

    // Fallback: og:description "Artist · Album · Song · Year" + og:title for track name
    const ogTitle = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/);
    const ogDesc = html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/);
    if (ogTitle && ogDesc) {
      const artist = ogDesc[1].split("·")[0].trim();
      if (artist) {
        return { title: ogTitle[1].trim(), artist };
      }
    }

    return null;
  } catch {
    return null;
  }
}

// Parse user input: Spotify URL, or "Artist - Title" / "Artist — Title"
async function parseInput(input: string): Promise<{ artist: string; title: string } | { error: string }> {
  const trimmed = input.trim();

  // Spotify URL
  if (trimmed.includes("open.spotify.com/track/")) {
    const result = await resolveSpotifyUrl(trimmed);
    if (!result) return { error: "Couldn't resolve Spotify link — try pasting Artist — Title instead" };
    return result;
  }

  // "Artist - Title" or "Artist — Title"
  const sep = trimmed.match(/\s+[-–—]\s+/);
  if (sep && sep.index !== undefined) {
    const artist = trimmed.slice(0, sep.index).trim();
    const title = trimmed.slice(sep.index + sep[0].length).trim();
    if (artist && title) return { artist, title };
  }

  return { error: "Enter a Spotify link or Artist — Title" };
}

// POST /api/seeds
export async function POST(req: NextRequest) {
  const supabase = getServiceClient();
  const body = await req.json();

  let artist: string;
  let title: string;

  if (body.input) {
    // New single-input flow
    const parsed = await parseInput(body.input);
    if ("error" in parsed) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    artist = parsed.artist;
    title = parsed.title;
  } else if (body.artist?.trim() && body.title?.trim()) {
    // Legacy two-field flow
    artist = body.artist.trim();
    title = body.title.trim();
  } else {
    return NextResponse.json(
      { error: "Enter a Spotify link or Artist — Title" },
      { status: 400 }
    );
  }

  // Duplicate check
  const { data: existingSeed } = await supabase
    .from("seeds")
    .select("id")
    .ilike("artist", artist)
    .ilike("title", title)
    .limit(1)
    .maybeSingle();

  if (existingSeed) {
    return NextResponse.json({ error: "Seed already exists" }, { status: 409 });
  }

  // Optionally link to existing track
  const { data: existingTrack } = await supabase
    .from("tracks")
    .select("id")
    .ilike("artist", artist)
    .ilike("title", title)
    .limit(1)
    .maybeSingle();

  const source = body.source?.trim() || null;

  const { data, error } = await supabase
    .from("seeds")
    .insert({
      artist,
      title,
      track_id: existingTrack?.id || null,
      ...(source ? { source } : {}),
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data, { status: 201 });
}
