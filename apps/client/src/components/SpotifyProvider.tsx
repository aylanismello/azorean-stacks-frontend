"use client";

import { createContext, useContext, useEffect, useState, useCallback, useRef } from "react";

interface SpotifyContextType {
  connected: boolean;
  loading: boolean;
  deviceId: string | null;
  player: Spotify.Player | null;
  accessToken: string | null;
  connect: () => void;
  disconnect: () => Promise<void>;
  playUri: (uri: string) => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  seek: (positionMs: number) => Promise<void>;
  playerState: Spotify.PlaybackState | null;
}

const SpotifyContext = createContext<SpotifyContextType>({
  connected: false,
  loading: true,
  deviceId: null,
  player: null,
  accessToken: null,
  connect: () => {},
  disconnect: async () => {},
  playUri: async () => {},
  pause: async () => {},
  resume: async () => {},
  seek: async () => {},
  playerState: null,
});

export function useSpotify() {
  return useContext(SpotifyContext);
}

// Extend window for Spotify SDK
declare global {
  interface Window {
    onSpotifyWebPlaybackSDKReady?: () => void;
    Spotify?: typeof Spotify;
  }
}

const isMobile =
  typeof navigator !== "undefined" &&
  /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

async function fetchActiveDevice(token: string): Promise<string | null> {
  const res = await fetch("https://api.spotify.com/v1/me/player/devices", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const data = await res.json();
  const active = data.devices?.find((d: { is_active: boolean }) => d.is_active);
  return active?.id || data.devices?.[0]?.id || null;
}

export function SpotifyProvider({ children }: { children: React.ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [playerState, setPlayerState] = useState<Spotify.PlaybackState | null>(null);
  const [playing, setPlaying] = useState(false);
  const playerRef = useRef<Spotify.Player | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout>>();

  // Fetch/refresh the access token from our API
  const fetchToken = useCallback(async (): Promise<string | null> => {
    try {
      const res = await fetch("/api/spotify/token");
      const data = await res.json();
      if (data.connected && data.access_token) {
        setAccessToken(data.access_token);
        setConnected(true);

        // Schedule next refresh 60s before expiry
        const msUntilExpiry = data.expires_at - Date.now() - 60_000;
        if (msUntilExpiry > 0) {
          clearTimeout(refreshTimerRef.current);
          refreshTimerRef.current = setTimeout(() => fetchToken(), msUntilExpiry);
        }

        return data.access_token;
      } else {
        setConnected(false);
        setAccessToken(null);
        return null;
      }
    } catch {
      setConnected(false);
      setAccessToken(null);
      return null;
    }
  }, []);

  // Initialize SDK when we have a token (desktop only)
  const initPlayer = useCallback((token: string) => {
    if (isMobile) return;
    if (playerRef.current) return;
    if (!window.Spotify) return;

    const player = new window.Spotify.Player({
      name: "The Stacks",
      getOAuthToken: async (cb) => {
        // Always fetch fresh token
        const freshToken = await fetchToken();
        cb(freshToken || token);
      },
      volume: 0.8,
    });

    player.addListener("ready", ({ device_id }) => {
      setDeviceId(device_id);
    });

    player.addListener("not_ready", () => {
      setDeviceId(null);
    });

    player.addListener("player_state_changed", (state) => {
      setPlayerState(state);
    });

    player.addListener("initialization_error", ({ message }) => {
      console.error("Spotify init error:", message);
    });

    player.addListener("authentication_error", ({ message }) => {
      console.error("Spotify auth error:", message);
      setConnected(false);
    });

    player.addListener("account_error", ({ message }) => {
      console.error("Spotify account error:", message);
    });

    player.connect();
    playerRef.current = player;
  }, [fetchToken]);

  // Use a ref to avoid stale closure in SDK callback
  const tokenRef = useRef<string | null>(null);
  tokenRef.current = accessToken;

  // Load SDK script (desktop only)
  const loadSDK = useCallback(() => {
    if (isMobile) return;
    if (document.getElementById("spotify-sdk")) return;

    window.onSpotifyWebPlaybackSDKReady = () => {
      // SDK is ready — if we have a token, init the player
      const token = tokenRef.current;
      if (token) {
        initPlayer(token);
      }
    };

    const script = document.createElement("script");
    script.id = "spotify-sdk";
    script.src = "https://sdk.scdn.co/spotify-player.js";
    script.async = true;
    document.body.appendChild(script);
  }, [initPlayer]);

  // On mount: check if Spotify is connected
  useEffect(() => {
    fetchToken().then(async (token) => {
      setLoading(false);
      if (token) {
        if (isMobile) {
          // On mobile, auto-fetch the active device
          const device = await fetchActiveDevice(token);
          if (device) setDeviceId(device);
        } else {
          loadSDK();
        }

        // Auto-sync playlist after fresh Spotify connect
        const params = new URLSearchParams(window.location.search);
        if (params.get("spotify_connected")) {
          fetch("/api/spotify/sync-seeds", { method: "POST" })
            .then((res) => res.json())
            .then((data) => {
              if (data.synced > 0) {
                console.log(`Synced ${data.synced} tracks to Spotify playlist`);
              }
            })
            .catch(() => {});
          // Clean up URL param
          const url = new URL(window.location.href);
          url.searchParams.delete("spotify_connected");
          window.history.replaceState({}, "", url.toString());
        }
      }
    });

    return () => {
      clearTimeout(refreshTimerRef.current);
      playerRef.current?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When token becomes available and SDK is loaded, init player (desktop only)
  useEffect(() => {
    if (!isMobile && accessToken && window.Spotify && !playerRef.current) {
      initPlayer(accessToken);
    }
  }, [accessToken, initPlayer]);

  // On mobile, poll playback state every 1 second while playing
  useEffect(() => {
    if (!isMobile || !connected || !playing) return;
    const interval = setInterval(async () => {
      const token = await fetchToken();
      if (!token) return;
      const res = await fetch("https://api.spotify.com/v1/me/player", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok && res.status !== 204) {
        const state = await res.json();
        setPlayerState({
          paused: !state.is_playing,
          position: state.progress_ms,
          duration: state.item?.duration_ms || 0,
        } as unknown as Spotify.PlaybackState);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [connected, playing, fetchToken]);

  const connect = useCallback(() => {
    window.location.href = "/api/spotify/login";
  }, []);

  const disconnect = useCallback(async () => {
    playerRef.current?.disconnect();
    playerRef.current = null;
    setDeviceId(null);
    setConnected(false);
    setAccessToken(null);
    setPlayerState(null);
    setPlaying(false);
    clearTimeout(refreshTimerRef.current);
    await fetch("/api/spotify/logout", { method: "POST" });
  }, []);

  const playUri = useCallback(async (spotifyUri: string) => {
    // Convert URL to URI if needed
    let uri = spotifyUri;
    if (uri.includes("open.spotify.com")) {
      try {
        const url = new URL(uri);
        const parts = url.pathname.split("/").filter(Boolean);
        if (parts.length >= 2) {
          uri = `spotify:${parts[0]}:${parts[1]}`;
        }
      } catch {}
    }

    const token = await fetchToken();
    if (!token) return;

    if (isMobile) {
      let device = deviceId;
      if (!device) {
        device = await fetchActiveDevice(token);
        if (device) setDeviceId(device);
      }
      if (!device) throw new Error("No active Spotify device found. Open Spotify on your phone first.");

      await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${device}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ uris: [uri] }),
      });
      setPlaying(true);
    } else {
      if (!deviceId || !accessToken) return;
      await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ uris: [uri] }),
      });
    }
  }, [deviceId, accessToken, fetchToken]);

  const pause = useCallback(async () => {
    if (isMobile) {
      const token = await fetchToken();
      if (!token) return;
      await fetch("https://api.spotify.com/v1/me/player/pause", {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}` },
      });
      setPlaying(false);
    } else {
      await playerRef.current?.pause();
    }
  }, [fetchToken]);

  const resume = useCallback(async () => {
    if (isMobile) {
      const token = await fetchToken();
      if (!token) return;
      await fetch("https://api.spotify.com/v1/me/player/play", {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}` },
      });
      setPlaying(true);
    } else {
      await playerRef.current?.resume();
    }
  }, [fetchToken]);

  const seek = useCallback(async (positionMs: number) => {
    if (isMobile) {
      const token = await fetchToken();
      if (!token) return;
      await fetch(`https://api.spotify.com/v1/me/player/seek?position_ms=${positionMs}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}` },
      });
    } else {
      await playerRef.current?.seek(positionMs);
    }
  }, [fetchToken]);

  return (
    <SpotifyContext.Provider
      value={{
        connected,
        loading,
        deviceId,
        player: playerRef.current,
        accessToken,
        connect,
        disconnect,
        playUri,
        pause,
        resume,
        seek,
        playerState,
      }}
    >
      {children}
    </SpotifyContext.Provider>
  );
}
