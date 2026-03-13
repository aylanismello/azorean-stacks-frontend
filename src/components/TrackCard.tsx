"use client";

import { useState, useCallback, useRef } from "react";
import { Track } from "@/lib/types";
import { AudioPlayer } from "./AudioPlayer";

interface TrackCardProps {
  track: Track;
  onVote: (id: string, status: "approved" | "rejected") => Promise<void>;
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

export function TrackCard({ track, onVote }: TrackCardProps) {
  const [exiting, setExiting] = useState<"left" | "right" | null>(null);
  const [voting, setVoting] = useState(false);
  const votingRef = useRef(false);

  const handleVote = useCallback(
    async (status: "approved" | "rejected") => {
      if (votingRef.current) return;
      votingRef.current = true;
      setVoting(true);
      setExiting(status === "approved" ? "right" : "left");
      // Wait for animation, then fire vote
      await new Promise((r) => setTimeout(r, 250));
      await onVote(track.id, status);
    },
    [track.id, onVote]
  );

  const gradient = generateGradient(track.artist, track.title);
  const coverUrl = safeCoverUrl(track.cover_art_url);
  const meta = track.metadata as Record<string, string | undefined>;

  return (
    <div
      className={`w-full max-w-card mx-auto transition-all duration-250 ${
        exiting === "left"
          ? "card-exit-left"
          : exiting === "right"
          ? "card-exit-right"
          : "card-enter-active"
      }`}
    >
      <div className="rounded-2xl overflow-hidden bg-surface-1 shadow-2xl shadow-black/40">
        {/* Cover art / gradient */}
        <div
          className="relative aspect-square w-full flex items-end"
          style={
            coverUrl
              ? { backgroundImage: `url(${coverUrl})`, backgroundSize: "cover", backgroundPosition: "center" }
              : { background: gradient }
          }
        >
          {/* Gradient overlay for text readability */}
          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />

          {/* Track info overlay */}
          <div className="relative z-10 p-5 w-full">
            <h2 className="text-2xl font-bold text-white leading-tight truncate">
              {track.title}
            </h2>
            <p className="text-lg text-white/80 mt-0.5 truncate">{track.artist}</p>
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
        </div>

        {/* Details section */}
        <div className="p-5 space-y-4">
          {/* Agent reason */}
          {track.agent_reason && (
            <p className="text-sm text-white/60 leading-relaxed italic">
              &ldquo;{track.agent_reason}&rdquo;
            </p>
          )}

          {/* Source context */}
          {track.source_context && (
            <div className="flex items-start gap-2 text-xs text-muted">
              <span className="text-accent mt-0.5">◉</span>
              <span>{track.source_context}</span>
            </div>
          )}

          {/* Audio preview */}
          {track.preview_url && (
            <AudioPlayer src={track.preview_url} coverArt={track.cover_art_url} />
          )}

          {/* Listen button — prominent YouTube link when no audio preview */}
          {!track.preview_url && track.youtube_url && (
            <a
              href={track.youtube_url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 w-full py-3 bg-surface-2 hover:bg-surface-3 rounded-xl text-sm text-white/80 hover:text-white transition-colors"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" className="text-red-400"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>
              Listen on YouTube
            </a>
          )}

          {/* External links row */}
          {(track.spotify_url || (track.youtube_url && track.preview_url)) && (
            <div className="flex gap-2">
              {track.spotify_url && (
                <a
                  href={track.spotify_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 px-3 py-2 bg-surface-2 hover:bg-surface-3 rounded-lg text-xs text-green-400 transition-colors"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg>
                  Spotify
                </a>
              )}
              {track.youtube_url && track.preview_url && (
                <a
                  href={track.youtube_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 px-3 py-2 bg-surface-2 hover:bg-surface-3 rounded-lg text-xs text-red-400 transition-colors"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>
                  YouTube
                </a>
              )}
            </div>
          )}

          {/* Vote buttons */}
          <div className="flex gap-3 pt-1">
            <button
              onClick={() => handleVote("rejected")}
              disabled={voting}
              className="flex-1 py-3.5 rounded-xl bg-surface-3 hover:bg-red-950/40 text-white/70 hover:text-red-400 text-base font-medium transition-all active:scale-95 disabled:opacity-50"
            >
              ✕ Skip
            </button>
            <button
              onClick={() => handleVote("approved")}
              disabled={voting}
              className="flex-1 py-3.5 rounded-xl bg-accent/15 hover:bg-accent/25 text-accent text-base font-medium transition-all active:scale-95 disabled:opacity-50"
            >
              ✓ Keep
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
