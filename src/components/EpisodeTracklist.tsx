"use client";

import { useState, useEffect, useRef } from "react";
import { useGlobalPlayer } from "./GlobalPlayerProvider";

interface TrackListItem {
  id: string;
  artist: string;
  title: string;
  status: string;
  spotify_url: string | null;
  youtube_url: string | null;
  cover_art_url: string | null;
  preview_url: string | null;
  audio_url?: string | null;
  storage_path: string | null;
}

interface EpisodeTracklistProps {
  episodeId: string;
  episodeTitle?: string | null;
  refreshKey?: number;
  onClose?: () => void;
  onTrackSelect?: (trackId: string) => void;
  variant?: "sidebar" | "sheet";
}

function safeCoverUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") return url;
  } catch {}
  return null;
}

export function EpisodeTracklist({
  episodeId,
  episodeTitle,
  refreshKey = 0,
  onClose,
  onTrackSelect,
  variant = "sidebar",
}: EpisodeTracklistProps) {
  const [tracks, setTracks] = useState<TrackListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const globalPlayer = useGlobalPlayer();
  const playingRef = useRef<HTMLButtonElement>(null);
  const prevEpisodeIdRef = useRef(episodeId);

  useEffect(() => {
    // Show loading spinner only on initial load or episode change, not on vote refreshes
    const isNewEpisode = prevEpisodeIdRef.current !== episodeId;
    prevEpisodeIdRef.current = episodeId;
    if (isNewEpisode || tracks.length === 0) {
      setLoading(true);
    }
    setError(null);
    fetch(`/api/episodes/${episodeId}/tracks?_t=${Date.now()}`)
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to load tracks (${r.status})`);
        return r.json();
      })
      .then((data) => setTracks(Array.isArray(data) ? data : []))
      .catch((err) => {
        setTracks([]);
        setError(err instanceof Error ? err.message : "Failed to load tracklist");
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [episodeId, refreshKey]);

  // Auto-scroll to playing track when tracklist loads or track changes
  useEffect(() => {
    if (!loading && playingRef.current) {
      playingRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [loading, globalPlayer.currentTrack?.id]);

  const handlePlay = (t: TrackListItem) => {
    const audioUrl = t.audio_url || t.preview_url || null;
    globalPlayer.play({
      id: t.id,
      artist: t.artist,
      title: t.title,
      coverArtUrl: safeCoverUrl(t.cover_art_url),
      spotifyUrl: t.spotify_url,
      audioUrl,
      episodeId,
      episodeTitle: episodeTitle || undefined,
      youtubeUrl: t.youtube_url,
    });
  };

  const statusDot = (s: string) => {
    if (s === "approved" || s === "downloaded") return "bg-green-500";
    if (s === "rejected") return "bg-red-500/60";
    return "bg-white/20";
  };

  const statusText = (s: string) => {
    if (s === "approved" || s === "downloaded") return "text-white/80";
    if (s === "rejected") return "text-white/30 line-through";
    return "text-white/60";
  };

  const approved = tracks.filter((t) => t.status === "approved" || t.status === "downloaded").length;
  const rejected = tracks.filter((t) => t.status === "rejected").length;
  const pending = tracks.filter((t) => t.status === "pending").length;

  const content = (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex-shrink-0 px-4 pt-4 pb-3 border-b border-surface-3">
        <div className="flex items-center justify-between">
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-medium text-white truncate">
              {episodeTitle || "Episode tracklist"}
            </h3>
            {!loading && (
              <div className="flex items-center gap-3 mt-1 text-[10px] font-mono text-muted">
                <span>{tracks.length} tracks</span>
                {approved > 0 && <span className="text-green-400/70">{approved} kept</span>}
                {rejected > 0 && <span className="text-red-400/50">{rejected} skipped</span>}
                {pending > 0 && <span className="text-white/40">{pending} pending</span>}
              </div>
            )}
          </div>
          {onClose && (
            <button
              onClick={onClose}
              className="p-2 rounded-full bg-white/10 hover:bg-white/20 text-white/80 hover:text-white transition-colors"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Track list */}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {loading ? (
          <div className="flex justify-center py-8">
            <div className="w-5 h-5 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
          </div>
        ) : error ? (
          <p className="text-center text-red-400/70 text-xs py-8">{error}</p>
        ) : tracks.length === 0 ? (
          <p className="text-center text-muted text-xs py-8">No tracks in this episode</p>
        ) : (
          <div className="space-y-0.5">
            {tracks.map((t) => {
              const isPlaying = globalPlayer.currentTrack?.id === t.id;
              const hasAudio = !!(t.audio_url || t.preview_url || t.spotify_url);
              return (
                <button
                  key={t.id}
                  ref={isPlaying ? playingRef : undefined}
                  onClick={() => {
                    onTrackSelect?.(t.id);
                    if (hasAudio) handlePlay(t);
                  }}
                  disabled={false}
                  className={`w-full text-left px-3 py-2 rounded-lg flex items-center gap-2.5 transition-colors group ${
                    isPlaying
                      ? "bg-accent/10 border border-accent/20"
                      : "hover:bg-surface-2 border border-transparent"
                  } ${!hasAudio ? "opacity-40 cursor-default" : ""}`}
                >
                  {/* Status dot */}
                  <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${statusDot(t.status)}`} />

                  {/* Now playing indicator */}
                  {isPlaying ? (
                    <span className="flex gap-0.5 items-end h-3 w-3 flex-shrink-0">
                      <span className={`w-0.5 bg-accent rounded-full ${globalPlayer.playing ? "animate-bounce" : ""}`} style={{ height: "40%", animationDelay: "0ms" }} />
                      <span className={`w-0.5 bg-accent rounded-full ${globalPlayer.playing ? "animate-bounce" : ""}`} style={{ height: "70%", animationDelay: "150ms" }} />
                      <span className={`w-0.5 bg-accent rounded-full ${globalPlayer.playing ? "animate-bounce" : ""}`} style={{ height: "50%", animationDelay: "300ms" }} />
                    </span>
                  ) : (
                    <span className="w-3 flex-shrink-0" />
                  )}

                  {/* Track info */}
                  <div className="min-w-0 flex-1">
                    <p className={`text-xs truncate ${isPlaying ? "text-accent font-medium" : statusText(t.status)}`}>
                      {t.title}
                    </p>
                    <p className="text-[10px] text-muted truncate">{t.artist}</p>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );

  if (variant === "sheet") {
    return <div className="flex-1 min-h-0 flex flex-col">{content}</div>;
  }

  return (
    <div className="h-full w-full bg-surface-1 rounded-xl border border-surface-3 overflow-hidden">
      {content}
    </div>
  );
}

// Mobile bottom sheet wrapper — liquid glass overlay
export function TracklistSheet({
  episodeId,
  episodeTitle,
  refreshKey,
  open,
  onClose,
  onTrackSelect,
}: {
  episodeId: string;
  episodeTitle?: string | null;
  refreshKey?: number;
  open: boolean;
  onClose: () => void;
  onTrackSelect?: (trackId: string) => void;
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 md:hidden sheet-enter">
      {/* Liquid glass sheet — full page coverage */}
      <div className="absolute inset-0 liquid-glass flex flex-col overflow-hidden">
        {/* Drag handle */}
        <div className="flex justify-center pt-3 pb-1 flex-shrink-0">
          <div className="w-10 h-1 rounded-full bg-white/25" />
        </div>
        <EpisodeTracklist
          episodeId={episodeId}
          episodeTitle={episodeTitle}
          refreshKey={refreshKey}
          onClose={onClose}
          onTrackSelect={onTrackSelect}
          variant="sheet"
        />
      </div>
    </div>
  );
}
