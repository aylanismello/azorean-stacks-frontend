"use client";

import { useState, useEffect, useCallback, useRef, Suspense } from "react";
import { Track } from "@/lib/types";
import { useGlobalPlayer, PlayerTrack } from "@/components/GlobalPlayerProvider";
import { useSpotify } from "@/components/SpotifyProvider";

function toPlayerTrack(track: Track): PlayerTrack {
  return {
    id: track.id,
    artist: track.artist,
    title: track.title,
    coverArtUrl: track.cover_art_url || track.episode?.artwork_url || null,
    spotifyUrl: track.spotify_url,
    audioUrl: track.audio_url || track.preview_url || null,
    episodeId: track.episode_id,
    episodeTitle: track.episode?.title,
    youtubeUrl: track.youtube_url,
    vote_status: (track as any).vote_status || track.status || "pending",
    super_liked: track.super_liked || false,
    status: track.status,
    is_seed: track.is_seed,
    is_re_seed: track.is_re_seed,
    is_artist_seed: (track as any).is_artist_seed,
    source: track.source,
    episode_id: track.episode_id,
    episode_title: track.episode?.title || null,
    storage_path: track.storage_path,
    youtube_url: track.youtube_url,
    preview_url: track.preview_url,
    seed_id: track.seed_id,
    seed_track: track.seed_track,
    taste_score: track.taste_score,
    source_url: track.source_url,
    source_context: track.source_context,
    episode: track.episode,
    metadata: track.metadata,
    _ranked_score: (track as any)._ranked_score,
    _score_components: (track as any)._score_components,
    _match_type: (track as any)._match_type,
    _seed_name: (track as any)._seed_name,
    voted_at: track.voted_at,
  };
}

function isPlayable(t: PlayerTrack): boolean {
  return !!(t.audioUrl || t.storage_path || t.preview_url);
}

/** Deterministic gradient from artist+title */
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

type SwipeDirection = "left" | "right" | "up" | null;

interface SwipeCardProps {
  track: Track;
  onSwipe: (direction: "left" | "right" | "up") => void;
  isTop: boolean;
}

function SwipeCard({ track, onSwipe, isTop }: SwipeCardProps) {
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const startPos = useRef({ x: 0, y: 0 });
  const dragging = useRef(false);
  const animating = useRef(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const globalPlayer = useGlobalPlayer();

  const coverUrl = safeCoverUrl(track.cover_art_url) || safeCoverUrl(track.episode?.artwork_url ?? null);
  const gradient = generateGradient(track.artist, track.title);
  const isCurrentTrack = globalPlayer.currentTrack?.id === track.id;

  const handleStart = useCallback((clientX: number, clientY: number) => {
    if (animating.current || !isTop) return;
    startPos.current = { x: clientX, y: clientY };
    dragging.current = true;
    setIsDragging(true);
  }, [isTop]);

  const handleMove = useCallback((clientX: number, clientY: number) => {
    if (!dragging.current || animating.current) return;
    const dx = clientX - startPos.current.x;
    const dy = clientY - startPos.current.y;
    setOffset({ x: dx, y: dy });
  }, []);

  const handleEnd = useCallback(() => {
    if (!dragging.current || animating.current) return;
    dragging.current = false;
    setIsDragging(false);

    const SWIPE_THRESHOLD = 80;
    const UP_THRESHOLD = 100;

    if (offset.y < -UP_THRESHOLD && Math.abs(offset.y) > Math.abs(offset.x)) {
      // Swipe up = SUPER LIKE
      animating.current = true;
      setOffset({ x: 0, y: -800 });
      setTimeout(() => onSwipe("up"), 300);
    } else if (offset.x > SWIPE_THRESHOLD) {
      // Swipe right = KEEP
      animating.current = true;
      setOffset({ x: 600, y: offset.y });
      setTimeout(() => onSwipe("right"), 300);
    } else if (offset.x < -SWIPE_THRESHOLD) {
      // Swipe left = SKIP
      animating.current = true;
      setOffset({ x: -600, y: offset.y });
      setTimeout(() => onSwipe("left"), 300);
    } else {
      // Snap back
      setOffset({ x: 0, y: 0 });
    }
  }, [offset, onSwipe]);

  // Touch handlers
  const onTouchStart = useCallback((e: React.TouchEvent) => {
    handleStart(e.touches[0].clientX, e.touches[0].clientY);
  }, [handleStart]);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    handleMove(e.touches[0].clientX, e.touches[0].clientY);
  }, [handleMove]);

  const onTouchEnd = useCallback(() => {
    handleEnd();
  }, [handleEnd]);

  // Mouse handlers (for desktop)
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    handleStart(e.clientX, e.clientY);
  }, [handleStart]);

  useEffect(() => {
    if (!isDragging) return;
    const onMove = (e: MouseEvent) => handleMove(e.clientX, e.clientY);
    const onUp = () => handleEnd();
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [isDragging, handleMove, handleEnd]);

  const handleArtworkTap = useCallback(() => {
    if (Math.abs(offset.x) > 5 || Math.abs(offset.y) > 5) return;
    if (isCurrentTrack) {
      globalPlayer.togglePlayPause();
    } else {
      const origin = "/swipe";
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
      }, origin);
    }
  }, [track, isCurrentTrack, globalPlayer, offset]);

  const rotation = offset.x * 0.08;
  const opacity = isDragging
    ? Math.max(0.6, 1 - Math.abs(offset.x) / 400)
    : 1;

  // Direction indicator
  let indicator: { text: string; color: string; bg: string } | null = null;
  if (Math.abs(offset.x) > 30 || offset.y < -50) {
    if (offset.y < -50 && Math.abs(offset.y) > Math.abs(offset.x)) {
      indicator = { text: "⭐ SUPER", color: "text-yellow-300", bg: "border-yellow-400 bg-yellow-400/20" };
    } else if (offset.x > 30) {
      indicator = { text: "KEEP ✅", color: "text-green-300", bg: "border-green-400 bg-green-400/20" };
    } else if (offset.x < -30) {
      indicator = { text: "SKIP ❌", color: "text-red-300", bg: "border-red-400 bg-red-400/20" };
    }
  }

  const cardStyle: React.CSSProperties = {
    transform: `translateX(${offset.x}px) translateY(${offset.y}px) rotate(${rotation}deg)`,
    transition: isDragging ? "none" : "transform 0.3s ease-out, opacity 0.3s ease-out",
    opacity,
    touchAction: "none",
  };

  return (
    <div
      ref={cardRef}
      className="absolute inset-0 rounded-3xl overflow-hidden shadow-2xl cursor-grab active:cursor-grabbing select-none"
      style={cardStyle}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onMouseDown={onMouseDown}
      onClick={handleArtworkTap}
    >
      {/* Background: cover art or gradient */}
      <div
        className="absolute inset-0"
        style={
          coverUrl
            ? { backgroundImage: `url(${coverUrl})`, backgroundSize: "cover", backgroundPosition: "center" }
            : { background: gradient }
        }
      />

      {/* Overlay gradient for text readability */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-black/30" />

      {/* Direction indicator overlay */}
      {indicator && (
        <div className="absolute inset-0 flex items-center justify-center z-20 pointer-events-none">
          <div className={`px-8 py-4 rounded-2xl border-4 ${indicator.bg} backdrop-blur-sm transform -rotate-12`}>
            <span className={`text-4xl font-black tracking-wider ${indicator.color}`}>
              {indicator.text}
            </span>
          </div>
        </div>
      )}

      {/* Play/pause indicator */}
      {isCurrentTrack && (
        <div className="absolute top-4 right-4 z-10">
          <div className={`w-10 h-10 rounded-full flex items-center justify-center backdrop-blur-md ${
            globalPlayer.playing ? "bg-white/20" : "bg-white/30"
          }`}>
            {globalPlayer.playing ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="white">
                <rect x="6" y="4" width="4" height="16" rx="1" />
                <rect x="14" y="4" width="4" height="16" rx="1" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="white">
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </div>
        </div>
      )}

      {/* Seed/episode context badge */}
      {track.seed_track && (
        <div className="absolute top-4 left-4 z-10">
          <div className="px-3 py-1.5 rounded-full bg-black/40 backdrop-blur-md text-[11px] text-white/70 max-w-[200px] truncate">
            via {track.seed_track.artist}
          </div>
        </div>
      )}

      {/* Track info — bottom of card */}
      <div className="absolute bottom-0 left-0 right-0 p-6 z-10">
        <h2 className="text-2xl font-bold text-white leading-tight mb-1 line-clamp-2">
          {track.title}
        </h2>
        <p className="text-lg text-white/70 mb-1 line-clamp-1">
          {track.artist}
        </p>
        {track.episode?.title && (
          <p className="text-xs text-white/40 truncate">
            {track.episode.title}
          </p>
        )}
        {!isCurrentTrack && (
          <p className="text-xs text-white/30 mt-2">
            Tap to play
          </p>
        )}
      </div>
    </div>
  );
}

function SwipePageContent() {
  const globalPlayer = useGlobalPlayer();
  const { connected: spotifyConnected } = useSpotify();
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [empty, setEmpty] = useState(false);
  const fetchingRef = useRef(false);
  const votingRef = useRef(false);

  const fetchTracks = useCallback(async (append = false) => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    try {
      const res = await fetch("/api/fyp?limit=20");
      if (!res.ok) throw new Error(`Failed to load tracks (${res.status})`);
      const data = await res.json();
      const apiTracks: Track[] = data.tracks || [];

      if (apiTracks.length === 0 && !append) {
        setEmpty(true);
        setTracks([]);
        return;
      }

      setEmpty(false);
      setError(null);

      if (append) {
        setTracks((prev) => {
          const existingIds = new Set(prev.map((t) => t.id));
          const newTracks = apiTracks.filter((t) => !existingIds.has(t.id));
          return [...prev, ...newTracks];
        });
      } else {
        setTracks(apiTracks);
        // Set up global player queue
        const playerTracks = apiTracks.map(toPlayerTrack);
        const firstPlayable = playerTracks.findIndex(isPlayable);
        if (firstPlayable >= 0) {
          globalPlayer.setQueue(playerTracks, firstPlayable);
          globalPlayer.play(playerTracks[firstPlayable], "/swipe");
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load tracks");
    } finally {
      setLoading(false);
      fetchingRef.current = false;
    }
  }, []);

  useEffect(() => {
    fetchTracks();
  }, [fetchTracks]);

  // Auto-refill when running low
  useEffect(() => {
    if (tracks.length > 0 && tracks.length < 3 && !fetchingRef.current) {
      fetchTracks(true);
    }
  }, [tracks.length, fetchTracks]);

  const handleSwipe = useCallback(async (direction: SwipeDirection) => {
    if (!direction || tracks.length === 0 || votingRef.current) return;
    votingRef.current = true;

    const currentTrack = tracks[0];
    let status: string;
    let superLiked = false;

    if (direction === "right") {
      status = "approved";
    } else if (direction === "left") {
      status = "rejected";
    } else {
      // up = super like
      status = "approved";
      superLiked = true;
    }

    try {
      const body = superLiked
        ? { super_liked: true }
        : { status };

      const res = await fetch(`/api/tracks/${currentTrack.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) throw new Error(`Vote failed (${res.status})`);

      if (status === "approved" && spotifyConnected) {
        fetch("/api/spotify/sync-seeds", { method: "POST" }).catch(() => {});
      }

      // Update vote in global player
      globalPlayer.updateTrackVote(currentTrack.id, status, superLiked);
    } catch (err) {
      console.error("Vote error:", err);
      // Don't remove the card if the vote failed — let the user retry
      votingRef.current = false;
      return;
    }

    // Remove current card, advance to next (only on successful vote)
    setTracks((prev) => {
      const next = prev.slice(1);
      if (next.length === 0) {
        setEmpty(true);
        return [];
      }

      // Play next track
      const nextTrack = next[0];
      const playerTrack = toPlayerTrack(nextTrack);
      if (isPlayable(playerTrack)) {
        globalPlayer.play(playerTrack, "/swipe");
      }

      return next;
    });

    votingRef.current = false;
  }, [tracks, globalPlayer, spotifyConnected]);

  const handleButtonVote = useCallback((direction: "left" | "right" | "up") => {
    handleSwipe(direction);
  }, [handleSwipe]);

  const handleRefresh = useCallback(() => {
    setLoading(true);
    setEmpty(false);
    setError(null);
    setTracks([]);
    fetchTracks(false);
  }, [fetchTracks]);

  // Height accounting for nav + global player
  const hasPlayer = !!globalPlayer.currentTrack;
  const heightClass = hasPlayer
    ? "h-[calc(100dvh-8rem-env(safe-area-inset-bottom,0px))]"
    : "h-[calc(100dvh-7rem-env(safe-area-inset-bottom,0px))]";

  if (loading) {
    return (
      <div className={`flex items-center justify-center ${heightClass}`}>
        <div className="w-10 h-10 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className={`flex flex-col items-center justify-center gap-4 ${heightClass}`}>
        <p className="text-red-400 text-sm">{error}</p>
        <button
          onClick={handleRefresh}
          className="px-4 py-2 bg-accent text-white rounded-lg text-sm"
        >
          Try Again
        </button>
      </div>
    );
  }

  if (empty || tracks.length === 0) {
    return (
      <div className={`flex flex-col items-center justify-center gap-4 ${heightClass}`}>
        <span className="text-5xl">✨</span>
        <p className="text-lg text-muted">You&apos;re all caught up</p>
        <p className="text-sm text-muted/60">No more tracks to swipe right now</p>
        <button
          onClick={handleRefresh}
          className="mt-2 px-6 py-3 bg-accent text-white rounded-xl text-sm font-medium hover:bg-accent/90 transition-colors"
        >
          Refresh
        </button>
      </div>
    );
  }

  return (
    <div className={`flex flex-col ${heightClass} overflow-hidden`}>
      {/* Card stack area */}
      <div className="flex-1 relative mx-4 mt-2 mb-2 md:mx-auto md:max-w-md md:w-full">
        {/* Stack of cards — show top 2 for depth effect */}
        {tracks.slice(0, 3).reverse().map((track, reverseIdx) => {
          const stackIdx = Math.min(2, tracks.length - 1) - reverseIdx;
          const isTop = stackIdx === 0;
          return (
            <div
              key={track.id}
              className="absolute inset-0"
              style={{
                zIndex: 3 - stackIdx,
                transform: isTop ? undefined : `scale(${1 - stackIdx * 0.04}) translateY(${stackIdx * 8}px)`,
                opacity: isTop ? 1 : 0.6,
                pointerEvents: isTop ? "auto" : "none",
              }}
            >
              <SwipeCard
                track={track}
                onSwipe={handleSwipe}
                isTop={isTop}
              />
            </div>
          );
        })}

        {/* Remaining count badge */}
        <div className="absolute top-3 right-3 z-30 pointer-events-none">
          <div className="px-2.5 py-1 rounded-full bg-black/40 backdrop-blur-md text-xs text-white/60 font-medium">
            {tracks.length} left
          </div>
        </div>
      </div>

      {/* Action buttons — thumb-reachable at bottom */}
      <div className="flex items-center justify-center gap-6 py-4 px-6 safe-area-bottom">
        {/* SKIP */}
        <button
          onClick={() => handleButtonVote("left")}
          className="w-16 h-16 rounded-full bg-surface-2 border-2 border-red-400/30 flex items-center justify-center text-red-400 hover:bg-red-400/10 hover:border-red-400/60 active:scale-90 transition-all shadow-lg"
          title="Skip"
        >
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>

        {/* SUPER LIKE */}
        <button
          onClick={() => handleButtonVote("up")}
          className="w-14 h-14 rounded-full bg-surface-2 border-2 border-yellow-400/30 flex items-center justify-center text-yellow-400 hover:bg-yellow-400/10 hover:border-yellow-400/60 active:scale-90 transition-all shadow-lg"
          title="Super Like"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
          </svg>
        </button>

        {/* KEEP */}
        <button
          onClick={() => handleButtonVote("right")}
          className="w-16 h-16 rounded-full bg-surface-2 border-2 border-green-400/30 flex items-center justify-center text-green-400 hover:bg-green-400/10 hover:border-green-400/60 active:scale-90 transition-all shadow-lg"
          title="Keep"
        >
          <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
          </svg>
        </button>
      </div>
    </div>
  );
}

export default function SwipePage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center min-h-[80vh]">
          <div className="w-10 h-10 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
        </div>
      }
    >
      <SwipePageContent />
    </Suspense>
  );
}
