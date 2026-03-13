"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Track } from "@/lib/types";

const SOURCES = ["all", "nts", "1001tracklists", "spotify", "bandcamp", "manual"];

function safeCoverUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") return url;
  } catch {}
  return null;
}

export default function ApprovedPage() {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [source, setSource] = useState("all");
  const [page, setPage] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const limit = 30;
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  // Debounce search input (350ms)
  useEffect(() => {
    debounceRef.current = setTimeout(() => setDebouncedSearch(search), 350);
    return () => clearTimeout(debounceRef.current);
  }, [search]);

  const fetchTracks = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        status: "approved",
        limit: String(limit),
        offset: String(page * limit),
      });
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (source !== "all") params.set("source", source);

      const res = await fetch(`/api/tracks?${params}`);
      if (!res.ok) throw new Error(`Failed to load tracks (${res.status})`);
      const data = await res.json();
      setTracks(data.tracks || []);
      setTotal(data.total || 0);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load tracks");
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, source, page]);

  useEffect(() => {
    fetchTracks();
  }, [fetchTracks]);

  // Reset page when filters change
  useEffect(() => {
    setPage(0);
  }, [debouncedSearch, source]);

  const [downloading, setDownloading] = useState<Set<string>>(new Set());

  const handleDownload = async (track: Track) => {
    if (downloading.has(track.id)) return;
    setDownloading((prev) => new Set(prev).add(track.id));
    try {
      const res = await fetch(`/api/tracks/${track.id}/download`);
      if (res.status === 202) return; // queued, not ready yet
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      const data = await res.json();
      if (data.url) {
        // Fetch as blob to force a real download instead of navigating
        const fileRes = await fetch(data.url);
        if (!fileRes.ok) throw new Error("Failed to fetch file");
        const blob = await fileRes.blob();
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = (data.filename || `${track.artist} - ${track.title}`) + ".mp3";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(blobUrl);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed");
    } finally {
      setDownloading((prev) => {
        const next = new Set(prev);
        next.delete(track.id);
        return next;
      });
    }
  };

  const formatDate = (d: string | null) => {
    if (!d) return "—";
    return new Date(d).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  };

  const sourceLabel = (s: string) => {
    const labels: Record<string, string> = {
      nts: "NTS",
      "1001tracklists": "1001TL",
      spotify: "Spotify",
      bandcamp: "Bandcamp",
      manual: "Manual",
    };
    return labels[s] || s;
  };

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="px-4 md:px-6 pt-4 md:pt-8 max-w-4xl mx-auto">
      <h1 className="text-xl font-semibold mb-6">
        Approved
        {total > 0 && (
          <span className="text-muted font-normal text-base ml-2">
            {total}
          </span>
        )}
      </h1>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <input
          type="text"
          placeholder="Search artist or title..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 px-4 py-2.5 bg-surface-1 border border-surface-3 rounded-lg text-sm text-white placeholder:text-muted focus:outline-none focus:border-accent/50 transition-colors"
        />
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {SOURCES.map((s) => (
            <button
              key={s}
              onClick={() => setSource(s)}
              className={`px-3 py-2 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                source === s
                  ? "bg-accent/15 text-accent"
                  : "bg-surface-2 text-muted hover:text-white"
              }`}
            >
              {s === "all" ? "All" : sourceLabel(s)}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <div className="text-center py-20">
          <p className="text-sm text-red-400 mb-4">{error}</p>
          <button
            onClick={() => { setError(null); fetchTracks(); }}
            className="px-4 py-2 text-sm bg-surface-2 hover:bg-surface-3 rounded-lg text-muted hover:text-white transition-colors"
          >
            Retry
          </button>
        </div>
      ) : loading ? (
        <div className="flex justify-center py-20">
          <div className="w-6 h-6 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
        </div>
      ) : tracks.length === 0 ? (
        <div className="text-center py-20 text-muted text-sm">
          {search || source !== "all"
            ? "No tracks match your filters"
            : "No approved tracks yet. Start swiping!"}
        </div>
      ) : (
        <>
          {/* Desktop: table */}
          <div className="hidden md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted text-xs border-b border-surface-2">
                  <th className="pb-3 font-medium">Artist</th>
                  <th className="pb-3 font-medium">Title</th>
                  <th className="pb-3 font-medium">Source</th>
                  <th className="pb-3 font-medium">Date</th>
                  <th className="pb-3 font-medium w-10"></th>
                </tr>
              </thead>
              <tbody>
                {tracks.map((track) => (
                  <tr
                    key={track.id}
                    className="border-b border-surface-1 hover:bg-surface-1/50 transition-colors"
                  >
                    <td className="py-3 pr-4 text-white font-medium">
                      {track.artist}
                    </td>
                    <td className="py-3 pr-4 text-white/80">{track.title}</td>
                    <td className="py-3 pr-4">
                      <span className="px-2 py-0.5 bg-surface-2 rounded text-xs text-muted">
                        {sourceLabel(track.source)}
                      </span>
                    </td>
                    <td className="py-3 pr-4 text-muted text-xs font-mono">
                      {formatDate(track.voted_at)}
                    </td>
                    <td className="py-3">
                      <div className="flex items-center gap-1">
                        {track.spotify_url && (
                          <a
                            href={track.spotify_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="p-1.5 hover:bg-surface-2 rounded transition-colors text-green-400/60 hover:text-green-400"
                            title="Open in Spotify"
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg>
                          </a>
                        )}
                        {track.youtube_url && (
                          <a
                            href={track.youtube_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="p-1.5 hover:bg-surface-2 rounded transition-colors text-red-400/60 hover:text-red-400"
                            title="Listen on YouTube"
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>
                          </a>
                        )}
                        <button
                          onClick={() => handleDownload(track)}
                          className="p-1.5 hover:bg-surface-2 rounded transition-colors text-muted hover:text-accent"
                          title={track.storage_path ? "Download MP3" : "Not downloaded yet"}
                          disabled={downloading.has(track.id)}
                        >
                          {downloading.has(track.id) ? "..." : track.storage_path ? "↓" : "⏳"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile: cards */}
          <div className="md:hidden space-y-2">
            {tracks.map((track) => (
              <div
                key={track.id}
                className="bg-surface-1 rounded-xl p-4 flex items-center gap-3"
              >
                {/* Mini cover */}
                <div
                  className="w-12 h-12 rounded-lg flex-shrink-0"
                  style={
                    safeCoverUrl(track.cover_art_url)
                      ? {
                          backgroundImage: `url(${safeCoverUrl(track.cover_art_url)})`,
                          backgroundSize: "cover",
                          backgroundPosition: "center",
                        }
                      : {
                          background: `linear-gradient(135deg, hsl(${
                            (track.artist.length * 37) % 360
                          }, 40%, 20%), hsl(${
                            (track.title.length * 53) % 360
                          }, 50%, 12%))`,
                        }
                  }
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-white truncate">
                    {track.artist}
                  </p>
                  <p className="text-xs text-white/60 truncate">{track.title}</p>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-[10px] text-muted">
                      {sourceLabel(track.source)}
                    </span>
                    <span className="text-[10px] text-muted font-mono">
                      {formatDate(track.voted_at)}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  {track.spotify_url && (
                    <a
                      href={track.spotify_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="p-1.5 text-green-400/60 hover:text-green-400"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg>
                    </a>
                  )}
                  {track.youtube_url && (
                    <a
                      href={track.youtube_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="p-1.5 text-red-400/60 hover:text-red-400"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>
                    </a>
                  )}
                  <button
                    onClick={() => handleDownload(track)}
                    className="p-1.5 text-muted hover:text-accent"
                    disabled={downloading.has(track.id)}
                  >
                    {downloading.has(track.id) ? "..." : track.storage_path ? "↓" : "⏳"}
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-4 mt-8 mb-4">
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                className="px-3 py-1.5 text-sm bg-surface-2 rounded-lg disabled:opacity-30 hover:bg-surface-3 transition-colors"
              >
                ← Prev
              </button>
              <span className="text-xs text-muted font-mono">
                {page + 1} / {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
                className="px-3 py-1.5 text-sm bg-surface-2 rounded-lg disabled:opacity-30 hover:bg-surface-3 transition-colors"
              >
                Next →
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
