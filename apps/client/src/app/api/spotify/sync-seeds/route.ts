import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const PLAYLIST_NAME = "Azorean Stacks";
const SUPERLIKE_PLAYLIST_NAME = "Azorean Super Likes";

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

async function findOrCreatePlaylist(
  token: string,
  userId: string,
  name: string,
  description: string
): Promise<{ id: string; url: string | null }> {
  // Search existing playlists (paginate up to 200)
  let offset = 0;
  const limit = 50;
  while (true) {
    const playlistsRes = await spotifyFetch(
      `https://api.spotify.com/v1/me/playlists?limit=${limit}&offset=${offset}`,
      token
    );
    if (!playlistsRes.ok) break;
    const playlists = await playlistsRes.json();
    const items = playlists.items || [];

    for (const p of items) {
      if (p.name === name) {
        return { id: p.id, url: p.external_urls?.spotify || null };
      }
    }

    if (items.length < limit) break;
    offset += limit;
    if (offset > 200) break;
  }

  // Create if not found
  const createRes = await spotifyFetch(
    `https://api.spotify.com/v1/users/${encodeURIComponent(userId)}/playlists`,
    token,
    {
      method: "POST",
      body: JSON.stringify({ name, description, public: false }),
    }
  );
  if (!createRes.ok) {
    const err = await createRes.text();
    throw new Error(`Failed to create playlist "${name}": ${err}`);
  }
  const created = await createRes.json();
  return { id: created.id, url: created.external_urls?.spotify || null };
}

async function syncTracksToPlaylist(
  token: string,
  playlistId: string,
  uris: string[]
): Promise<void> {
  if (uris.length === 0) return;

  const chunks = chunkArray(uris, 100);

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
    throw new Error(`Failed to sync tracks: ${err}`);
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

  // 2. Get all approved tracks with spotify_url, ordered by voted_at (newest first)
  const { data: approvedTracks, error: tracksError } = await supabase
    .from("tracks")
    .select("id, spotify_url")
    .eq("status", "approved")
    .not("spotify_url", "is", null)
    .neq("spotify_url", "")
    .order("voted_at", { ascending: false, nullsFirst: false });

  if (tracksError) {
    return NextResponse.json({ error: tracksError.message }, { status: 500 });
  }

  // 3. Get super-liked tracks (most recent first)
  const { data: superLikedRows } = await supabase
    .from("user_tracks")
    .select("track_id, tracks(spotify_url)")
    .eq("super_liked", true)
    .order("voted_at", { ascending: false, nullsFirst: false });

  // 4. Collect spotify URIs from seed-linked tracks + approved tracks
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

  // Combine: approved tracks first (preserving voted_at order), then seed tracks
  const seenUrls = new Set<string>();
  const spotifyUris: string[] = [];

  // Approved tracks first — order matches what the user sees
  for (const t of approvedTracks || []) {
    if (t.spotify_url && !seenUrls.has(t.spotify_url)) {
      seenUrls.add(t.spotify_url);
      const uri = urlToUri(t.spotify_url);
      if (uri) spotifyUris.push(uri);
    }
  }

  // Then seed-linked tracks (if not already included)
  for (const url of Object.values(seedTrackUrls)) {
    if (url && !seenUrls.has(url)) {
      seenUrls.add(url);
      const uri = urlToUri(url);
      if (uri) spotifyUris.push(uri);
    }
  }

  // Collect super-liked URIs
  const superLikeUris: string[] = [];
  const seenSuperUrls = new Set<string>();
  for (const row of superLikedRows || []) {
    const track = row.tracks as unknown as { spotify_url: string | null } | null;
    const spotifyUrl = track?.spotify_url;
    if (spotifyUrl && !seenSuperUrls.has(spotifyUrl)) {
      seenSuperUrls.add(spotifyUrl);
      const uri = urlToUri(spotifyUrl);
      if (uri) superLikeUris.push(uri);
    }
  }

  if (spotifyUris.length === 0 && superLikeUris.length === 0) {
    return NextResponse.json({
      error: "No tracks with Spotify URLs found",
      synced: 0,
    }, { status: 200 });
  }

  // 5. Get Spotify user ID
  const meRes = await spotifyFetch("https://api.spotify.com/v1/me", token);
  if (!meRes.ok) {
    return NextResponse.json({ error: "Failed to get Spotify user" }, { status: 502 });
  }
  const me = await meRes.json();
  const userId = me.id;

  let mainPlaylistUrl: string | null = null;
  let mainPlaylistId: string | null = null;
  let superPlaylistUrl: string | null = null;
  let superPlaylistId: string | null = null;

  // 6. Sync main playlist
  if (spotifyUris.length > 0) {
    try {
      const mainPlaylist = await findOrCreatePlaylist(
        token, userId, PLAYLIST_NAME, "Approved tracks from Azorean Stacks"
      );
      mainPlaylistId = mainPlaylist.id;
      mainPlaylistUrl = mainPlaylist.url;
      await syncTracksToPlaylist(token, mainPlaylist.id, spotifyUris);
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Failed to sync main playlist" },
        { status: 502 }
      );
    }
  }

  // 7. Sync super-likes playlist
  if (superLikeUris.length > 0) {
    try {
      const superPlaylist = await findOrCreatePlaylist(
        token, userId, SUPERLIKE_PLAYLIST_NAME, "Super-liked tracks from Azorean Stacks"
      );
      superPlaylistId = superPlaylist.id;
      superPlaylistUrl = superPlaylist.url;
      await syncTracksToPlaylist(token, superPlaylist.id, superLikeUris);
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Failed to sync super-likes playlist" },
        { status: 502 }
      );
    }
  }

  return NextResponse.json({
    synced: spotifyUris.length,
    playlist_url: mainPlaylistUrl,
    playlist_id: mainPlaylistId,
    super_likes_synced: superLikeUris.length,
    super_likes_playlist_url: superPlaylistUrl,
    super_likes_playlist_id: superPlaylistId,
  });
}

function urlToUri(url: string): string | null {
  try {
    if (!url) return null;
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    // Handle both /track/ID and /intl-xx/track/ID formats
    const trackIdx = parts.indexOf("track");
    if (trackIdx !== -1 && trackIdx + 1 < parts.length) {
      return `spotify:track:${parts[trackIdx + 1]}`;
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
