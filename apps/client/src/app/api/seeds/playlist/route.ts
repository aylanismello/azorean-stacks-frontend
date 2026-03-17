import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

function extractPlaylistId(url: string): string | null {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const idx = parts.indexOf("playlist");
    if (idx !== -1 && idx + 1 < parts.length) {
      return parts[idx + 1].split("?")[0];
    }
    return null;
  } catch {
    return null;
  }
}

async function getClientCredentialsToken(): Promise<string | null> {
  const clientId = process.env.SPOTIFY_CLIENT_ID!;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET!;

  const tokenController = new AbortController();
  const tokenTimeout = setTimeout(() => tokenController.abort(), 8000);
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body: "grant_type=client_credentials",
    signal: tokenController.signal,
  });
  clearTimeout(tokenTimeout);

  if (!res.ok) return null;
  const data = await res.json();
  return data.access_token || null;
}

async function fetchPlaylistTracks(
  playlistId: string,
  token: string
): Promise<{ artist: string; title: string }[]> {
  const tracks: { artist: string; title: string }[] = [];
  let url: string | null =
    `https://api.spotify.com/v1/playlists/${playlistId}/tracks` +
    `?fields=next,items(track(name,artists(name),type))&limit=100`;

  while (url) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    const res: Response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) break;
    const data = await res.json();

    for (const item of data.items || []) {
      if (!item.track || item.track.type === "local") continue;
      const title = item.track.name?.trim();
      const artist = item.track.artists?.[0]?.name?.trim();
      if (title && artist) tracks.push({ title, artist });
    }

    url = data.next || null;
  }

  return tracks;
}

// POST /api/seeds/playlist
export async function POST(req: NextRequest) {
  const supabase = getServiceClient();
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

  const body = await req.json();
  const { playlist_url } = body;

  const playlistId = extractPlaylistId(playlist_url);
  if (!playlistId) {
    return NextResponse.json({ error: "Invalid playlist URL" }, { status: 400 });
  }

  // Get Spotify token via client credentials (works for public playlists)
  const token = await getClientCredentialsToken();
  if (!token) {
    return NextResponse.json(
      { error: "Failed to get Spotify access token" },
      { status: 502 }
    );
  }

  // Fetch all tracks from the playlist
  let tracks: { artist: string; title: string }[];
  try {
    tracks = await fetchPlaylistTracks(playlistId, token);
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch playlist tracks" },
      { status: 502 }
    );
  }

  if (tracks.length === 0) {
    return NextResponse.json(
      { error: "Playlist is empty or not accessible" },
      { status: 404 }
    );
  }

  // Load existing seeds for this user to check for duplicates
  const { data: existingSeeds } = await supabase
    .from("seeds")
    .select("artist, title")
    .or(`user_id.eq.${user.id},user_id.is.null`);

  const existingSet = new Set(
    (existingSeeds || []).map(
      (s) => `${s.artist.toLowerCase()}::${s.title.toLowerCase()}`
    )
  );

  // Filter out duplicates
  const newTracks = tracks.filter(
    ({ artist, title }) =>
      !existingSet.has(`${artist.toLowerCase()}::${title.toLowerCase()}`)
  );

  const skipped = tracks.length - newTracks.length;

  if (newTracks.length === 0) {
    return NextResponse.json({ added: 0, skipped, total: tracks.length });
  }

  // Batch insert seeds
  const now = new Date();
  const timeStr = now.toTimeString().slice(0, 8);

  const seedRows = newTracks.map(({ artist, title }) => ({
    artist,
    title,
    track_id: null,
    user_id: user.id,
    source: "manual",
    pipeline_status: {
      state: "queued",
      started_at: now.toISOString(),
      log: [{ t: timeStr, msg: "seed created from playlist, queued for discovery" }],
    },
  }));

  // Insert in chunks of 50
  let added = 0;
  for (let i = 0; i < seedRows.length; i += 50) {
    const { error } = await supabase.from("seeds").insert(seedRows.slice(i, i + 50));
    if (!error) added += Math.min(50, seedRows.length - i);
  }

  return NextResponse.json({ added, skipped, total: tracks.length }, { status: 201 });
}
