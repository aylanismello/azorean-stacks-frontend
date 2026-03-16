"use client";

import { useState, useCallback, useRef } from "react";
import { Track } from "@/lib/types";
import { openYouTube } from "@/lib/youtube";
import { useGlobalPlayer } from "./GlobalPlayerProvider";
import { useSpotify } from "./SpotifyProvider";

interface TrackCardProps {
  track: Track;
  onVote: (id: string, status: "approved" | "rejected" | "skipped", advance?: boolean) => Promise<void>;
  onSuperLike?: (id: string) => Promise<void>;
  onSkipEpisode?: () => void;
  skippingEpisode?: boolean;
  onShowContext?: () => void;
}

// Generate a deterministic gradient from artist+title
function generateGradient(artist: string, title: string): string {
  let hash = 0;
  const str = artist + title;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h1 = Math.abs(hash % 360);
  const h2 = (h1 + 40 + Math.abs((hash >> 8) % 60)) % 360;
  return `linear-gradient(135deg, hsl(${h1}, 40%, 15%) 0%, hsl(${h2}, 50%, 8%) 100%)`;
}

function safeCoverUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") return url;
  } catch {}
  return null;
}

function sourceLabel(source: string): string {
  const labels: Record<string, string> = {
    nts: "NTS Radio",
    "1001tracklists": "1001TL",
    spotify: "Spotify",
    bandcamp: "Bandcamp",
    manual: "Manual",
  };
  return labels[source] || source;
}

export function TrackCard({ track, onVote, onSuperLike, onSkipEpisode, skippingEpisode, onShowContext }: TrackCardProps) {
  const [exiting, setExiting] = useState<"left" | "right" | null>(null);
  const [voting, setVoting] = useState(false);
  const votingRef = useRef(false);
  const [kept, setKept] = useState(false);
  const [superLiked, setSuperLiked] = useState(false);
  const [superLiking, setSuperLiking] = useState(false);
  const [copied, setCopied] = useState(false);
  const [seeded, setSeeded] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [swipeX, setSwipeX] = useState(0);
  const touchRef = useRef<{ startX: number; startY: number; swiping: boolean } | null>(null);
  const globalPlayer = useGlobalPlayer();
  const spotify = useSpotify();

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(`${track.artist} - ${track.title}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [track.artist, track.title]);

  const handlePlantSeed = useCallback(async () => {
    if (seeding) return;
    setSeeding(true);
    try {
      const res = await fetch("/api/seeds/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ track_id: track.id, artist: track.artist, title: track.title }),
      });
      if (!res.ok) return;
      const data = await res.json();
      setSeeded(data.action === "created");
    } catch {
      // silently fail
    } finally {
      setSeeding(false);
    }
  }, [track.id, track.artist, track.title, seeding]);

  const handleSuperLike = useCallback(async () => {
    if (superLiking || votingRef.current) return;
    setSuperLiking(true);
    setSuperLiked(true);
    try {
      if (onSuperLike) {
        await onSuperLike(track.id);
      }
    } catch {
      // silently fail — the pop animation already ran
    } finally {
      setSuperLiking(false);
    }
  }, [track.id, onSuperLike, superLiking]);

  const handleVote = useCallback(
    async (status: "approved" | "rejected" | "skipped", advance: boolean = true) => {
      if (votingRef.current) return;
      if (!advance) {
        setKept(true);
        await onVote(track.id, status, false);
        return;
      }
      votingRef.current = true;
      setVoting(true);
      setExiting(status === "approved" ? "right" : status === "skipped" ? "right" : "left");
      await new Promise((r) => setTimeout(r, 250));
      await onVote(track.id, status, true);
    },
    [track.id, onVote]
  );

  const handleAdvance = useCallback(async () => {
    if (votingRef.current) return;
    votingRef.current = true;
    setVoting(true);
    setExiting("right");
    await new Promise((r) => setTimeout(r, 250));
    await onVote(track.id, "approved", true);
  }, [track.id, onVote]);

  // Touch swipe handlers
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchRef.current = { startX: e.touches[0].clientX, startY: e.touches[0].clientY, swiping: false };
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!touchRef.current || votingRef.current) return;
    const dx = e.touches[0].clientX - touchRef.current.startX;
    const dy = e.touches[0].clientY - touchRef.current.startY;
    if (!touchRef.current.swiping && Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 10) {
      touchRef.current.swiping = true;
    }
    if (touchRef.current.swiping) {
      setSwipeX(dx);
    }
  }, []);

  const handleTouchEnd = useCallback(() => {
    if (!touchRef.current) return;
    const threshold = 80;
    if (touchRef.current.swiping && Math.abs(swipeX) > threshold) {
      handleVote(swipeX > 0 ? "approved" : "rejected", true);
    }
    setSwipeX(0);
    touchRef.current = null;
  }, [swipeX, handleVote]);

  const gradient = generateGradient(track.artist, track.title);
  const coverUrl = safeCoverUrl(track.cover_art_url) || safeCoverUrl(track.episode?.artwork_url ?? null);
  const meta = (track.metadata ?? {}) as Record<string, string | undefined>;
  const hasAudio = !!(track.audio_url || track.preview_url);
  const hasPlayableSource = hasAudio || (!!track.spotify_url && spotify.connected && !!spotify.deviceId);
  const isCurrentTrack = globalPlayer.currentTrack?.id === track.id;

  const handleArtworkPlay = useCallback(() => {
    if (isCurrentTrack) {
      globalPlayer.togglePlayPause();
      return;
    }
    globalPlayer.play({
      id: track.id,
      artist: track.artist,
      title: track.title,
      coverArtUrl: safeCoverUrl(track.cover_art_url) || safeCoverUrl(track.episode?.artwork_url ?? null),
      spotifyUrl: track.spotify_url,
      audioUrl: track.audio_url || track.preview_url || null,
      episodeId: track.episode_id,
      episodeTitle: track.episode?.title,
      youtubeUrl: track.youtube_url,
    });
  }, [track, isCurrentTrack, globalPlayer]);

  const exitClass = exiting === "left"
    ? "card-exit-left"
    : exiting === "right"
    ? "card-exit-right"
    : swipeX === 0
    ? "card-enter-active"
    : "";

  const swipeStyle = swipeX !== 0 ? {
    transform: `translateX(${swipeX}px) rotate(${swipeX * 0.05}deg)`,
    transition: "none",
    opacity: Math.max(0.5, 1 - Math.abs(swipeX) / 300),
  } : undefined;

  // Rewind 30s handler
  const handleRewind = useCallback(() => {
    if (!isCurrentTrack) return;
    globalPlayer.seek(Math.max(0, globalPlayer.progress - 30));
  }, [isCurrentTrack, globalPlayer]);

  // Forward 30s handler
  const handleForward = useCallback(() => {
    if (!isCurrentTrack) return;
    globalPlayer.seek(globalPlayer.progress + 30);
  }, [isCurrentTrack, globalPlayer]);

  // -- Shared sub-components --

  // Shared skip icons — clean circular arrow with integrated "30"
  const rewindIcon = (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5V1L7 5l5 4V5" />
      <path d="M19.07 6.93A10 10 0 1 1 5.93 6.93" />
      <text x="12" y="15.5" textAnchor="middle" fill="currentColor" stroke="none" fontSize="7" fontWeight="700" fontFamily="system-ui">30</text>
    </svg>
  );

  const forwardIcon = (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5V1l5 4-5 4V5" />
      <path d="M4.93 6.93A10 10 0 1 0 18.07 6.93" />
      <text x="12" y="15.5" textAnchor="middle" fill="currentColor" stroke="none" fontSize="7" fontWeight="700" fontFamily="system-ui">30</text>
    </svg>
  );

  // Desktop artwork block (rewind | play/pause | forward)
  // Controls hidden when playing, shown on hover over artwork
  // No controls at all when no playable source
  const controlsHidden = isCurrentTrack && globalPlayer.playing;
  const artworkBlockDesktop = (
    <div
      className="relative w-full h-full flex items-center justify-center group/artwork"
      style={
        coverUrl
          ? { backgroundImage: `url(${coverUrl})`, backgroundSize: "cover", backgroundPosition: "center" }
          : { background: gradient }
      }
    >
      <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-black/20" />

      {Math.abs(swipeX) > 30 && (
        <div className={`absolute top-6 z-30 px-4 py-2 rounded-xl text-sm font-bold border-2 ${
          swipeX > 0
            ? "right-6 bg-green-500/20 border-green-400 text-green-400 rotate-12"
            : "left-6 bg-red-500/20 border-red-400 text-red-400 -rotate-12"
        }`}>
          {swipeX > 0 ? "KEEP" : "SKIP"}
        </div>
      )}

      {hasPlayableSource && (
        <div className={`relative z-10 flex items-center gap-5 transition-opacity duration-200 ${
          controlsHidden
            ? "opacity-0 group-hover/artwork:opacity-100"
            : "opacity-100"
        } ${isCurrentTrack && globalPlayer.loading ? "!opacity-100" : ""}`}>
          {/* Rewind 30s */}
          <button
            onClick={handleRewind}
            className="w-10 h-10 flex items-center justify-center rounded-full bg-black/30 backdrop-blur-sm text-white/80 hover:text-white hover:bg-black/50 active:scale-90 transition-all"
            title="Rewind 30 seconds"
            aria-label="Rewind 30 seconds"
          >
            {rewindIcon}
          </button>

          {/* Play/pause */}
          <button
            onClick={handleArtworkPlay}
            title={isCurrentTrack && globalPlayer.playing ? "Pause track" : "Play track"}
            aria-label={isCurrentTrack && globalPlayer.playing ? "Pause track" : "Play track"}
          >
            <span className="flex items-center justify-center w-16 h-16 rounded-full backdrop-blur-md bg-black/40 transition-all active:scale-90">
              {isCurrentTrack && globalPlayer.loading ? (
                <svg className="animate-spin" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
                  <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
                </svg>
              ) : isCurrentTrack && globalPlayer.playing ? (
                <svg width="26" height="26" viewBox="0 0 24 24" fill="white">
                  <rect x="6" y="4" width="4" height="16" rx="1" />
                  <rect x="14" y="4" width="4" height="16" rx="1" />
                </svg>
              ) : (
                <svg width="28" height="28" viewBox="0 0 24 24" fill="white">
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
            </span>
          </button>

          {/* Forward 30s */}
          <button
            onClick={handleForward}
            className="w-10 h-10 flex items-center justify-center rounded-full bg-black/30 backdrop-blur-sm text-white/80 hover:text-white hover:bg-black/50 active:scale-90 transition-all"
            title="Skip ahead 30 seconds"
            aria-label="Skip ahead 30 seconds"
          >
            {forwardIcon}
          </button>
        </div>
      )}
    </div>
  );

  const noSourceIndicator = isCurrentTrack && globalPlayer.noSource && (
    <div className="flex items-center gap-1.5 text-[11px] text-white/40">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="opacity-60">
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
        <line x1="23" y1="9" x2="17" y2="15" />
        <line x1="17" y1="9" x2="23" y2="15" />
      </svg>
      No audio source
    </div>
  );

  // Equalizer bars shown next to active source
  const eqBars = (
    <span className="flex gap-0.5 items-end h-2.5">
      <span className={`w-0.5 bg-current rounded-full ${globalPlayer.playing ? "animate-bounce" : ""}`} style={{ height: "40%", animationDelay: "0ms" }} />
      <span className={`w-0.5 bg-current rounded-full ${globalPlayer.playing ? "animate-bounce" : ""}`} style={{ height: "70%", animationDelay: "150ms" }} />
      <span className={`w-0.5 bg-current rounded-full ${globalPlayer.playing ? "animate-bounce" : ""}`} style={{ height: "50%", animationDelay: "300ms" }} />
    </span>
  );

  const playingIndicator = isCurrentTrack && !globalPlayer.noSource && (
    globalPlayer.canSwitchSource ? (
      // Switchable tabs when both sources available
      <div className="flex items-center bg-surface-2 rounded-lg overflow-hidden text-[11px]">
        <button
          onClick={() => globalPlayer.switchSource("audio")}
          className={`flex items-center gap-1.5 px-2.5 py-1 transition-colors ${
            globalPlayer.source === "audio"
              ? "bg-accent/20 text-accent"
              : "text-foreground/40 hover:text-foreground/60"
          }`}
        >
          {globalPlayer.source === "audio" && eqBars}
          Audio
        </button>
        <button
          onClick={() => globalPlayer.switchSource("spotify")}
          className={`flex items-center gap-1.5 px-2.5 py-1 transition-colors ${
            globalPlayer.source === "spotify"
              ? "bg-[#1DB954]/20 text-[#1DB954]"
              : "text-foreground/40 hover:text-foreground/60"
          }`}
        >
          {globalPlayer.source === "spotify" && eqBars}
          Spotify
        </button>
      </div>
    ) : (
      // Single source label
      <div className="flex items-center gap-1.5 text-[11px]">
        <span className={globalPlayer.source === "spotify" ? "text-[#1DB954]" : "text-accent"}>
          {eqBars}
        </span>
        <span className={globalPlayer.source === "spotify" ? "text-[#1DB954]" : "text-accent"}>
          {globalPlayer.source === "spotify" ? "Spotify" : "Audio"}
        </span>
      </div>
    )
  );

  const seedArtist = track.seed_track?.artist || (track.metadata as any)?.seed_artist;
  const seedTitle = track.seed_track?.title || (track.metadata as any)?.seed_title;
  const discoveryContext = seedArtist && (
    <p className="text-xs text-foreground/50 leading-relaxed truncate">
      via{" "}
      <span className="text-foreground/70">{seedArtist}</span>
      {seedTitle && (
        <>
          {" — "}
          <span className="text-foreground/60">{seedTitle}</span>
        </>
      )}
      {(track.metadata as any)?.co_occurrence > 1 && ` · ${(track.metadata as any).co_occurrence} sets`}
    </p>
  );

  const sourceContext = track.source_context && (
    track.source_url ? (
      <a
        href={track.source_url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1.5 text-[11px] text-muted hover:text-accent transition-colors group truncate"
      >
        <span className="text-accent">◉</span>
        <span className="truncate underline underline-offset-2 decoration-foreground/10 group-hover:decoration-accent">
          {track.source_context}
        </span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 opacity-40 group-hover:opacity-100">
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
        </svg>
      </a>
    ) : (
      <div className="flex items-center gap-1.5 text-[11px] text-muted truncate">
        <span className="text-accent">◉</span>
        <span className="truncate">{track.source_context}</span>
      </div>
    )
  );

  const externalLinks = (
    <div className="flex items-center gap-2">
      {track.spotify_url && (
        <a
          href={track.spotify_url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-center w-8 h-8 rounded-full bg-surface-2 hover:bg-surface-3 transition-all active:scale-90"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="#1DB954">
            <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
          </svg>
        </a>
      )}
      {track.youtube_url && (
        <button
          onClick={() => openYouTube(track.youtube_url!)}
          className="flex items-center justify-center w-8 h-8 rounded-full bg-surface-2 hover:bg-surface-3 text-red-400/70 hover:text-red-400 transition-all active:scale-90"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>
        </button>
      )}
    </div>
  );

  const voteButtons = (
    <div className="flex items-center justify-center gap-6">
      {/* Reject (X) */}
      <button
        onClick={() => handleVote("rejected", true)}
        disabled={voting}
        className="flex items-center justify-center w-14 h-14 md:w-16 md:h-16 rounded-full bg-surface-2 md:bg-black/40 md:backdrop-blur-md border-2 border-red-400/30 text-red-400/80 hover:bg-red-950/50 hover:border-red-400/60 hover:text-red-400 transition-all active:scale-90 disabled:opacity-50"
        title="Reject track"
        aria-label="Reject track"
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>

      {/* Skip (neutral) */}
      <button
        onClick={() => handleVote("skipped", true)}
        disabled={voting}
        className="flex items-center justify-center w-11 h-11 md:w-12 md:h-12 rounded-full bg-surface-2 md:bg-black/40 md:backdrop-blur-md border-2 border-amber-400/30 text-amber-400/80 hover:bg-amber-950/50 hover:border-amber-400/60 hover:text-amber-400 transition-all active:scale-90 disabled:opacity-50"
        title="Skip — no opinion"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12h14" /><path d="M12 5l7 7-7 7" />
        </svg>
      </button>

      {/* Re-seed */}
      <button
        onClick={handlePlantSeed}
        disabled={seeding}
        className={`flex items-center justify-center w-10 h-10 rounded-full border transition-all active:scale-90 ${
          seeded
            ? "bg-emerald-500/30 border-emerald-400/50 text-emerald-400"
            : seeding
            ? "bg-surface-2 border-emerald-400/30 text-emerald-400/50 animate-pulse"
            : "bg-surface-2 md:bg-black/40 border-foreground/10 text-foreground/40 hover:border-emerald-400/40 hover:text-emerald-400/70"
        }`}
        title={seeded ? "Remove re-seed" : "Plant as re-seed for future discovery"}
      >
        <span className={`text-sm ${seeded ? "seed-sprout" : ""}`}>{seeded ? "🌿" : "🌱"}</span>
      </button>

      {/* Super Like — gold star; after super-liking becomes [->] advance button */}
      {superLiked ? (
        <button
          onClick={handleAdvance}
          disabled={voting}
          className="flex items-center justify-center w-14 h-14 md:w-16 md:h-16 rounded-full bg-yellow-400/20 border-2 border-yellow-400 text-yellow-300 transition-all active:scale-90 disabled:opacity-50 kept-pop super-like-glow"
          title="Advance to next track"
          aria-label="Advance to next track"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12h14" /><path d="M12 5l7 7-7 7" />
          </svg>
        </button>
      ) : (
        <button
          onClick={handleSuperLike}
          disabled={superLiking || voting}
          className="flex items-center justify-center w-14 h-14 md:w-16 md:h-16 rounded-full border-2 transition-all active:scale-90 disabled:opacity-50 bg-surface-2 md:bg-black/40 md:backdrop-blur-md border-yellow-400/30 text-yellow-400/80 hover:bg-yellow-950/50 hover:border-yellow-400/60 hover:text-yellow-400"
          title="Super Like — download this track locally"
          aria-label="Super Like track"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
          </svg>
        </button>
      )}

      {/* Keep (approve) */}
      {kept ? (
        <button
          onClick={handleAdvance}
          disabled={voting}
          className="flex items-center justify-center w-14 h-14 md:w-16 md:h-16 rounded-full bg-green-500/20 border-2 border-green-400 text-green-400 transition-all active:scale-90 disabled:opacity-50 kept-pop approve-glow"
          title="Advance to next track"
          aria-label="Advance to next track"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12h14" /><path d="M12 5l7 7-7 7" />
          </svg>
        </button>
      ) : (
        <button
          onClick={() => handleVote("approved", false)}
          disabled={voting}
          className="flex items-center justify-center w-14 h-14 md:w-16 md:h-16 rounded-full bg-surface-2 md:bg-black/40 md:backdrop-blur-md border-2 border-green-400/30 text-green-400/80 hover:bg-green-950/50 hover:border-green-400/60 hover:text-green-400 transition-all active:scale-90 disabled:opacity-50"
          title="Keep track"
          aria-label="Keep track"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
          </svg>
        </button>
      )}
    </div>
  );

  // ── MOBILE LAYOUT ──
  // Full-bleed artwork filling the viewport, all controls overlaid
  const mobileLayout = (
    <div className="md:hidden flex flex-col h-full min-h-0">
      {/* Artwork — fills all available space, all controls overlaid */}
      <div
        className={`relative flex-1 min-h-0 rounded-2xl overflow-hidden shadow-2xl shadow-black/40 ${exitClass}`}
        style={{
          ...(coverUrl
            ? { backgroundImage: `url(${coverUrl})`, backgroundSize: "cover", backgroundPosition: "center" }
            : { background: gradient }),
          ...swipeStyle,
        }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {/* Vignette overlays */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-black/30 z-[1]" />

        {/* Swipe direction indicator */}
        {Math.abs(swipeX) > 30 && (
          <div className={`absolute top-6 z-30 px-4 py-2 rounded-xl text-sm font-bold border-2 ${
            swipeX > 0
              ? "right-6 bg-green-500/20 border-green-400 text-green-400 rotate-12"
              : "left-6 bg-red-500/20 border-red-400 text-red-400 -rotate-12"
          }`}>
            {swipeX > 0 ? "KEEP" : "SKIP"}
          </div>
        )}

        {/* Center playback controls: rewind | play/pause | forward — only when audio available */}
        {hasPlayableSource && (
          <div className="absolute inset-0 z-10 flex items-center justify-center">
            <div className="flex items-center gap-6">
              {/* Rewind 30s */}
              <button
                onClick={handleRewind}
                className="w-10 h-10 flex items-center justify-center rounded-full bg-black/30 backdrop-blur-sm text-white/80 active:scale-90 transition-all"
                title="Rewind 30 seconds"
                aria-label="Rewind 30 seconds"
              >
                {rewindIcon}
              </button>

              {/* Play/pause */}
              <button
                onClick={handleArtworkPlay}
                className="group/play"
                title={isCurrentTrack && globalPlayer.playing ? "Pause track" : "Play track"}
                aria-label={isCurrentTrack && globalPlayer.playing ? "Pause track" : "Play track"}
              >
                <span
                  className={`flex items-center justify-center w-16 h-16 rounded-full backdrop-blur-md transition-all active:scale-90 bg-black/30 ${
                    isCurrentTrack && globalPlayer.loading ? "opacity-100" : ""
                  }`}
                >
                  {isCurrentTrack && globalPlayer.loading ? (
                    <svg className="animate-spin" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
                      <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
                    </svg>
                  ) : isCurrentTrack && globalPlayer.playing ? (
                    <svg width="26" height="26" viewBox="0 0 24 24" fill="white">
                      <rect x="6" y="4" width="4" height="16" rx="1" />
                      <rect x="14" y="4" width="4" height="16" rx="1" />
                    </svg>
                  ) : (
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="white">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  )}
                </span>
              </button>

              {/* Forward 30s */}
              <button
                onClick={handleForward}
                className="w-10 h-10 flex items-center justify-center rounded-full bg-black/30 backdrop-blur-sm text-white/80 active:scale-90 transition-all"
                title="Skip ahead 30 seconds"
                aria-label="Skip ahead 30 seconds"
              >
                {forwardIcon}
              </button>
            </div>
          </div>
        )}

        {/* Progress line — thin, no interaction, just visual */}
        {isCurrentTrack && globalPlayer.duration > 0 && (
          <div className="absolute bottom-0 left-0 right-0 z-20 h-[2px] bg-white/10">
            <div
              className="h-full bg-accent/80 transition-[width] duration-500 ease-linear"
              style={{ width: `${(globalPlayer.progress / globalPlayer.duration) * 100}%` }}
            />
          </div>
        )}

        {/* Bottom overlay: track info + source + links + vote buttons */}
        <div className="absolute bottom-0 left-0 right-0 z-10 px-4 pb-4">
          {/* Track info */}
          <div className="mb-2">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-bold text-white leading-tight truncate drop-shadow-lg flex-1">
                {track.title}
              </h2>
              {onShowContext && (
                <button
                  onClick={onShowContext}
                  className="flex-shrink-0 w-5 h-5 rounded-full border border-white/20 text-white/30 flex items-center justify-center text-[10px] font-bold active:scale-90 transition-all"
                  title="Why this track?"
                  aria-label="Track context"
                >
                  ?
                </button>
              )}
            </div>
            <p className="text-sm text-white/80 truncate drop-shadow-lg">{track.artist}</p>
          </div>

          {/* Source indicator + external links row */}
          <div className="flex items-center gap-2 mb-3">
            {/* Audio source switcher — tabs when both sources available */}
            {isCurrentTrack && !globalPlayer.noSource && globalPlayer.canSwitchSource ? (
              <div className="flex items-center bg-black/30 backdrop-blur-sm rounded-lg overflow-hidden text-[11px]">
                <button
                  onClick={() => globalPlayer.switchSource("audio")}
                  className={`flex items-center gap-1.5 px-2.5 py-1 transition-colors ${
                    globalPlayer.source === "audio"
                      ? "bg-white/15 text-accent"
                      : "text-white/40"
                  }`}
                >
                  {globalPlayer.source === "audio" && eqBars}
                  Audio
                </button>
                <button
                  onClick={() => globalPlayer.switchSource("spotify")}
                  className={`flex items-center gap-1.5 px-2.5 py-1 transition-colors ${
                    globalPlayer.source === "spotify"
                      ? "bg-white/15 text-[#1DB954]"
                      : "text-white/40"
                  }`}
                >
                  {globalPlayer.source === "spotify" && eqBars}
                  Spotify
                </button>
              </div>
            ) : isCurrentTrack && !globalPlayer.noSource ? (
              <div className="flex items-center gap-1.5 text-[11px]">
                <span className={globalPlayer.source === "spotify" ? "text-[#1DB954]" : "text-accent"}>
                  {eqBars}
                </span>
                <span className={globalPlayer.source === "spotify" ? "text-[#1DB954]" : "text-white/60"}>
                  {globalPlayer.source === "spotify" ? "Spotify" : "Audio"}
                </span>
              </div>
            ) : null}
            {/* No audio source */}
            {!hasPlayableSource && (
              <div className="flex items-center gap-1.5 text-[11px] text-white/40">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="opacity-60">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <line x1="23" y1="9" x2="17" y2="15" />
                  <line x1="17" y1="9" x2="23" y2="15" />
                </svg>
                No audio
              </div>
            )}
            <div className="flex-1" />
            {/* Spotify + YouTube external links */}
            {track.spotify_url && (
              <a
                href={track.spotify_url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center w-8 h-8 rounded-full bg-black/40 backdrop-blur-sm active:scale-90 transition-all"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="#1DB954">
                  <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
                </svg>
              </a>
            )}
            {track.youtube_url && (
              <button
                onClick={() => openYouTube(track.youtube_url!)}
                className="flex items-center justify-center w-8 h-8 rounded-full bg-black/40 backdrop-blur-sm text-red-400/80 active:scale-90 transition-all"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>
              </button>
            )}
          </div>

          {/* Vote buttons row: X reject | skip neutral | seed | heart approve */}
          <div className="flex items-center justify-center gap-5">
            {/* Reject (X) */}
            <button
              onClick={() => handleVote("rejected", true)}
              disabled={voting}
              className="flex items-center justify-center w-13 h-13 rounded-full bg-black/40 backdrop-blur-md border-2 border-red-400/40 text-red-400/90 active:scale-90 transition-all disabled:opacity-50"
              title="Reject track"
              aria-label="Reject track"
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>

            {/* Skip (neutral — yellow) */}
            <button
              onClick={() => handleVote("skipped", true)}
              disabled={voting}
              className="flex items-center justify-center w-11 h-11 rounded-full bg-black/40 backdrop-blur-md border-2 border-amber-400/40 text-amber-400/90 active:scale-90 transition-all disabled:opacity-50"
              title="Skip — no opinion"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14" /><path d="M12 5l7 7-7 7" />
              </svg>
            </button>

            {/* Re-seed */}
            <button
              onClick={handlePlantSeed}
              disabled={seeding}
              className={`flex items-center justify-center w-9 h-9 rounded-full border backdrop-blur-md transition-all active:scale-90 ${
                seeded
                  ? "bg-emerald-500/30 border-emerald-400/50 text-emerald-400"
                  : seeding
                  ? "bg-black/40 border-emerald-400/30 text-emerald-400/50 animate-pulse"
                  : "bg-black/40 border-white/20 text-white/50"
              }`}
              title={seeded ? "Remove re-seed" : "Plant as re-seed"}
            >
              <span className={`text-xs ${seeded ? "seed-sprout" : ""}`}>{seeded ? "🌿" : "🌱"}</span>
            </button>

            {/* Super Like — gold star; after super-liking becomes [->] advance button */}
            {superLiked ? (
              <button
                onClick={handleAdvance}
                disabled={voting}
                className="flex items-center justify-center w-13 h-13 rounded-full bg-yellow-400/20 backdrop-blur-md border-2 border-yellow-400 text-yellow-300 transition-all active:scale-90 disabled:opacity-50 kept-pop super-like-glow"
                title="Advance to next track"
                aria-label="Advance to next track"
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14" /><path d="M12 5l7 7-7 7" />
                </svg>
              </button>
            ) : (
              <button
                onClick={handleSuperLike}
                disabled={superLiking || voting}
                className="flex items-center justify-center w-13 h-13 rounded-full border-2 backdrop-blur-md transition-all active:scale-90 disabled:opacity-50 bg-black/40 border-yellow-400/40 text-yellow-400/90"
                title="Super Like — download this track locally"
                aria-label="Super Like track"
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                </svg>
              </button>
            )}

            {/* Keep (approve) */}
            {kept ? (
              <button
                onClick={handleAdvance}
                disabled={voting}
                className="flex items-center justify-center w-13 h-13 rounded-full bg-green-500/20 backdrop-blur-md border-2 border-green-400 text-green-400 transition-all active:scale-90 disabled:opacity-50 kept-pop approve-glow"
                title="Advance to next track"
                aria-label="Advance to next track"
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </button>
            ) : (
              <button
                onClick={() => handleVote("approved", false)}
                disabled={voting}
                className="flex items-center justify-center w-13 h-13 rounded-full bg-black/40 backdrop-blur-md border-2 border-green-400/40 text-green-400/90 active:scale-90 transition-all disabled:opacity-50"
                title="Keep track"
                aria-label="Keep track"
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  // ── DESKTOP LAYOUT ──
  // Side-by-side: artwork left, info + actions right
  const desktopLayout = (
    <div className="hidden md:flex items-center gap-8 max-h-[70vh]">
      {/* Artwork — square, max height constrained */}
      <div
        className={`flex-shrink-0 ${exitClass}`}
        style={swipeStyle}
      >
        <div className="rounded-2xl overflow-hidden shadow-2xl shadow-black/40 w-[min(400px,35vw)] aspect-square">
          {artworkBlockDesktop}
        </div>
      </div>

      {/* Info panel — right side */}
      <div className="flex-1 min-w-0 flex flex-col justify-center py-4 max-w-md">
        {/* Discovery + source context */}
        <div className="space-y-1.5 mb-6">
          {discoveryContext}
          {sourceContext}
        </div>

        {/* Track title + artist */}
        <div className="mb-6">
          <div className="flex items-start gap-2">
            <h2 className="text-3xl font-bold text-foreground leading-tight truncate flex-1">
              {track.title}
            </h2>
            {onShowContext && (
              <button
                onClick={onShowContext}
                className="flex-shrink-0 mt-1.5 w-5 h-5 rounded-full border border-foreground/20 text-foreground/30 hover:text-foreground/60 hover:border-foreground/40 transition-colors flex items-center justify-center text-[10px] font-bold"
                title="Why this track?"
                aria-label="Track context"
              >
                ?
              </button>
            )}
          </div>
          <div className="flex items-center gap-2 mt-1">
            <p className="text-xl text-foreground/70 truncate">{track.artist}</p>
            <button
              onClick={handleCopy}
              className="flex-shrink-0 p-1.5 rounded-md hover:bg-foreground/10 active:scale-90 transition-all"
              title="Copy artist - title"
            >
              {copied ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.4)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
            </button>
          </div>
        </div>

        {/* Tags row */}
        <div className="flex items-center gap-2 mb-8">
          <span className="px-2.5 py-1 bg-surface-2 rounded-lg text-xs text-muted">
            {sourceLabel(track.source)}
          </span>
          {typeof track.taste_score === "number" && track.taste_score !== 0 && (
            <span
              className={`px-2 py-1 rounded-lg text-xs font-mono font-semibold ${
                track.taste_score > 0
                  ? "bg-green-500/15 text-green-400"
                  : "bg-red-500/15 text-red-400"
              }`}
              title="Taste score"
            >
              {track.taste_score > 0 ? "+" : ""}{track.taste_score.toFixed(2)}
            </span>
          )}
          {meta.genre && (
            <span className="px-2.5 py-1 bg-surface-2 rounded-lg text-xs text-muted">
              {meta.genre}
            </span>
          )}
          {meta.bpm && (
            <span className="px-2.5 py-1 bg-surface-2 rounded-lg text-xs text-muted">
              {meta.bpm} BPM
            </span>
          )}
          {playingIndicator}
          {noSourceIndicator}
        </div>

        {/* Vote buttons */}
        <div className="mb-8">
          {voteButtons}
        </div>

        {/* Secondary actions */}
        <div className="flex items-center gap-3 pt-4 border-t border-surface-2">
          {onSkipEpisode && (
            <button
              onClick={onSkipEpisode}
              disabled={skippingEpisode}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-2 text-xs text-muted hover:text-white hover:bg-surface-3 transition-all active:scale-95 disabled:opacity-50"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" className="opacity-70">
                <path d="M4 5v14l11-7z" />
                <rect x="18" y="5" width="2" height="14" rx="0.5" />
              </svg>
              {skippingEpisode ? "Skipping..." : "Skip episode"}
            </button>
          )}
          {externalLinks}
        </div>
      </div>
    </div>
  );

  return (
    <>
      {mobileLayout}
      {desktopLayout}
    </>
  );
}
