"use client";

import { useState, useEffect, useCallback } from "react";
import { Episode, EpisodeTrack } from "@/lib/types";

export default function EpisodesPage() {
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const limit = 30;

  const fetchEpisodes = useCallback(async () => {
    try {
      const res = await fetch(`/api/episodes?limit=${limit}&offset=${offset}`);
      if (!res.ok) throw new Error(`Failed to load episodes (${res.status})`);
      const data = await res.json();
      setEpisodes(data.episodes || []);
      setTotal(data.total || 0);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load episodes");
    } finally {
      setLoading(false);
    }
  }, [offset]);

  useEffect(() => {
    fetchEpisodes();
  }, [fetchEpisodes]);

  const hasMore = offset + limit < total;

  return (
    <div className="px-4 md:px-6 pt-4 md:pt-8 max-w-2xl mx-auto pb-24">
      <h1 className="text-xl font-semibold mb-1">Episodes</h1>
      <p className="text-sm text-muted mb-6">
        {total} episode{total !== 1 ? "s" : ""} crawled
      </p>

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
            <EpisodeCard key={ep.id} episode={ep} />
          ))}
        </div>
      )}

      {/* Pagination */}
      {(offset > 0 || hasMore) && (
        <div className="flex justify-between mt-6">
          <button
            onClick={() => setOffset(Math.max(0, offset - limit))}
            disabled={offset === 0}
            className="px-4 py-2 text-sm rounded-lg bg-surface-1 text-muted hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Previous
          </button>
          <button
            onClick={() => setOffset(offset + limit)}
            disabled={!hasMore}
            className="px-4 py-2 text-sm rounded-lg bg-surface-1 text-muted hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}

function EpisodeCard({ episode }: { episode: Episode }) {
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
    if (s === "approved" || s === "downloaded") return "text-green-400";
    if (s === "rejected") return "text-red-400";
    return "text-muted";
  };

  const statusDot = (s: string) => {
    if (s === "approved" || s === "downloaded") return "bg-green-500";
    if (s === "rejected") return "bg-red-500";
    return "bg-surface-4";
  };

  return (
    <div className="rounded-xl bg-surface-1 overflow-hidden">
      <button
        onClick={handleExpand}
        className="w-full text-left p-4 hover:bg-surface-2/50 transition-colors"
      >
        {/* Title + source + date */}
        <div className="flex items-start justify-between gap-2 mb-2">
          <div className="min-w-0">
            <span className="text-sm font-medium text-white truncate block">
              {episode.title || episode.url}
            </span>
            <p className="text-[11px] text-muted mt-0.5">
              {episode.aired_date || new Date(episode.crawled_at).toLocaleDateString()}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
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
          <div className="flex items-center gap-3 mb-3">
            <a
              href={episode.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] text-accent hover:underline"
            >
              Open on {episode.source === "nts" ? "NTS" : episode.source} ↗
            </a>
            {track_stats.pending > 0 && (
              <a
                href={`/?episode_id=${episode.id}&episode_title=${encodeURIComponent(episode.title || episode.url)}`}
                className="text-[11px] px-3 py-1 rounded-full bg-accent/15 text-accent hover:bg-accent/25 transition-colors font-medium"
              >
                Swipe {track_stats.pending} pending →
              </a>
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
                <div
                  key={t.id}
                  className="flex items-center gap-2 py-1.5 text-sm"
                >
                  <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${statusDot(t.status)}`} />
                  <span className={`flex-1 min-w-0 truncate ${statusColor(t.status)}`}>
                    {t.artist} — {t.title}
                  </span>
                  <div className="flex gap-1.5 flex-shrink-0">
                    {t.spotify_url && (
                      <a href={t.spotify_url} target="_blank" rel="noopener noreferrer" className="text-[10px] text-green-400/60 hover:text-green-400">
                        SP
                      </a>
                    )}
                    {t.youtube_url && (
                      <a href={t.youtube_url} target="_blank" rel="noopener noreferrer" className="text-[10px] text-red-400/60 hover:text-red-400">
                        YT
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
