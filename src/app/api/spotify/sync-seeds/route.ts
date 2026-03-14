import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const PLAYLIST_NAME = "My Seeds \u2014 Azorean Stacks";

async function getSpotifyToken(request: NextRequest): Promise<string | null> {
  // Try reading the access token from cookies directly
  const accessToken = request.cookies.get("spotify_access_token")?.value;
  const expiresStr = request.cookies.get("spotify_token_expires")?.value;
  const expiresAt = expiresStr ? Number(expiresStr) : 0;

  if (accessToken && expiresAt > Date.now() + 10_000) {
    return accessToken;
  }

  // Token expired — try refreshing
  const refreshToken = request.cookies.get("spotify_refresh_token")?.value;
  if (!refreshToken) return null;

  const clientId = process.env.SPOTIFY_CLIENT_ID!;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET!;

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }).toString(),
  });

  if (!res.ok) return null;
  const tokens = await res.json();
  return tokens.access_token || null;
}

async function spotifyFetch(url: string, token: string, options: RequestInit = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  return res;
}

export async function POST(request: NextRequest) {
  const token = await getSpotifyToken(request);
  if (!token) {
    return NextResponse.json({ error: "Spotify not connected" }, { status: 401 });
  }

  const supabase = getServiceClient();

  // 1. Get all seeds with their linked track's spotify_url
  const { data: seeds, error: seedsError } = await supabase
    .from("seeds")
    .select("id, track_id, artist, title");

  if (seedsError) {
    return NextResponse.json({ error: seedsError.message }, { status: 500 });
  }

  // 2. Get all approved tracks with spotify_url
  const { data: approvedTracks, error: tracksError } = await supabase
    .from("tracks")
    .select("id, spotify_url")
    .eq("status", "approved")
    .not("spotify_url", "is", null);

  if (tracksError) {
    return NextResponse.json({ error: tracksError.message }, { status: 500 });
  }

  // 3. Collect spotify URIs from seed-linked tracks + approved tracks
  const seedTrackIds = (seeds || []).map((s) => s.track_id).filter(Boolean) as string[];
  let seedTrackUrls: Record<string, string> = {};

  if (seedTrackIds.length > 0) {
    const { data: seedTracks } = await supabase
      .from("tracks")
      .select("id, spotify_url")
      .in("id", seedTrackIds)
      .not("spotify_url", "is", null);

    (seedTracks || []).forEach((t) => {
      if (t.spotify_url) seedTrackUrls[t.id] = t.spotify_url;
    });
  }

  // Combine: seed tracks + approved tracks (deduplicated by spotify_url)
  const spotifyUrlSet = new Set<string>();
  Object.values(seedTrackUrls).forEach((url) => spotifyUrlSet.add(url));
  (approvedTracks || []).forEach((t) => {
    if (t.spotify_url) spotifyUrlSet.add(t.spotify_url);
  });

  // Convert URLs to Spotify URIs
  const spotifyUris: string[] = [];
  Array.from(spotifyUrlSet).forEach((url) => {
    const uri = urlToUri(url);
    if (uri) spotifyUris.push(uri);
  });

  if (spotifyUris.length === 0) {
    return NextResponse.json({
      error: "No tracks with Spotify URLs found",
      synced: 0,
    }, { status: 200 });
  }

  // 4. Get Spotify user ID
  const meRes = await spotifyFetch("https://api.spotify.com/v1/me", token);
  if (!meRes.ok) {
    return NextResponse.json({ error: "Failed to get Spotify user" }, { status: 502 });
  }
  const me = await meRes.json();
  const userId = me.id;

  // 5. Find or create playlist
  let playlistId: string | null = null;
  let playlistUrl: string | null = null;

  // Check existing playlists (paginate up to 200)
  let offset = 0;
  const limit = 50;
  while (!playlistId) {
    const playlistsRes = await spotifyFetch(
      `https://api.spotify.com/v1/me/playlists?limit=${limit}&offset=${offset}`,
      token
    );
    if (!playlistsRes.ok) break;
    const playlists = await playlistsRes.json();
    const items = playlists.items || [];

    for (const p of items) {
      if (p.name === PLAYLIST_NAME) {
        playlistId = p.id;
        playlistUrl = p.external_urls?.spotify || null;
        break;
      }
    }

    if (items.length < limit) break;
    offset += limit;
    if (offset > 200) break;
  }

  // Create if not found
  if (!playlistId) {
    const createRes = await spotifyFetch(
      `https://api.spotify.com/v1/users/${encodeURIComponent(userId)}/playlists`,
      token,
      {
        method: "POST",
        body: JSON.stringify({
          name: PLAYLIST_NAME,
          description: "Seeds and approved tracks from Azorean Stacks",
          public: false,
        }),
      }
    );
    if (!createRes.ok) {
      const err = await createRes.text();
      return NextResponse.json({ error: `Failed to create playlist: ${err}` }, { status: 502 });
    }
    const created = await createRes.json();
    playlistId = created.id;
    playlistUrl = created.external_urls?.spotify || null;
  }

  // 6. Replace all tracks in the playlist (full sync)
  // Spotify allows max 100 URIs per request
  const chunks = chunkArray(spotifyUris, 100);

  // First chunk uses PUT to replace
  const firstRes = await spotifyFetch(
    `https://api.spotify.com/v1/playlists/${playlistId}/tracks`,
    token,
    {
      method: "PUT",
      body: JSON.stringify({ uris: chunks[0] }),
    }
  );
  if (!firstRes.ok) {
    const err = await firstRes.text();
    return NextResponse.json({ error: `Failed to sync tracks: ${err}` }, { status: 502 });
  }

  // Remaining chunks use POST to add
  for (let i = 1; i < chunks.length; i++) {
    await spotifyFetch(
      `https://api.spotify.com/v1/playlists/${playlistId}/tracks`,
      token,
      {
        method: "POST",
        body: JSON.stringify({ uris: chunks[i] }),
      }
    );
  }

  return NextResponse.json({
    synced: spotifyUris.length,
    playlist_url: playlistUrl,
    playlist_id: playlistId,
  });
}

function urlToUri(url: string): string | null {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length >= 2 && parts[0] === "track") {
      return `spotify:track:${parts[1]}`;
    }
    return null;
  } catch {
    return null;
  }
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
