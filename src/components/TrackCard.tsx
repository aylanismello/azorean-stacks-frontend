"use client";

import { useState, useCallback, useRef } from "react";
import { Track } from "@/lib/types";
import { openYouTube } from "@/lib/youtube";
import { useGlobalPlayer } from "./GlobalPlayerProvider";

interface TrackCardProps {
  track: Track;
  onVote: (id: string, status: "approved" | "rejected", advance?: boolean) => Promise<void>;
  onSkipEpisode?: () => void;
  skippingEpisode?: boolean;
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

export function TrackCard({ track, onVote, onSkipEpisode, skippingEpisode }: TrackCardProps) {
  const [exiting, setExiting] = useState<"left" | "right" | null>(null);
  const [voting, setVoting] = useState(false);
  const [approved, setApproved] = useState(false);
  const votingRef = useRef(false);
  const [copied, setCopied] = useState(false);
  const [swipeX, setSwipeX] = useState(0);
  const touchRef = useRef<{ startX: number; startY: number; swiping: boolean } | null>(null);
  const globalPlayer = useGlobalPlayer();

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(`${track.artist} - ${track.title}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [track.artist, track.title]);

  const handleVote = useCallback(
    async (status: "approved" | "rejected", advance: boolean = true) => {
      if (votingRef.current) return;

      // "Keep" without advance: approve in background, stay on card
      if (status === "approved" && !advance) {
        setApproved(true);
        await onVote(track.id, status, false);
        return;
      }

      votingRef.current = true;
      setVoting(true);
      setExiting(status === "approved" ? "right" : "left");
      // Wait for animation, then fire vote
      await new Promise((r) => setTimeout(r, 250));
      await onVote(track.id, status, true);
    },
    [track.id, onVote]
  );

  // Touch swipe handlers
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchRef.current = { startX: e.touches[0].clientX, startY: e.touches[0].clientY, swiping: false };
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!touchRef.current || votingRef.current) return;
    const dx = e.touches[0].clientX - touchRef.current.startX;
    const dy = e.touches[0].clientY - touchRef.current.startY;
    // Only start swiping if horizontal movement > vertical (prevents scroll hijack)
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
      handleVote(swipeX > 0 ? "approved" : "rejected");
    }
    setSwipeX(0);
    touchRef.current = null;
  }, [swipeX, handleVote]);

  const gradient = generateGradient(track.artist, track.title);
  const coverUrl = safeCoverUrl(track.cover_art_url);
  const meta = track.metadata as Record<string, string | undefined>;
  const hasAudio = !!(track.audio_url || track.preview_url);
  const hasPlayableSource = hasAudio || !!track.spotify_url;
  const isCurrentTrack = globalPlayer.currentTrack?.id === track.id;

  const handleArtworkPlay = useCallback(() => {
    // If this track is already playing in global player, toggle play/pause
    if (isCurrentTrack) {
      globalPlayer.togglePlayPause();
      return;
    }
    // Play in global player
    globalPlayer.play({
      id: track.id,
      artist: track.artist,
      title: track.title,
      coverArtUrl: safeCoverUrl(track.cover_art_url),
      spotifyUrl: track.spotify_url,
      audioUrl: track.audio_url || track.preview_url || null,
    });
  }, [track, isCurrentTrack, globalPlayer]);

  return (
    <div
      className={`w-full max-w-card mx-auto ${
        exiting === "left"
          ? "card-exit-left"
          : exiting === "right"
          ? "card-exit-right"
          : swipeX === 0
          ? "card-enter-active"
          : ""
      }`}
      style={swipeX !== 0 ? {
        transform: `translateX(${swipeX}px) rotate(${swipeX * 0.05}deg)`,
        transition: "none",
        opacity: Math.max(0.5, 1 - Math.abs(swipeX) / 300),
      } : undefined}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      <div className="rounded-2xl overflow-hidden shadow-2xl shadow-black/40 relative">
        {/* Full-bleed artwork card — everything overlaid */}
        <div
          className="relative aspect-[3/4] w-full flex flex-col"
          style={
            coverUrl
              ? { backgroundImage: `url(${coverUrl})`, backgroundSize: "cover", backgroundPosition: "center" }
              : { background: gradient }
          }
        >
          {/* Full gradient overlay for readability */}
          <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/30 to-black/40" />

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

          {/* Top bar: skip episode + YouTube + source context */}
          <div className="relative z-20 flex items-center justify-between p-4">
            {/* Skip episode — top left, subtle */}
            {onSkipEpisode ? (
              <button
                onClick={onSkipEpisode}
                disabled={skippingEpisode}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-black/30 backdrop-blur-md text-[11px] text-white/50 hover:text-red-400 hover:bg-red-950/40 transition-all active:scale-95 disabled:opacity-50"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 3h6v6" /><path d="M9 21H3v-6" /><path d="M21 3l-7 7" /><path d="M3 21l7-7" />
                </svg>
                {skippingEpisode ? "Skipping..." : "Skip ep"}
              </button>
            ) : <div />}

            {/* Right side: YouTube + now playing */}
            <div className="flex items-center gap-2">
              {isCurrentTrack && (
                <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-black/30 backdrop-blur-md text-[11px]">
                  <span className="flex gap-0.5 items-end h-2.5">
                    <span className={`w-0.5 bg-accent rounded-full ${globalPlayer.playing ? "animate-bounce" : ""}`} style={{ height: "40%", animationDelay: "0ms" }} />
                    <span className={`w-0.5 bg-accent rounded-full ${globalPlayer.playing ? "animate-bounce" : ""}`} style={{ height: "70%", animationDelay: "150ms" }} />
                    <span className={`w-0.5 bg-accent rounded-full ${globalPlayer.playing ? "animate-bounce" : ""}`} style={{ height: "50%", animationDelay: "300ms" }} />
                  </span>
                  <span className="text-accent">
                    {globalPlayer.playing ? "Playing" : "Paused"}
                  </span>
                </div>
              )}
              {track.youtube_url && (
                <button
                  onClick={() => openYouTube(track.youtube_url!)}
                  className="flex items-center justify-center w-8 h-8 rounded-full bg-black/30 backdrop-blur-md text-red-400/70 hover:text-red-400 hover:bg-black/50 transition-all active:scale-90"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>
                </button>
              )}
            </div>
          </div>

          {/* Center play/pause button */}
          {hasPlayableSource && (
            <button
              onClick={handleArtworkPlay}
              className="relative z-10 flex-1 flex items-center justify-center group/play"
            >
              <span
                className={`flex items-center justify-center w-16 h-16 rounded-full backdrop-blur-md transition-all active:scale-90 ${
                  isCurrentTrack && globalPlayer.playing
                    ? "bg-black/40 opacity-0 group-hover/play:opacity-100"
                    : "bg-black/30 opacity-100"
                } ${isCurrentTrack && globalPlayer.loading ? "opacity-100" : ""}`}
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
          )}

          {/* If no playable source, just fill space */}
          {!hasPlayableSource && <div className="flex-1" />}

          {/* Bottom section: track info + vote buttons */}
          <div className="relative z-20 p-5 pt-0 space-y-4">
            {/* Discovery context */}
            {(track.seed_track?.artist || (track.metadata as any)?.seed_artist) && (
              <p className="text-xs text-white/50 leading-relaxed truncate">
                via{" "}
                {track.seed_track ? (
                  <>
                    <span className="text-white/70">{track.seed_track.artist}</span>
                    {" — "}
                    <span className="text-white/60">{track.seed_track.title}</span>
                  </>
                ) : (
                  (track.metadata as any).seed_artist
                )}
                {(track.metadata as any)?.co_occurrence > 1 && ` · ${(track.metadata as any).co_occurrence} sets`}
              </p>
            )}

            {/* Source context */}
            {track.source_context && (
              track.source_url ? (
                <a
                  href={track.source_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-[11px] text-white/40 hover:text-accent transition-colors group truncate"
                >
                  <span className="text-accent">◉</span>
                  <span className="truncate underline underline-offset-2 decoration-white/15 group-hover:decoration-accent">
                    {track.source_context}
                  </span>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 opacity-40 group-hover:opacity-100">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
                  </svg>
                </a>
              ) : (
                <div className="flex items-center gap-1.5 text-[11px] text-white/40 truncate">
                  <span className="text-accent">◉</span>
                  <span className="truncate">{track.source_context}</span>
                </div>
              )
            )}

            {/* Track info */}
            <div className="pointer-events-none">
              <h2 className="text-2xl font-bold text-white leading-tight truncate">
                {track.title}
              </h2>
              <div className="flex items-center gap-2 mt-0.5">
                <p className="text-lg text-white/80 truncate">{track.artist}</p>
                <button
                  onClick={handleCopy}
                  className="pointer-events-auto flex-shrink-0 p-1 rounded-md hover:bg-white/10 active:scale-90 transition-all"
                  title="Copy artist - title"
                >
                  {copied ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                  )}
                </button>
              </div>
              <div className="flex items-center gap-2 mt-2">
                <span className="px-2 py-0.5 bg-white/10 backdrop-blur-sm rounded text-xs text-white/70">
                  {sourceLabel(track.source)}
                </span>
                {meta.genre && (
                  <span className="px-2 py-0.5 bg-white/10 backdrop-blur-sm rounded text-xs text-white/70">
                    {meta.genre}
                  </span>
                )}
                {meta.bpm && (
                  <span className="px-2 py-0.5 bg-white/10 backdrop-blur-sm rounded text-xs text-white/70">
                    {meta.bpm} BPM
                  </span>
                )}
              </div>
            </div>

            {/* Vote buttons — Tinder-style circular buttons */}
            <div className="flex items-center justify-center gap-5 pt-2">
              {/* Skip (reject) */}
              <button
                onClick={() => handleVote("rejected")}
                disabled={voting}
                className="flex items-center justify-center w-14 h-14 rounded-full bg-black/40 backdrop-blur-md border border-red-400/30 text-red-400/80 hover:bg-red-950/50 hover:border-red-400/60 hover:text-red-400 transition-all active:scale-90 disabled:opacity-50"
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>

              {/* Keep (approve without advancing) */}
              <button
                onClick={() => handleVote("approved", false)}
                disabled={voting || approved}
                className={`flex items-center justify-center w-10 h-10 rounded-full backdrop-blur-md border transition-all active:scale-90 disabled:cursor-default ${
                  approved
                    ? "bg-green-500/30 border-green-400/50 text-green-400"
                    : "bg-black/40 border-accent/30 text-accent/70 hover:bg-accent/20 hover:border-accent/60 hover:text-accent"
                }`}
              >
                {approved ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                  </svg>
                )}
              </button>

              {/* Keep & Next (approve and advance) */}
              <button
                onClick={() => handleVote("approved", true)}
                disabled={voting}
                className={`flex items-center justify-center w-14 h-14 rounded-full backdrop-blur-md border transition-all active:scale-90 disabled:opacity-50 ${
                  approved
                    ? "bg-green-500/30 border-green-400/50 text-green-400 hover:bg-green-500/40"
                    : "bg-black/40 border-green-400/30 text-green-400/80 hover:bg-green-950/50 hover:border-green-400/60 hover:text-green-400"
                }`}
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
