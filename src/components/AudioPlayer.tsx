"use client";

import { useRef, useState, useEffect, useCallback } from "react";

interface AudioPlayerProps {
  src: string | null;
  coverArt?: string | null;
  compact?: boolean;
  autoPlay?: boolean;
}

export function AudioPlayer({ src, compact = false, autoPlay = false }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    setProgress(0);
    setDuration(0);
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      if (autoPlay && src) {
        audioRef.current.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
      } else {
        setPlaying(false);
      }
    } else {
      setPlaying(false);
    }
  }, [src, autoPlay]);

  if (!src) return null;

  // YouTube links: show as external link
  if (src.includes("youtube.com") || src.includes("youtu.be")) {
    return (
      <a
        href={src}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-2 px-4 py-2.5 bg-surface-2 hover:bg-surface-3 rounded-lg text-sm text-accent transition-colors"
      >
        <span className="text-lg">▶</span>
        <span>Play on YouTube</span>
      </a>
    );
  }

  const toggle = () => {
    if (!audioRef.current) return;
    if (playing) {
      audioRef.current.pause();
    } else {
      audioRef.current.play();
    }
    setPlaying(!playing);
  };

  const skip = (seconds: number) => {
    if (!audioRef.current) return;
    audioRef.current.currentTime = Math.max(
      0,
      Math.min(audioRef.current.duration || 0, audioRef.current.currentTime + seconds)
    );
  };

  const handleTimeUpdate = () => {
    if (!audioRef.current || dragging) return;
    setProgress(audioRef.current.currentTime);
  };

  const handleLoadedMetadata = () => {
    if (!audioRef.current) return;
    setDuration(audioRef.current.duration);
  };

  const seekTo = (clientX: number) => {
    if (!audioRef.current || !duration || !progressRef.current) return;
    const rect = progressRef.current.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const time = pct * duration;
    audioRef.current.currentTime = time;
    setProgress(time);
  };

  const handleSeekStart = (e: React.MouseEvent<HTMLDivElement>) => {
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
  };

  const handleTouchSeek = (e: React.TouchEvent<HTMLDivElement>) => {
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
  };

  const fmt = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  const pct = duration ? (progress / duration) * 100 : 0;

  if (compact) {
    return (
      <div className="w-full bg-surface-2 rounded-lg p-2 flex items-center gap-2">
        <audio
          ref={audioRef}
          src={src}
          onTimeUpdate={handleTimeUpdate}
          onLoadedMetadata={handleLoadedMetadata}
          onEnded={() => setPlaying(false)}
          preload="metadata"
        />
        <button
          onClick={toggle}
          className="w-8 h-8 flex-shrink-0 flex items-center justify-center rounded-full bg-accent text-surface-0 hover:bg-accent-bright transition-all active:scale-95"
        >
          {playing ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="4" width="4" height="16" rx="1" />
              <rect x="14" y="4" width="4" height="16" rx="1" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>
        <div
          ref={progressRef}
          className="group relative flex-1 h-1.5 bg-surface-3 rounded-full cursor-pointer touch-none"
          onMouseDown={handleSeekStart}
          onTouchStart={handleTouchSeek}
        >
          <div
            className="absolute inset-y-0 left-0 bg-accent rounded-full transition-[width] duration-75"
            style={{ width: `${pct}%` }}
          />
          <div
            className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 bg-accent rounded-full shadow-lg shadow-black/50 transition-transform ${
              dragging ? "scale-125" : "scale-0 group-hover:scale-100"
            }`}
            style={{ left: `${pct}%` }}
          />
        </div>
        <span className="text-[10px] text-muted font-mono flex-shrink-0 w-8 text-right">
          {fmt(progress)}
        </span>
      </div>
    );
  }

  return (
    <div className="w-full bg-surface-2 rounded-xl p-3 space-y-2.5">
      <audio
        ref={audioRef}
        src={src}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onEnded={() => setPlaying(false)}
        preload="metadata"
      />

      {/* Progress bar — tall, easy to grab */}
      <div
        ref={progressRef}
        className="group relative h-2 bg-surface-3 rounded-full cursor-pointer touch-none"
        onMouseDown={handleSeekStart}
        onTouchStart={handleTouchSeek}
      >
        {/* Filled track */}
        <div
          className="absolute inset-y-0 left-0 bg-accent rounded-full transition-[width] duration-75"
          style={{ width: `${pct}%` }}
        />
        {/* Scrub handle */}
        <div
          className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-4 h-4 bg-accent rounded-full shadow-lg shadow-black/50 transition-transform ${
            dragging ? "scale-125" : "scale-0 group-hover:scale-100"
          }`}
          style={{ left: `${pct}%` }}
        />
      </div>

      {/* Time labels */}
      <div className="flex justify-between text-[10px] text-muted font-mono px-0.5">
        <span>{fmt(progress)}</span>
        <span>{duration ? fmt(duration) : "--:--"}</span>
      </div>

      {/* Controls */}
      <div className="flex items-center justify-center gap-1">
        {/* Rewind 15s */}
        <button
          onClick={() => skip(-15)}
          className="w-10 h-10 flex items-center justify-center rounded-full text-white/50 hover:text-white hover:bg-surface-3 transition-all active:scale-90"
          title="Back 15s"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 4v6h6" />
            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
            <text x="12" y="15.5" textAnchor="middle" fill="currentColor" stroke="none" fontSize="7" fontWeight="700" fontFamily="sans-serif">15</text>
          </svg>
        </button>

        {/* Rewind 5s */}
        <button
          onClick={() => skip(-5)}
          className="w-9 h-9 flex items-center justify-center rounded-full text-white/40 hover:text-white hover:bg-surface-3 transition-all active:scale-90"
          title="Back 5s"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="11 17 6 12 11 7" />
            <polyline points="18 17 13 12 18 7" />
          </svg>
        </button>

        {/* Play / Pause */}
        <button
          onClick={toggle}
          className="w-12 h-12 flex items-center justify-center rounded-full bg-accent text-surface-0 hover:bg-accent-bright transition-all active:scale-95 mx-1"
        >
          {playing ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="4" width="4" height="16" rx="1" />
              <rect x="14" y="4" width="4" height="16" rx="1" />
            </svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>

        {/* Forward 5s */}
        <button
          onClick={() => skip(5)}
          className="w-9 h-9 flex items-center justify-center rounded-full text-white/40 hover:text-white hover:bg-surface-3 transition-all active:scale-90"
          title="Forward 5s"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="13 17 18 12 13 7" />
            <polyline points="6 17 11 12 6 7" />
          </svg>
        </button>

        {/* Forward 15s */}
        <button
          onClick={() => skip(15)}
          className="w-10 h-10 flex items-center justify-center rounded-full text-white/50 hover:text-white hover:bg-surface-3 transition-all active:scale-90"
          title="Forward 15s"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M23 4v6h-6" />
            <path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10" />
            <text x="12" y="15.5" textAnchor="middle" fill="currentColor" stroke="none" fontSize="7" fontWeight="700" fontFamily="sans-serif">15</text>
          </svg>
        </button>
      </div>
    </div>
  );
}
