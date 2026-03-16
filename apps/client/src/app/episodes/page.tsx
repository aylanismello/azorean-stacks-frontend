"use client";

import { useState, useEffect, useCallback } from "react";
import { Episode, EpisodeTrack } from "@/lib/types";
import { openYouTube } from "@/lib/youtube";

type SourceTab = "all" | "nts" | "lotradio";

export default function EpisodesPage() {
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [showSkipped, setShowSkipped] = useState(false);
  const [sourceTab, setSourceTab] = useState<SourceTab>("all");
  const [sourceCounts, setSourceCounts] = useState<{ all: number; nts: number; lotradio: number }>({ all: 0, nts: 0, lotradio: 0 });
  const limit = 30;

  useEffect(() => {
    const skippedParam = showSkipped ? "&show_skipped=true" : "";
    Promise.all([
      fetch(`/api/episodes?limit=1&offset=0${skippedParam}`).then((r) => r.json()),
      fetch(`/api/episodes?limit=1&offset=0&source=nts${skippedParam}`).then((r) => r.json()),
      fetch(`/api/episodes?limit=1&offset=0&source=lotradio${skippedParam}`).then((r) => r.json()),
    ]).then(([allData, ntsData, lotData]) => {
      setSourceCounts({ all: allData.total || 0, nts: ntsData.total || 0, lotradio: lotData.total || 0 });
    });
  }, [showSkipped]);

  const fetchEpisodes = useCallback(async () => {
    try {
      const sourceParam = sourceTab !== "all" ? `&source=${sourceTab}` : "";
      const res = await fetch(`/api/episodes?limit=${limit}&offset=${offset}${showSkipped ? "&show_skipped=true" : ""}${sourceParam}`);
      if (!res.ok) throw new Error(`Failed to load episodes (${res.status})`);
      const data = await res.json();
      const sorted = (data.episodes || []).sort((a: Episode, b: Episode) => {
        const aApproved = a.track_stats?.approved || 0;
        const bApproved = b.track_stats?.approved || 0;
        if (bApproved !== aApproved) return bApproved - aApproved;
        const dateA = a.aired_date ? new Date(a.aired_date).getTime() : 0;
        const dateB = b.aired_date ? new Date(b.aired_date).getTime() : 0;
        return dateB - dateA;
      });
      setEpisodes(sorted);
      setTotal(data.total || 0);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load episodes");
    } finally {
      setLoading(false);
    }
  }, [offset, showSkipped, sourceTab]);

  useEffect(() => {
    fetchEpisodes();
  }, [fetchEpisodes]);

  const hasMore = offset + limit < total;

  return (
    <div className="px-4 md:px-6 pt-4 md:pt-8 max-w-2xl md:max-w-3xl mx-auto pb-24">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-xl font-semibold">Episodes</h1>
        <button
          onClick={() => { setShowSkipped(!showSkipped); setOffset(0); }}
          className={`text-[11px] px-2.5 py-1 rounded-lg transition-colors ${
            showSkipped ? "bg-surface-2 text-foreground/70" : "text-muted/50 hover:text-muted"
          }`}
        >
          {showSkipped ? "Hide skipped" : "Show skipped"}
        </button>
      </div>
      <p className="text-sm text-muted mb-4">
        {total} episode{total !== 1 ? "s" : ""} crawled
      </p>

      {/* Source tabs */}
      <div className="flex gap-1.5 mb-6">
        {(["all", "nts", "lotradio"] as const).map((tab) => {
          const label = tab === "all" ? "All" : tab === "nts" ? "NTS" : "The Lot Radio";
          const count = sourceCounts[tab];
          return (
            <button
              key={tab}
              onClick={() => { setSourceTab(tab); setOffset(0); }}
              className={`text-[12px] px-3 py-1.5 rounded-full transition-colors ${
                sourceTab === tab
                  ? "bg-surface-2 text-foreground"
                  : "text-muted/60 hover:text-muted hover:bg-surface-1"
              }`}
            >
              {label}
              {count > 0 && (
                <span className={`ml-1.5 text-[10px] ${sourceTab === tab ? "opacity-50" : "opacity-40"}`}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-400/10 border border-red-400/20 rounded-lg text-sm text-red-400">
          {error}
          <button onClick={() => setError(null)} className="ml-2 text-red-400/60 hover:text-red-400">
            ✕
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="w-6 h-6 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
        </div>
      ) : episodes.length === 0 ? (
        <div className="text-center py-12 text-muted text-sm">
          No episodes found. Run the pipeline to discover some.
        </div>
      ) : (
        <div className="space-y-2">
          {episodes.map((ep) => (
            <EpisodeCard
              key={ep.id}
              episode={ep}
              onUnskip={ep.skipped ? async () => {
                await fetch(`/api/episodes/${ep.id}`, {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ skipped: false }),
                });
                fetchEpisodes();
              } : undefined}
            />
          ))}
        </div>
      )}

      {/* Pagination */}
      {(offset > 0 || hasMore) && (
        <div className="flex justify-between mt-6">
          <button
            onClick={() => setOffset(Math.max(0, offset - limit))}
            disabled={offset === 0}
            className="px-4 py-2 text-sm rounded-lg bg-surface-1 text-muted hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Previous
          </button>
          <button
            onClick={() => setOffset(offset + limit)}
            disabled={!hasMore}
            className="px-4 py-2 text-sm rounded-lg bg-surface-1 text-muted hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}

function EpisodeCard({ episode, onUnskip }: { episode: Episode; onUnskip?: () => void }) {
  const { track_stats } = episode;
  const total = track_stats.total || 0;
  const [expanded, setExpanded] = useState(false);
  const [tracks, setTracks] = useState<EpisodeTrack[]>([]);
  const [loadingTracks, setLoadingTracks] = useState(false);

  const handleExpand = async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (tracks.length > 0) return;
    setLoadingTracks(true);
    try {
      const res = await fetch(`/api/episodes/${episode.id}/tracks`);
      if (res.ok) setTracks(await res.json());
    } finally {
      setLoadingTracks(false);
    }
  };

  const statusColor = (s: string) => {
    if (s === "approved") return "text-green-400";
    if (s === "rejected") return "text-red-400";
    if (s === "skipped") return "text-amber-400";
    return "text-muted";
  };

  const statusDot = (s: string) => {
    if (s === "approved") return "bg-green-500";
    if (s === "rejected") return "bg-red-500";
    if (s === "skipped") return "bg-amber-400";
    return "bg-surface-4";
  };

  return (
    <div className={`rounded-xl overflow-hidden ${episode.skipped ? "bg-surface-1/50 opacity-60" : "bg-surface-1"}`}>
      <button
        onClick={handleExpand}
        className="w-full text-left p-4 hover:bg-surface-2/50 transition-colors"
      >
        {/* Title + source + date */}
        <div className="flex items-start justify-between gap-2 mb-2">
          <div className="min-w-0">
            <span className="text-sm font-medium text-foreground truncate block">
              {episode.title || episode.url}
            </span>
            <p className="text-[11px] text-muted mt-0.5">
              {episode.aired_date || new Date(episode.crawled_at).toLocaleDateString()}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {episode.skipped && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-400/10 text-red-400/70">
                skipped
              </span>
            )}
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-surface-2 text-muted uppercase tracking-wider">
              {episode.source}
            </span>
            <span className="text-muted text-xs">{expanded ? "▾" : "▸"}</span>
          </div>
        </div>

        {/* Seed pills — show artist + title */}
        {episode.seeds.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-3">
            {episode.seeds.map((s, i) => (
              <span
                key={i}
                className="text-[10px] px-2 py-0.5 rounded-full bg-accent/10 text-accent"
                title={`Seeded by: ${s.artist} - ${s.title}`}
              >
                {s.artist} — {s.title}
              </span>
            ))}
          </div>
        )}

        {/* Track status bar */}
        {total > 0 && (
          <div>
            <div className="flex h-1.5 rounded-full overflow-hidden bg-surface-3">
              {track_stats.approved > 0 && (
                <div
                  className="bg-green-500"
                  style={{ width: `${(track_stats.approved / total) * 100}%` }}
                />
              )}
              {track_stats.rejected > 0 && (
                <div
                  className="bg-red-500"
                  style={{ width: `${(track_stats.rejected / total) * 100}%` }}
                />
              )}
              {track_stats.pending > 0 && (
                <div
                  className="bg-surface-4"
                  style={{ width: `${(track_stats.pending / total) * 100}%` }}
                />
              )}
            </div>
            <div className="flex gap-3 mt-1.5 text-[10px] text-muted">
              <span>{total} tracks</span>
              {track_stats.approved > 0 && <span className="text-green-500">{track_stats.approved} approved</span>}
              {track_stats.rejected > 0 && <span className="text-red-500">{track_stats.rejected} rejected</span>}
              {track_stats.pending > 0 && <span>{track_stats.pending} pending</span>}
            </div>
          </div>
        )}

        {total === 0 && (
          <p className="text-[11px] text-muted/50">No tracks extracted</p>
        )}
      </button>

      {/* Expanded track list */}
      {expanded && (
        <div className="border-t border-surface-3 px-4 py-3">
          {/* Actions row */}
          <div className="flex items-center gap-2 flex-wrap mb-3">
            <a
              href={episode.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] px-3 py-1.5 rounded-full bg-surface-2 text-accent hover:bg-surface-3 transition-colors"
            >
              Open on {episode.source === "nts" ? "NTS" : episode.source} ↗
            </a>
            {track_stats.pending > 0 && (
              <a
                href={`/?episode_id=${episode.id}&episode_title=${encodeURIComponent(episode.title || episode.url)}&from=episodes`}
                className="text-[11px] px-3 py-1.5 rounded-full bg-accent/15 text-accent hover:bg-accent/25 transition-colors font-medium active:scale-95"
              >
                Swipe {track_stats.pending} pending →
              </a>
            )}
            {episode.skipped && onUnskip && (
              <button
                onClick={onUnskip}
                className="text-[11px] px-3 py-1.5 rounded-full bg-surface-2 text-muted hover:text-foreground transition-colors active:scale-95"
              >
                Restore episode
              </button>
            )}
          </div>

          {loadingTracks ? (
            <div className="flex justify-center py-4">
              <div className="w-4 h-4 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
            </div>
          ) : tracks.length === 0 ? (
            <p className="text-[11px] text-muted/50 py-2">No tracks linked to this episode</p>
          ) : (
            <div className="space-y-1">
              {tracks.map((t) => (
                <TrackRow key={t.id} track={t} statusDot={statusDot} statusColor={statusColor} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TrackRow({
  track: t,
  statusDot,
  statusColor,
  onTrackUpdate,
}: {
  track: EpisodeTrack;
  statusDot: (s: string) => string;
  statusColor: (s: string) => string;
  onTrackUpdate?: (updated: EpisodeTrack) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [localTrack, setLocalTrack] = useState(t);
  const [seeded, setSeeded] = useState(false);
  const [seeding, setSeeding] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(`${t.artist} - ${t.title}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleFetchAudio = async () => {
    if (fetching) return;
    setFetching(true);
    try {
      const res = await fetch(`/api/tracks/${localTrack.id}/download`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        const updated = { ...localTrack, dl_failed_at: new Date().toISOString(), dl_attempts: (localTrack.dl_attempts || 0) + 1 };
        setLocalTrack(updated);
        onTrackUpdate?.(updated);
      } else {
        const updated = { ...localTrack, storage_path: data.storage_path || "fetched", dl_failed_at: null, dl_attempts: 0 };
        setLocalTrack(updated);
        onTrackUpdate?.(updated);
      }
    } catch {} finally {
      setFetching(false);
    }
  };

  const handleToggleSeed = async () => {
    if (seeding) return;
    setSeeding(true);
    try {
      const res = await fetch("/api/seeds/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ track_id: t.id, artist: t.artist, title: t.title }),
      });
      if (res.ok) {
        const { action } = await res.json();
        setSeeded(action === "created");
      }
    } catch {} finally {
      setSeeding(false);
    }
  };

  const showFetchButton = !localTrack.storage_path && localTrack.youtube_url;
  const fetchFailed = !!localTrack.dl_failed_at;

  return (
    <div className="flex items-center gap-2 py-1.5 text-sm">
      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${statusDot(localTrack.status)}`} />
      <span className={`flex-1 min-w-0 truncate ${statusColor(localTrack.status)}`}>
        {localTrack.artist} — {localTrack.title}
      </span>
      <div className="flex gap-1.5 flex-shrink-0 items-center">
        {showFetchButton && (
          <button
            onClick={handleFetchAudio}
            disabled={fetching || fetchFailed}
            className={`p-0.5 rounded transition-all ${
              fetchFailed
                ? "text-muted/20 cursor-not-allowed"
                : fetching
                ? "text-muted/50 animate-pulse"
                : "text-muted/50 hover:text-accent hover:bg-surface-3"
            }`}
            title={fetchFailed ? "Audio not found" : "Fetch audio"}
          >
            {fetching ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="animate-spin"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
            )}
          </button>
        )}
        <button
          onClick={handleCopy}
          className="p-0.5 rounded hover:bg-surface-3 active:scale-90 transition-all"
          title="Copy artist - title"
        >
          {copied ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-muted/50 hover:text-muted">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          )}
        </button>
        <button
          onClick={handleToggleSeed}
          disabled={seeding}
          className={`text-[10px] transition-colors ${
            seeded
              ? "text-emerald-400 hover:text-emerald-300"
              : "text-muted/40 hover:text-emerald-400"
          } disabled:opacity-50`}
          title={seeded ? "Remove seed" : "Plant as seed"}
        >
          {seeding ? "·" : "SD"}
        </button>
        {t.spotify_url && (
          <a href={t.spotify_url} target="_blank" rel="noopener noreferrer" className="text-[10px] text-green-400/60 hover:text-green-400">
            SP
          </a>
        )}
        {t.youtube_url && (
          <button onClick={() => openYouTube(t.youtube_url!)} className="text-[10px] text-red-400/60 hover:text-red-400">
            YT
          </button>
        )}
      </div>
    </div>
  );
}
