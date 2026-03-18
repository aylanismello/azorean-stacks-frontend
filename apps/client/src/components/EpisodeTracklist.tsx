"use client";

import { useState, useEffect, useRef } from "react";
import { useGlobalPlayer } from "./GlobalPlayerProvider";
import { supabase } from "@/lib/supabase";

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
  dl_failed_at?: string | null;
  is_seed?: boolean;
  is_re_seed?: boolean;
  is_artist_seed?: boolean;
  super_liked?: boolean;
  vote_status?: "approved" | "rejected" | "skipped" | "listened" | "pending" | null;
  // Ranked queue scoring metadata
  _match_type?: "full" | "artist" | "unknown";
  _ranked_score?: number;
}

interface BaseTracklistProps {
  listTitle?: string | null;
  onClose?: () => void;
  onTrackSelect?: (trackId: string) => void;
  variant?: "sidebar" | "sheet";
}

interface EpisodeTracklistProps extends BaseTracklistProps {
  episodeId: string;
  episodeTitle?: string | null;
  refreshKey?: number;
  seedId?: string | null;
  directTracks?: never;
}

interface DirectTracklistProps extends BaseTracklistProps {
  directTracks: TrackListItem[];
  episodeId?: never;
  episodeTitle?: never;
  refreshKey?: never;
}

type TracklistProps = EpisodeTracklistProps | DirectTracklistProps;

function safeCoverUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") return url;
  } catch {}
  return null;
}

export function EpisodeTracklist(props: TracklistProps) {
  const {
    listTitle,
    onClose,
    onTrackSelect,
    variant = "sidebar",
  } = props;

  const isDirectMode = "directTracks" in props && !!props.directTracks;
  const episodeId = isDirectMode ? undefined : (props as EpisodeTracklistProps).episodeId;
  const episodeTitle = isDirectMode ? undefined : (props as EpisodeTracklistProps).episodeTitle;
  const refreshKey = isDirectMode ? 0 : ((props as EpisodeTracklistProps).refreshKey || 0);
  const seedId = isDirectMode ? undefined : (props as EpisodeTracklistProps).seedId;

  const [fetchedTracks, setFetchedTracks] = useState<TrackListItem[]>([]);
  const [loading, setLoading] = useState(!isDirectMode);
  const [error, setError] = useState<string | null>(null);
  const globalPlayer = useGlobalPlayer();
  const playingRef = useRef<HTMLButtonElement>(null);
  const prevEpisodeIdRef = useRef(episodeId);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  // Fetch tracks from API when in episode mode, then subscribe to realtime updates
  useEffect(() => {
    if (isDirectMode || !episodeId) return;

    // Tear down any existing realtime subscription
    if (channelRef.current) {
      supabase.removeChannel(channelRef.current);
      channelRef.current = null;
    }

    const isNewEpisode = prevEpisodeIdRef.current !== episodeId;
    prevEpisodeIdRef.current = episodeId;
    if (isNewEpisode || fetchedTracks.length === 0) {
      setLoading(true);
    }
    setError(null);

    let mounted = true;

    const seedParam = seedId ? `&seed_id=${seedId}` : "";
    fetch(`/api/episodes/${episodeId}/tracks?_t=${Date.now()}${seedParam}`)
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to load tracks (${r.status})`);
        return r.json();
      })
      .then((data) => {
        if (!mounted) return;
        const tracks: TrackListItem[] = Array.isArray(data) ? data : [];
        setFetchedTracks(tracks);

        // Subscribe to realtime updates for these specific tracks
        if (tracks.length > 0) {
          const trackIds = tracks.map((t) => t.id);
          const channel = supabase
            .channel(`tracks-ep-${episodeId}`)
            .on(
              "postgres_changes",
              {
                event: "UPDATE",
                schema: "public",
                table: "tracks",
                filter: `id=in.(${trackIds.join(",")})`,
              },
              (payload) => {
                setFetchedTracks((prev) =>
                  prev.map((t) =>
                    t.id === (payload.new as TrackListItem).id
                      ? { ...t, ...(payload.new as Partial<TrackListItem>) }
                      : t
                  )
                );
              }
            )
            .subscribe();
          channelRef.current = channel;
        }
      })
      .catch((err) => {
        if (!mounted) return;
        setFetchedTracks([]);
        setError(err instanceof Error ? err.message : "Failed to load tracklist");
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => {
      mounted = false;
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [episodeId, refreshKey, isDirectMode]);

  const tracks = isDirectMode ? (props as DirectTracklistProps).directTracks : fetchedTracks;

  // Auto-scroll to playing track when tracklist loads or track changes
  useEffect(() => {
    if (!loading && playingRef.current) {
      playingRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [loading, globalPlayer.currentTrack?.id]);

  const handlePlay = (t: TrackListItem) => {
    const audioUrl = t.audio_url || t.preview_url || null;
    const origin = typeof window !== "undefined" ? window.location.pathname + window.location.search : "/";
    const trackPayload = {
      id: t.id,
      artist: t.artist,
      title: t.title,
      coverArtUrl: safeCoverUrl(t.cover_art_url),
      spotifyUrl: t.spotify_url,
      audioUrl,
      episodeId: episodeId,
      episodeTitle: episodeTitle || undefined,
      youtubeUrl: t.youtube_url,
    };

    if (audioUrl || t.spotify_url) {
      globalPlayer.play(trackPayload, origin);
    } else {
      globalPlayer.loadTrack(trackPayload, origin);
    }
  };

  const statusText = (s: string) => {
    if (s === "approved") return "text-foreground/80";
    if (s === "rejected") return "text-foreground/30 line-through";
    if (s === "skipped") return "text-foreground/40";
    if (s === "listened") return "text-foreground/40";
    return "text-foreground/60";
  };

  const downloadDot = (t: TrackListItem) => {
    if (t.status === "listened")
      return (
        <span className="relative flex-shrink-0 w-1.5 h-1.5" title="Heard">
          <span className="w-1.5 h-1.5 rounded-full bg-foreground/25 block" />
        </span>
      );
    if (t.storage_path)
      return <span className="w-1.5 h-1.5 rounded-full bg-green-500 flex-shrink-0" title="Downloaded" />;
    if (t.dl_failed_at)
      return <span className="w-1.5 h-1.5 rounded-full bg-red-500 flex-shrink-0" title="Download failed" />;
    if (t.spotify_url || t.youtube_url)
      return <span className="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0" title="Enriched" />;
    return <span className="w-1.5 h-1.5 rounded-full bg-foreground/20 animate-pulse flex-shrink-0" title="Pending" />;
  };

  // Download-based header stats
  const downloaded = tracks.filter((t) => !!t.storage_path).length;
  const enrichedCount = tracks.filter((t) => !t.storage_path && !t.dl_failed_at && !!(t.spotify_url || t.youtube_url)).length;
  const failed = tracks.filter((t) => !!t.dl_failed_at && !t.storage_path).length;
  const dlPending = tracks.filter((t) => !t.storage_path && !t.spotify_url && !t.youtube_url && !t.dl_failed_at).length;

  const displayTitle = listTitle || episodeTitle || "Tracklist";

  const content = (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex-shrink-0 px-4 pt-4 pb-3 border-b border-surface-3">
        <div className="flex items-center justify-between">
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-medium text-foreground truncate">
              {displayTitle}
            </h3>
            {!loading && (
              <div className="flex items-center gap-3 mt-1 text-[10px] font-mono text-muted">
                <span>{tracks.length} tracks</span>
                {downloaded > 0 && <span className="text-green-400/70">{downloaded} downloaded</span>}
                {enrichedCount > 0 && <span className="text-amber-400/70">{enrichedCount} enriched</span>}
                {failed > 0 && <span className="text-red-400/70">{failed} failed</span>}
                {dlPending > 0 && <span className="text-foreground/40">{dlPending} pending</span>}
              </div>
            )}
          </div>
          {onClose && (
            <button
              onClick={onClose}
              className="p-2 rounded-full bg-foreground/10 hover:bg-foreground/20 text-foreground/80 hover:text-foreground transition-colors"
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
          <p className="text-center text-muted text-xs py-8">No tracks</p>
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
                    if (t.is_seed) return; // Seed tracks are non-interactive (reference track)
                    onTrackSelect?.(t.id);
                    handlePlay(t);
                  }}
                  disabled={false}
                  className={`w-full text-left px-2 py-1.5 rounded-lg flex items-center gap-2.5 transition-colors group border ${
                    t.is_seed
                      ? "bg-green-500/5 border-green-500/15 cursor-default"
                      : isPlaying
                        ? "bg-accent/10 border-accent/20"
                        : t.storage_path
                          ? "hover:bg-surface-2 border-surface-3/60"
                          : "hover:bg-surface-2/50 border-transparent"
                  }`}
                >
                  {/* Cover art thumbnail — 36x36 */}
                  <span className={`relative w-9 h-9 flex-shrink-0 rounded-md overflow-hidden ${!t.storage_path ? "opacity-30" : ""}`}>
                    {isPlaying && (globalPlayer.currentTrack?.coverArtUrl || t.cover_art_url) ? (
                      <>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={globalPlayer.currentTrack?.coverArtUrl || t.cover_art_url!}
                          alt=""
                          className="w-full h-full object-cover"
                        />
                        <span className="absolute inset-0 flex items-center justify-center bg-black/40">
                          <span className="flex gap-0.5 items-end h-3">
                            <span className={`w-0.5 bg-white rounded-full ${globalPlayer.playing ? "animate-bounce" : ""}`} style={{ height: "40%", animationDelay: "0ms" }} />
                            <span className={`w-0.5 bg-white rounded-full ${globalPlayer.playing ? "animate-bounce" : ""}`} style={{ height: "70%", animationDelay: "150ms" }} />
                            <span className={`w-0.5 bg-white rounded-full ${globalPlayer.playing ? "animate-bounce" : ""}`} style={{ height: "50%", animationDelay: "300ms" }} />
                          </span>
                        </span>
                      </>
                    ) : t.cover_art_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={t.cover_art_url} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <span className="w-full h-full flex items-center justify-center bg-gradient-to-br from-surface-3 to-surface-4">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-foreground/30">
                          <path d="M9 18V5l12-2v13" />
                          <circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
                        </svg>
                      </span>
                    )}
                  </span>

                  {/* Track info */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1 mb-0.5">
                      {(t.is_seed || t.is_artist_seed) ? (
                        <span className="text-[9px] leading-none flex-shrink-0" title="Seed">🌱</span>
                      ) : t.is_re_seed ? (
                        <span className="text-[9px] leading-none flex-shrink-0" title="Re-seed">🌿</span>
                      ) : t.super_liked ? (
                        <span className="text-[9px] leading-none text-amber-400 flex-shrink-0" title="Super liked">⭐</span>
                      ) : null}
                      <p className={`text-xs truncate ${
                        isPlaying
                          ? "text-accent font-medium"
                          : t.vote_status === "rejected"
                            ? "line-through text-red-400/40"
                            : t.vote_status === "skipped"
                              ? "text-amber-400/40"
                              : t.vote_status === "listened"
                                ? "text-foreground/40"
                                : !t.storage_path
                                  ? "line-through text-foreground/30"
                                  : (t.is_seed || t.is_artist_seed)
                                    ? "text-green-400/90 font-medium"
                                    : t.is_re_seed
                                      ? "text-emerald-400/80 font-medium"
                                      : t.super_liked
                                        ? "text-amber-300/90 font-medium"
                                        : t.vote_status === "approved"
                                          ? "text-green-400/80"
                                          : "text-foreground/85"
                      }`}>
                        {t.title}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <p className={`text-[10px] truncate ${
                        t.vote_status === "rejected" ? "line-through text-muted/30"
                          : !t.storage_path ? "line-through text-muted/30"
                          : "text-muted"
                      }`}>{t.artist}</p>
                      {t._match_type === "full" && t.storage_path && (
                        <span className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-green-400/70" title="Exact seed match" />
                      )}
                    </div>
                  </div>

                  {/* Vote status indicator */}
                  {t.vote_status && t.vote_status !== "pending" && (
                    <span className="flex-shrink-0 text-[9px] leading-none" title={t.vote_status}>
                      {t.super_liked ? (
                        <span className="text-amber-400">&#11088;</span>
                      ) : t.vote_status === "approved" ? (
                        <span className="text-green-400">&#9989;</span>
                      ) : t.vote_status === "rejected" ? (
                        <span className="text-red-400/70">&#10060;</span>
                      ) : t.vote_status === "skipped" ? (
                        <span className="text-amber-400/60">&#9193;</span>
                      ) : t.vote_status === "listened" ? (
                        <span className="text-foreground/30">&#128066;</span>
                      ) : null}
                    </span>
                  )}

                  {/* Right: download status dot */}
                  <span className="flex-shrink-0">
                    {downloadDot(t)}
                  </span>
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
// Supports both episode-based (fetch) and direct tracks modes
export function TracklistSheet({
  episodeId,
  episodeTitle,
  listTitle,
  directTracks,
  refreshKey,
  seedId,
  open,
  onClose,
  onTrackSelect,
}: {
  episodeId?: string;
  episodeTitle?: string | null;
  listTitle?: string | null;
  directTracks?: TrackListItem[];
  refreshKey?: number;
  seedId?: string | null;
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
          <div className="w-10 h-1 rounded-full bg-foreground/25" />
        </div>
        {directTracks ? (
          <EpisodeTracklist
            directTracks={directTracks}
            listTitle={listTitle}
            onClose={onClose}
            onTrackSelect={onTrackSelect}
            variant="sheet"
          />
        ) : episodeId ? (
          <EpisodeTracklist
            episodeId={episodeId}
            episodeTitle={episodeTitle}
            listTitle={listTitle}
            refreshKey={refreshKey}
            seedId={seedId}
            onClose={onClose}
            onTrackSelect={onTrackSelect}
            variant="sheet"
          />
        ) : null}
      </div>
    </div>
  );
}
