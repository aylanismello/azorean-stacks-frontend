"use client";

import { useRef, useState, useEffect } from "react";

interface AudioPlayerProps {
  src: string | null;
  coverArt?: string | null;
}

export function AudioPlayer({ src }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    setPlaying(false);
    setProgress(0);
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
  }, [src]);

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

  const handleTimeUpdate = () => {
    if (!audioRef.current) return;
    setProgress(audioRef.current.currentTime);
  };

  const handleLoadedMetadata = () => {
    if (!audioRef.current) return;
    setDuration(audioRef.current.duration);
  };

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!audioRef.current || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    audioRef.current.currentTime = pct * duration;
  };

  const fmt = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  return (
    <div className="flex items-center gap-3 w-full">
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
        className="w-10 h-10 flex-shrink-0 flex items-center justify-center rounded-full bg-accent text-surface-0 font-bold text-lg hover:bg-accent-bright transition-colors"
      >
        {playing ? "❚❚" : "▶"}
      </button>
      <div className="flex-1 flex flex-col gap-1">
        <div
          className="h-1.5 bg-surface-3 rounded-full cursor-pointer overflow-hidden"
          onClick={handleSeek}
        >
          <div
            className="h-full bg-accent rounded-full transition-[width] duration-200"
            style={{ width: duration ? `${(progress / duration) * 100}%` : "0%" }}
          />
        </div>
        <div className="flex justify-between text-[10px] text-muted font-mono">
          <span>{fmt(progress)}</span>
          <span>{duration ? fmt(duration) : "--:--"}</span>
        </div>
      </div>
    </div>
  );
}
