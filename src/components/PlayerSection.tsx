"use client";

import { useState } from "react";
import { AudioPlayer } from "./AudioPlayer";
import { SpotifyEmbed } from "./SpotifyEmbed";

interface PlayerSectionProps {
  spotifyUrl?: string | null;
  audioSrc?: string | null;
  compact?: boolean;
  autoPlay?: boolean;
}

export function PlayerSection({ spotifyUrl, audioSrc, compact = false, autoPlay = false }: PlayerSectionProps) {
  const hasAudio = !!audioSrc;
  const hasSpotify = !!spotifyUrl;
  const hasBoth = hasAudio && hasSpotify;

  // Default to audio when both are available
  const [activeTab, setActiveTab] = useState<"audio" | "spotify">(hasAudio ? "audio" : "spotify");

  if (!hasAudio && !hasSpotify) {
    return (
      <div className="flex items-center gap-2 py-3 px-4 bg-surface-2 rounded-xl text-sm text-white/30">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="opacity-50">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
          <line x1="23" y1="9" x2="17" y2="15" />
          <line x1="17" y1="9" x2="23" y2="15" />
        </svg>
        Audio not yet available
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {hasBoth && (
        <div className="flex gap-1">
          <button
            onClick={() => setActiveTab("audio")}
            className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
              activeTab === "audio"
                ? "bg-accent/15 text-accent"
                : "text-muted/60 hover:text-muted"
            }`}
          >
            Audio
          </button>
          <button
            onClick={() => setActiveTab("spotify")}
            className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors flex items-center gap-1 ${
              activeTab === "spotify"
                ? "bg-green-400/15 text-green-400"
                : "text-muted/60 hover:text-muted"
            }`}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg>
            Spotify
          </button>
        </div>
      )}
      {activeTab === "audio" && hasAudio && (
        <AudioPlayer src={audioSrc} compact={compact} autoPlay={autoPlay} />
      )}
      {activeTab === "spotify" && hasSpotify && (
        <SpotifyEmbed spotifyUrl={spotifyUrl!} compact={compact || hasBoth} autoPlay={autoPlay && !hasAudio} />
      )}
      {/* Only spotify, no tabs needed */}
      {!hasBoth && hasSpotify && activeTab !== "spotify" && (
        <SpotifyEmbed spotifyUrl={spotifyUrl!} compact={compact} autoPlay={autoPlay} />
      )}
    </div>
  );
}
