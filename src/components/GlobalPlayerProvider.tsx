"use client";

import { createContext, useContext, useCallback, useRef, useState, useEffect } from "react";
import { useSpotify } from "./SpotifyProvider";

export interface PlayerTrack {
  id: string;
  artist: string;
  title: string;
  coverArtUrl: string | null;
  spotifyUrl: string | null;
  audioUrl: string | null;
  episodeId?: string | null;
  episodeTitle?: string | null;
  youtubeUrl?: string | null;
}

type PlaybackSource = "spotify" | "audio" | null;

interface GlobalPlayerContextType {
  currentTrack: PlayerTrack | null;
  playing: boolean;
  loading: boolean;
  progress: number; // seconds
  duration: number; // seconds
  source: PlaybackSource;
  /** True when the current track has no playable audio source */
  noSource: boolean;
  /** Increments each time the current track finishes playing */
  trackEndedCount: number;
  /** Whether both audio and spotify sources are available for the current track */
  canSwitchSource: boolean;
  /** Load a track into the player without starting playback */
  loadTrack: (track: PlayerTrack) => void;
  /** Load a track and immediately start playing */
  play: (track: PlayerTrack) => void;
  togglePlayPause: () => void;
  seek: (seconds: number) => void;
  stop: () => void;
  /** Switch playback source (audio <-> spotify) while keeping playback going */
  switchSource: (to: "audio" | "spotify") => void;
}

const GlobalPlayerContext = createContext<GlobalPlayerContextType>({
  currentTrack: null,
  playing: false,
  loading: false,
  progress: 0,
  duration: 0,
  source: null,
  noSource: false,
  trackEndedCount: 0,
  canSwitchSource: false,
  loadTrack: () => {},
  play: () => {},
  togglePlayPause: () => {},
  seek: () => {},
  stop: () => {},
  switchSource: () => {},
});

export function useGlobalPlayer() {
  return useContext(GlobalPlayerContext);
}

export function GlobalPlayerProvider({ children }: { children: React.ReactNode }) {
  const spotify = useSpotify();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [currentTrack, setCurrentTrack] = useState<PlayerTrack | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [source, setSource] = useState<PlaybackSource>(null);
  const [trackEndedCount, setTrackEndedCount] = useState(0);
  const [noSource, setNoSource] = useState(false);

  // Create a persistent audio element
  useEffect(() => {
    const audio = new Audio();
    audio.preload = "metadata";
    audioRef.current = audio;

    const onPlay = () => { setPlaying(true); setLoading(false); };
    const onPause = () => setPlaying(false);
    const onEnded = () => { setPlaying(false); setProgress(0); setTrackEndedCount((c) => c + 1); };
    const onWaiting = () => setLoading(true);
    const onPlaying = () => setLoading(false);
    const onCanPlay = () => setLoading(false);
    const onTimeUpdate = () => setProgress(audio.currentTime);
    const onLoadedMetadata = () => setDuration(audio.duration);

    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("waiting", onWaiting);
    audio.addEventListener("playing", onPlaying);
    audio.addEventListener("canplay", onCanPlay);
    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("loadedmetadata", onLoadedMetadata);

    return () => {
      audio.pause();
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("waiting", onWaiting);
      audio.removeEventListener("playing", onPlaying);
      audio.removeEventListener("canplay", onCanPlay);
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
    };
  }, []);

  // Sync Spotify playback state + detect track end
  const prevSpotifyPositionRef = useRef(0);
  useEffect(() => {
    if (source !== "spotify" || !spotify.playerState) return;

    const pos = (spotify.playerState.position || 0) / 1000;
    const dur = (spotify.playerState.duration || 0) / 1000;
    setPlaying(!spotify.playerState.paused);
    setLoading(false);
    setProgress(pos);
    setDuration(dur);

    // Detect track ended: position resets to 0 and paused, after we were playing
    if (spotify.playerState.paused && pos === 0 && prevSpotifyPositionRef.current > 0 && dur > 0) {
      setTrackEndedCount((c) => c + 1);
    }
    prevSpotifyPositionRef.current = pos;
  }, [spotify.playerState, source]);

  // Poll Spotify progress while playing
  useEffect(() => {
    if (source !== "spotify" || !playing) return;

    const interval = setInterval(() => {
      setProgress((prev) => prev + 0.5);
    }, 500);

    return () => clearInterval(interval);
  }, [source, playing]);

  const stopAudio = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
      audio.src = "";
    }
  }, []);

  const stopSpotify = useCallback(async () => {
    try {
      await spotify.pause();
    } catch {}
  }, [spotify]);

  const loadTrack = useCallback((track: PlayerTrack) => {
    // Stop whatever is currently playing
    stopAudio();
    stopSpotify();

    setCurrentTrack(track);
    setProgress(0);
    setDuration(0);
    setPlaying(false);
    setLoading(false);

    // Determine source but don't start playback — prefer downloaded audio over Spotify
    if (track.audioUrl) {
      setSource("audio");
      setNoSource(false);
      // Preload metadata so we have duration
      const audio = audioRef.current;
      if (audio) {
        audio.src = track.audioUrl;
      }
    } else if (spotify.connected && spotify.deviceId && track.spotifyUrl) {
      setSource("spotify");
      setNoSource(false);
    } else {
      setSource(null);
      setNoSource(true);
    }
  }, [spotify, stopAudio, stopSpotify]);

  const play = useCallback((track: PlayerTrack) => {
    // Stop whatever is currently playing
    stopAudio();
    stopSpotify();

    setCurrentTrack(track);
    setProgress(0);
    setDuration(0);
    setNoSource(false);
    setLoading(true);

    // Decide source: prefer downloaded audio over Spotify
    if (track.audioUrl) {
      setSource("audio");
      const audio = audioRef.current;
      if (audio) {
        audio.src = track.audioUrl;
        audio.play().catch(() => setLoading(false));
      }
    } else if (spotify.connected && spotify.deviceId && track.spotifyUrl) {
      setSource("spotify");
      spotify.playUri(track.spotifyUrl).catch(() => {
        setLoading(false);
        setNoSource(true);
      });
    } else {
      setLoading(false);
      setNoSource(true);
    }
  }, [spotify, stopAudio, stopSpotify]);

  const togglePlayPause = useCallback(() => {
    if (!currentTrack) return;

    if (source === "audio") {
      const audio = audioRef.current;
      if (!audio) return;
      if (audio.paused) {
        // If we have a src loaded but never played, start it
        if (audio.src) {
          audio.play().catch(() => {});
        } else if (currentTrack.audioUrl) {
          audio.src = currentTrack.audioUrl;
          audio.play().catch(() => {});
        }
      } else {
        audio.pause();
      }
    } else if (source === "spotify") {
      if (playing) {
        spotify.pause();
      } else {
        // If never started, play the URI
        if (!playing && currentTrack.spotifyUrl) {
          setLoading(true);
          spotify.playUri(currentTrack.spotifyUrl).catch(() => setLoading(false));
        } else {
          spotify.resume();
        }
      }
    } else if (currentTrack) {
      // Source not set yet — treat like first play
      play(currentTrack);
    }
  }, [source, playing, spotify, currentTrack, play]);

  const seek = useCallback((seconds: number) => {
    if (source === "audio") {
      const audio = audioRef.current;
      if (!audio) return;
      audio.currentTime = Math.max(0, Math.min(audio.duration || 0, seconds));
      setProgress(audio.currentTime);
    } else if (source === "spotify") {
      spotify.seek(seconds * 1000);
      setProgress(seconds);
    }
  }, [source, spotify]);

  // Whether both sources are available for the current track
  const canSwitchSource = !!(
    currentTrack?.audioUrl &&
    currentTrack?.spotifyUrl &&
    spotify.connected &&
    spotify.deviceId
  );

  const switchSource = useCallback((to: "audio" | "spotify") => {
    if (!currentTrack || source === to) return;
    const wasPlaying = playing;

    if (to === "audio" && currentTrack.audioUrl) {
      stopSpotify();
      setSource("audio");
      setProgress(0);
      setDuration(0);
      const audio = audioRef.current;
      if (audio) {
        audio.src = currentTrack.audioUrl;
        if (wasPlaying) {
          setLoading(true);
          audio.play().catch(() => setLoading(false));
        }
      }
    } else if (to === "spotify" && currentTrack.spotifyUrl && spotify.connected && spotify.deviceId) {
      stopAudio();
      setSource("spotify");
      setProgress(0);
      setDuration(0);
      if (wasPlaying) {
        setLoading(true);
        spotify.playUri(currentTrack.spotifyUrl).catch(() => setLoading(false));
      }
    }
  }, [currentTrack, source, playing, spotify, stopAudio, stopSpotify]);

  const stop = useCallback(() => {
    stopAudio();
    stopSpotify();
    setCurrentTrack(null);
    setPlaying(false);
    setLoading(false);
    setProgress(0);
    setDuration(0);
    setSource(null);
    setNoSource(false);
  }, [stopAudio, stopSpotify]);

  return (
    <GlobalPlayerContext.Provider
      value={{
        currentTrack,
        playing,
        loading,
        progress,
        duration,
        source,
        noSource,
        trackEndedCount,
        canSwitchSource,
        loadTrack,
        play,
        togglePlayPause,
        seek,
        stop,
        switchSource,
      }}
    >
      {children}
    </GlobalPlayerContext.Provider>
  );
}
