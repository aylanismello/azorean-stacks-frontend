"use client";

import { useState, useCallback, useRef } from "react";
import { Track } from "@/lib/types";
import { openYouTube } from "@/lib/youtube";
import { PlayerSection } from "./PlayerSection";
import { AudioPlayerHandle } from "./AudioPlayer";

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
  const playerRef = useRef<AudioPlayerHandle>(null);
  const [audioState, setAudioState] = useState({ playing: false, loading: false });
  const [copied, setCopied] = useState(false);

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

  const gradient = generateGradient(track.artist, track.title);
  const coverUrl = safeCoverUrl(track.cover_art_url);
  const meta = track.metadata as Record<string, string | undefined>;
  const hasAudio = !!(track.audio_url || track.preview_url);

  const handleArtworkPlay = useCallback(() => {
    playerRef.current?.toggle();
  }, []);

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

          {/* Play/pause overlay on artwork */}
          {hasAudio && (
            <button
              onClick={handleArtworkPlay}
              className="absolute inset-0 z-10 flex items-center justify-center group/play"
            >
              <span
                className={`flex items-center justify-center w-14 h-14 rounded-full backdrop-blur-md transition-all active:scale-90 ${
                  audioState.playing
                    ? "bg-black/50 opacity-0 group-hover/play:opacity-100"
                    : "bg-black/40 opacity-100"
                } ${audioState.loading ? "opacity-100" : ""}`}
              >
                {audioState.loading ? (
                  <svg className="animate-spin" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
                    <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
                  </svg>
                ) : audioState.playing ? (
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="white">
                    <rect x="6" y="4" width="4" height="16" rx="1" />
                    <rect x="14" y="4" width="4" height="16" rx="1" />
                  </svg>
                ) : (
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="white">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                )}
              </span>
            </button>
          )}

          {/* Track info overlay */}
          <div className="relative z-20 p-5 w-full pointer-events-none">
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
        </div>

        {/* Details section */}
        <div className="p-5 space-y-4">
          {/* Discovery context — seed track info */}
          {(track.seed_track?.artist || (track.metadata as any)?.seed_artist) && (
            <p className="text-sm text-white/60 leading-relaxed">
              via{" "}
              {track.seed_track ? (
                <>
                  <span className="text-white/80">{track.seed_track.artist}</span>
                  {" — "}
                  <span className="text-white/70">{track.seed_track.title}</span>
                </>
              ) : (
                (track.metadata as any).seed_artist
              )}
              {(track.metadata as any)?.co_occurrence > 1 && ` · ${(track.metadata as any).co_occurrence} sets`}
            </p>
          )}

          {/* Source context — link to episode/mix when URL available */}
          {track.source_context && (
            track.source_url ? (
              <a
                href={track.source_url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-start gap-2 text-xs text-muted hover:text-accent transition-colors group"
              >
                <span className="text-accent mt-0.5">◉</span>
                <span className="underline underline-offset-2 decoration-white/20 group-hover:decoration-accent">
                  {track.source_context}
                </span>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 shrink-0 opacity-40 group-hover:opacity-100">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
                </svg>
              </a>
            ) : (
              <div className="flex items-start gap-2 text-xs text-muted">
                <span className="text-accent mt-0.5">◉</span>
                <span>{track.source_context}</span>
              </div>
            )
          )}

          {/* Player — progress bar + controls, play button is on artwork */}
          <PlayerSection
            ref={playerRef}
            spotifyUrl={track.spotify_url}
            audioSrc={track.audio_url || track.preview_url}
            compact
            autoPlay
            externalPlayButton={hasAudio}
            onStateChange={setAudioState}
          />

          {/* YouTube link — shown separately if available */}
          {track.youtube_url && (
            <button
              onClick={() => openYouTube(track.youtube_url!)}
              className="flex items-center justify-center gap-2 py-2.5 bg-surface-2 hover:bg-surface-3 rounded-xl text-sm text-red-400/80 hover:text-red-400 transition-colors w-full"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>
              YouTube
            </button>
          )}

          {/* Vote buttons */}
          <div className="flex gap-2 pt-1">
            <button
              onClick={() => handleVote("rejected")}
              disabled={voting}
              className="flex-1 py-3 rounded-xl bg-surface-3 hover:bg-red-950/40 text-white/70 hover:text-red-400 text-sm font-medium transition-all active:scale-95 disabled:opacity-50"
            >
              Skip
            </button>
            <div className={`flex-1 flex rounded-xl overflow-hidden transition-all ${
              approved ? "bg-green-500/20" : "bg-accent/15"
            } ${voting ? "opacity-50" : ""}`}>
              <button
                onClick={() => handleVote("approved", false)}
                disabled={voting || approved}
                className={`flex-[4] py-3 text-sm font-medium transition-all active:scale-[0.97] disabled:cursor-default ${
                  approved
                    ? "text-green-400"
                    : "text-accent hover:bg-accent/10"
                }`}
              >
                {approved ? "Kept ✓" : "Keep"}
              </button>
              <button
                onClick={() => handleVote("approved", true)}
                disabled={voting}
                className={`flex-[1] py-3 border-l text-sm transition-all active:scale-[0.97] flex items-center justify-center ${
                  approved
                    ? "border-green-400/20 text-green-400 hover:bg-green-500/10"
                    : "border-accent/20 text-accent/60 hover:text-accent hover:bg-accent/10"
                }`}
              >
                →
              </button>
            </div>
          </div>

          {/* Skip episode */}
          {onSkipEpisode && (
            <button
              onClick={onSkipEpisode}
              disabled={skippingEpisode}
              className="w-full mt-2 py-2.5 rounded-xl border border-surface-3 bg-surface-2/50 hover:bg-red-950/30 hover:border-red-400/20 text-xs text-muted hover:text-red-400 font-medium transition-all active:scale-[0.98] disabled:opacity-50"
            >
              {skippingEpisode ? "Skipping episode..." : "Skip entire episode ×"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
