"use client";

import { useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useGlobalPlayer } from "./GlobalPlayerProvider";
import { openYouTube } from "@/lib/youtube";

function fmt(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function generateGradient(artist: string, title: string): string {
  let hash = 0;
  const str = artist + title;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h1 = Math.abs(hash % 360);
  return `hsl(${h1}, 40%, 20%)`;
}

export function GlobalPlayer() {
  const { currentTrack, playing, loading, progress, duration, source, noSource, togglePlayPause, seek, stop, playbackOrigin } = useGlobalPlayer();
  const router = useRouter();
  const progressRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  const pct = duration > 0 ? (progress / duration) * 100 : 0;

  const seekTo = useCallback((clientX: number) => {
    if (!duration || !progressRef.current) return;
    const rect = progressRef.current.getBoundingClientRect();
    const p = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    seek(p * duration);
  }, [duration, seek]);

  const handleSeekStart = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    setDragging(true);
    seekTo(e.clientX);
    const handleMove = (ev: MouseEvent) => seekTo(ev.clientX);
    const handleUp = () => {
      setDragging(false);
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
  }, [seekTo]);

  const handleTouchSeek = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    setDragging(true);
    seekTo(e.touches[0].clientX);
    const handleMove = (ev: TouchEvent) => {
      ev.preventDefault();
      seekTo(ev.touches[0].clientX);
    };
    const handleEnd = () => {
      setDragging(false);
      window.removeEventListener("touchmove", handleMove);
      window.removeEventListener("touchend", handleEnd);
    };
    window.addEventListener("touchmove", handleMove, { passive: false });
    window.addEventListener("touchend", handleEnd);
  }, [seekTo]);

  if (!currentTrack) return null;

  const bgColor = currentTrack.coverArtUrl ? undefined : generateGradient(currentTrack.artist, currentTrack.title);

  return (
    <div className="global-player fixed left-0 right-0 z-40 hidden md:block md:bottom-0">
      {/* Player bar */}
      <div className="global-player-shell border-t border-surface-2 px-3 py-2">
        {/* Progress bar */}
        <div
          ref={progressRef}
          className="group relative z-10 mb-2 flex h-4 cursor-pointer items-center touch-none"
          onMouseDown={handleSeekStart}
          onTouchStart={handleTouchSeek}
        >
          <div className="relative h-1.5 w-full overflow-visible rounded-full bg-surface-3/80 transition-all group-hover:bg-surface-3">
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-accent transition-[width] duration-75"
              style={{ width: `${pct}%` }}
            />
            <div
              className={`absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-black/10 bg-accent shadow-lg shadow-black/40 transition-all ${
                dragging ? "scale-125 opacity-100" : "scale-0 group-hover:scale-100 opacity-0 group-hover:opacity-100"
              }`}
              style={{ left: `${pct}%` }}
            />
          </div>
        </div>

        {/* Controls row */}
        <div className="flex items-center gap-3">
        {/* Album art / gradient — click to return to where playback started */}
        <button
          onClick={() => {
            // Navigate back to the origin URL where the user started playing
            // This preserves FYP, seed stack, genre, or episode context
            if (playbackOrigin) {
              router.push(playbackOrigin);
            } else if (currentTrack.episodeId) {
              const params = new URLSearchParams();
              params.set("episode_id", currentTrack.episodeId);
              if (currentTrack.episodeTitle) params.set("episode_title", currentTrack.episodeTitle);
              router.push(`/?${params.toString()}`);
            } else {
              router.push("/");
            }
          }}
          className="w-10 h-10 rounded-md flex-shrink-0 overflow-hidden hover:ring-1 hover:ring-accent/50 transition-all active:scale-95"
          style={
            currentTrack.coverArtUrl
              ? { backgroundImage: `url(${currentTrack.coverArtUrl})`, backgroundSize: "cover", backgroundPosition: "center" }
              : { backgroundColor: bgColor }
          }
          title="Go to playing track"
        />

        {/* Track info */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground truncate leading-tight">
            {currentTrack.title}
          </p>
          <p className="text-xs text-muted truncate leading-tight">
            {currentTrack.artist}
          </p>
        </div>

        {/* External links: Spotify + YouTube — clickable */}
        {currentTrack.spotifyUrl && (
          <a
            href={currentTrack.spotifyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-shrink-0 hover:scale-110 transition-transform active:scale-95"
            title="Open in Spotify"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="#1DB954">
              <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
            </svg>
          </a>
        )}
        {currentTrack.youtubeUrl && (
          <button
            onClick={() => openYouTube(currentTrack.youtubeUrl!)}
            className="flex-shrink-0 text-red-400/70 hover:text-red-400 hover:scale-110 transition-all active:scale-95"
            title="Open on YouTube"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>
          </button>
        )}

        {noSource ? (
          <span className="flex items-center gap-1.5 text-xs text-white/30 flex-shrink-0 px-2">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="opacity-60">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
              <line x1="23" y1="9" x2="17" y2="15" />
              <line x1="17" y1="9" x2="23" y2="15" />
            </svg>
            No audio source
          </span>
        ) : (
          <>
            {/* Time */}
            <span className="text-[10px] text-muted font-mono flex-shrink-0 hidden sm:block">
              {duration > 0 ? `${fmt(progress)} / ${fmt(duration)}` : ""}
            </span>

            {/* Restart */}
            <button
              onClick={() => seek(0)}
              className="w-7 h-7 flex items-center justify-center rounded-full text-muted hover:text-foreground hover:bg-surface-3 transition-all flex-shrink-0"
              title="Restart track"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <rect x="4" y="5" width="3" height="14" rx="1" />
                <path d="M20 5v14l-11-7z" />
              </svg>
            </button>

            {/* Play/pause */}
            <button
              onClick={togglePlayPause}
              className="w-9 h-9 flex items-center justify-center rounded-full bg-foreground text-surface-0 hover:scale-105 transition-transform active:scale-95 flex-shrink-0"
              title={playing ? "Pause track" : "Play track"}
              aria-label={playing ? "Pause track" : "Play track"}
            >
              {loading ? (
                <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
                </svg>
              ) : playing ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="4" width="4" height="16" rx="1" />
                  <rect x="14" y="4" width="4" height="16" rx="1" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
            </button>

            {/* Skip 30s */}
            <button
              onClick={() => seek(progress + 30)}
              className="w-7 h-7 flex items-center justify-center rounded-full text-muted hover:text-foreground hover:bg-surface-3 transition-all flex-shrink-0"
              title="Skip ahead 30 seconds"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M13 4l5 4-5 4" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M18 8H8a5 5 0 0 0 0 10h2" strokeLinecap="round" />
                <text x="9" y="18" fontSize="7" fontWeight="bold" fill="currentColor" stroke="none" fontFamily="sans-serif">30</text>
              </svg>
            </button>
          </>
        )}

        {/* Close */}
        <button
          onClick={stop}
          className="w-7 h-7 flex items-center justify-center rounded-full text-muted hover:text-white hover:bg-surface-3 transition-all flex-shrink-0"
          title="Close player"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
        </div>
      </div>
    </div>
  );
}
