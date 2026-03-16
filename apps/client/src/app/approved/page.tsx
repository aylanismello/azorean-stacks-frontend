"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { Track } from "@/lib/types";
import { openYouTube } from "@/lib/youtube";
import { useGlobalPlayer } from "@/components/GlobalPlayerProvider";
import { useSpotify } from "@/components/SpotifyProvider";

function safeCoverUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") return url;
  } catch {}
  return null;
}

type Tab = "super_liked" | "approved" | "pending" | "rejected" | "skipped";

const TAB_CONFIG: Record<Tab, { label: string; color: string; activeBg: string; emptyMsg: string }> = {
  super_liked: {
    label: "⭐ Downloads",
    color: "text-yellow-400",
    activeBg: "bg-yellow-400/10 text-yellow-400 ring-1 ring-yellow-400/20",
    emptyMsg: "No super liked tracks yet.",
  },
  approved: {
    label: "Kept",
    color: "text-green-400",
    activeBg: "bg-green-400/10 text-green-400 ring-1 ring-green-400/20",
    emptyMsg: "No kept tracks yet. Start swiping!",
  },
  pending: {
    label: "Unlistened",
    color: "text-foreground/60",
    activeBg: "bg-foreground/5 text-foreground/80 ring-1 ring-foreground/10",
    emptyMsg: "Queue is empty — all caught up.",
  },
  rejected: {
    label: "Nope",
    color: "text-red-400/70",
    activeBg: "bg-red-400/10 text-red-400 ring-1 ring-red-400/20",
    emptyMsg: "Nothing rejected yet.",
  },
  skipped: {
    label: "Skipped",
    color: "text-amber-400/70",
    activeBg: "bg-amber-400/10 text-amber-400 ring-1 ring-amber-400/20",
    emptyMsg: "Nothing skipped yet.",
  },
};

export default function TracksPage() {
  const [tab, setTab] = useState<Tab>("approved");
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [tabCounts, setTabCounts] = useState<Record<Tab, number | null>>({
    super_liked: null,
    approved: null,
    pending: null,
    rejected: null,
    skipped: null,
  });
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const limit = 30;
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  // Debounce search input (350ms)
  useEffect(() => {
    debounceRef.current = setTimeout(() => setDebouncedSearch(search), 350);
    return () => clearTimeout(debounceRef.current);
  }, [search]);

  // Fetch counts for all tabs (lightweight)
  const fetchCounts = useCallback(async () => {
    const tabs: Tab[] = ["super_liked", "approved", "pending", "rejected", "skipped"];
    const results = await Promise.all(
      tabs.map(async (t) => {
        try {
          const res = await fetch(`/api/tracks?status=${t}&limit=0&offset=0`);
          if (!res.ok) return null;
          const data = await res.json();
          return data.total ?? null;
        } catch {
          return null;
        }
      })
    );
    setTabCounts({
      super_liked: results[0],
      approved: results[1],
      pending: results[2],
      rejected: results[3],
      skipped: results[4],
    });
  }, []);

  useEffect(() => {
    fetchCounts();
  }, [fetchCounts]);

  const fetchTracks = useCallback(async () => {
    setLoading(true);
    setTracks([]);
    try {
      const params = new URLSearchParams({
        status: tab,
        limit: String(limit),
        offset: String(page * limit),
      });
      if (debouncedSearch) params.set("search", debouncedSearch);

      const res = await fetch(`/api/tracks?${params}`);
      if (!res.ok) throw new Error(`Failed to load tracks (${res.status})`);
      const data = await res.json();
      setTracks(data.tracks || []);
      setTotal(data.total || 0);
      // Update this tab's count without re-fetching all
      setTabCounts((prev) => ({ ...prev, [tab]: data.total || 0 }));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load tracks");
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, tab, page]);

  useEffect(() => {
    fetchTracks();
  }, [fetchTracks]);

  // Reset page when filters change
  useEffect(() => {
    setPage(0);
  }, [debouncedSearch, tab]);

  const globalPlayer = useGlobalPlayer();
  const router = useRouter();
  const { connected: spotifyConnected } = useSpotify();
  const [expandedTrack, setExpandedTrack] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<Set<string>>(new Set());
  const [updating, setUpdating] = useState<Set<string>>(new Set());
  const [seeding, setSeeding] = useState<Set<string>>(new Set());
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{ synced: number; playlist_url: string | null } | null>(null);

  const handleSyncToSpotify = async () => {
    setSyncing(true);
    setSyncResult(null);
    setError(null);
    try {
      const res = await fetch("/api/spotify/sync-seeds", { method: "POST" });
      const data = await res.json();
      if (data.error && !data.synced && data.synced !== 0) {
        throw new Error(data.error);
      }
      if (data.synced === 0) {
        setError(data.error || "No tracks with Spotify URLs to sync");
      } else {
        setSyncResult({ synced: data.synced, playlist_url: data.playlist_url });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to sync to Spotify");
    } finally {
      setSyncing(false);
    }
  };

  const handleToggleSeed = async (track: Track) => {
    if (seeding.has(track.id)) return;
    setSeeding((prev) => new Set(prev).add(track.id));
    try {
      const res = await fetch("/api/seeds/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ track_id: track.id, artist: track.artist, title: track.title }),
      });
      if (!res.ok) return;
      const { action } = await res.json();
      setTracks((prev) =>
        prev.map((t) =>
          t.id === track.id
            ? { ...t, seed_id: action === "created" ? "pending" : null }
            : t
        )
      );
    } catch {} finally {
      setSeeding((prev) => {
        const next = new Set(prev);
        next.delete(track.id);
        return next;
      });
    }
  };

  const handlePlay = useCallback((track: Track) => {
    if (globalPlayer.currentTrack?.id === track.id) {
      globalPlayer.togglePlayPause();
    } else {
      globalPlayer.play({
        id: track.id,
        artist: track.artist,
        title: track.title,
        coverArtUrl: safeCoverUrl(track.cover_art_url),
        spotifyUrl: track.spotify_url,
        audioUrl: track.audio_url || track.preview_url || null,
      }, "/approved");
    }
  }, [globalPlayer]);

  const handleFetchAudio = async (track: Track) => {
    if (downloading.has(track.id)) return;
    setDownloading((prev) => new Set(prev).add(track.id));
    try {
      const res = await fetch(`/api/tracks/${track.id}/download`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setTracks((prev) =>
          prev.map((t) =>
            t.id === track.id
              ? { ...t, dl_failed_at: new Date().toISOString(), dl_attempts: (t.dl_attempts || 0) + 1 }
              : t
          )
        );
        setError(data.error || "Couldn't find audio");
        return;
      }
      setTracks((prev) =>
        prev.map((t) =>
          t.id === track.id
            ? { ...t, storage_path: data.storage_path || "fetched", audio_url: data.audio_url, dl_failed_at: null, dl_attempts: 0 }
            : t
        )
      );
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

  const handleChangeStatus = async (trackId: string, newStatus: "approved" | "rejected" | "pending" | "skipped") => {
    if (updating.has(trackId)) return;
    setUpdating((prev) => new Set(prev).add(trackId));
    try {
      const res = await fetch(`/api/tracks/${trackId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) throw new Error("Failed to update");
      setTracks((prev) => prev.filter((t) => t.id !== trackId));
      setTotal((prev) => prev - 1);
      // Update counts: decrement current tab, increment target
      setTabCounts((prev) => ({
        ...prev,
        [tab]: Math.max(0, (prev[tab] ?? 1) - 1),
        [newStatus]: (prev[newStatus as Tab] ?? 0) + 1,
      }));
      // Auto-sync Spotify playlist when approved list changes
      if (spotifyConnected && (tab === "approved" || newStatus === "approved")) {
        fetch("/api/spotify/sync-seeds", { method: "POST" }).catch(() => {});
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update track");
    } finally {
      setUpdating((prev) => {
        const next = new Set(prev);
        next.delete(trackId);
        return next;
      });
    }
  };

  const formatDate = (d: string | null) => {
    if (!d) return "";
    return new Date(d).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  };

  const totalPages = Math.ceil(total / limit);

  // Determine available move-to options based on current tab
  const moveOptions = (trackId: string): { label: string; status: Tab; color: string }[] => {
    const opts: { label: string; status: Tab; color: string }[] = [];
    if (tab !== "approved" && tab !== "super_liked") opts.push({ label: "Keep", status: "approved", color: "text-green-400 hover:bg-green-400/10" });
    if (tab !== "pending") opts.push({ label: "Back to queue", status: "pending", color: "text-foreground/50 hover:bg-foreground/5" });
    if (tab !== "skipped") opts.push({ label: "Skip", status: "skipped", color: "text-amber-400/70 hover:bg-amber-400/10" });
    if (tab !== "rejected") opts.push({ label: "Nope", status: "rejected", color: "text-red-400/70 hover:bg-red-400/10" });
    return opts;
  };

  // Space to toggle play/pause
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === " ") {
        e.preventDefault();
        globalPlayer.togglePlayPause();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [globalPlayer]);

  const handleGoToStack = useCallback((track: Track) => {
    if (!track.episode_id) return;
    const params = new URLSearchParams();
    params.set("episode_id", track.episode_id);
    if (track.episode?.title) params.set("episode_title", track.episode.title);
    router.push(`/?${params.toString()}`);
  }, [router]);

  return (
    <div className="px-4 md:px-6 pt-4 md:pt-8 max-w-4xl mx-auto pb-32 md:pb-8">
      {/* Sync to Spotify + result banner */}
      <div className="flex items-center justify-between mb-4">
        <div />
        {spotifyConnected && (
          <button
            onClick={handleSyncToSpotify}
            disabled={syncing}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-[#1DB954]/15 text-[#1DB954] hover:bg-[#1DB954]/25 transition-colors disabled:opacity-50"
          >
            {syncing ? (
              <>
                <span className="w-3.5 h-3.5 border-2 border-[#1DB954]/30 border-t-[#1DB954] rounded-full animate-spin" />
                Syncing...
              </>
            ) : (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="#1DB954"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg>
                Sync to Spotify
              </>
            )}
          </button>
        )}
      </div>

      {syncResult && (
        <div className="mb-4 p-3 bg-[#1DB954]/10 border border-[#1DB954]/20 rounded-lg text-sm text-[#1DB954] flex items-center justify-between">
          <span>Synced {syncResult.synced} tracks to Spotify</span>
          <div className="flex items-center gap-2">
            {syncResult.playlist_url && (
              <a href={syncResult.playlist_url} target="_blank" rel="noopener noreferrer" className="underline hover:no-underline">Open playlist</a>
            )}
            <button onClick={() => setSyncResult(null)} className="text-[#1DB954]/60 hover:text-[#1DB954]">✕</button>
          </div>
        </div>
      )}

      {/* Tabs — always show counts */}
      <div className="flex items-center gap-2 mb-6">
        {(Object.keys(TAB_CONFIG) as Tab[]).map((t) => {
          const cfg = TAB_CONFIG[t];
          const count = tabCounts[t];
          const isActive = tab === t;
          return (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                isActive ? cfg.activeBg : "text-muted hover:text-foreground/70 hover:bg-surface-1"
              }`}
            >
              {cfg.label}
              {count !== null && count > 0 && (
                <span className={`ml-1.5 text-xs font-normal ${isActive ? "opacity-70" : "opacity-40"}`}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Search */}
      <div className="mb-5">
        <div className="relative">
          <svg
            width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none"
          >
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            placeholder="Search artist or title..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 bg-surface-1 border border-surface-2 rounded-xl text-sm text-foreground placeholder:text-muted/50 focus:outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/20 transition-all"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-foreground transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-4 p-3 bg-red-400/10 border border-red-400/20 rounded-xl text-sm text-red-400 flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => { setError(null); fetchTracks(); }} className="ml-3 px-3 py-1 text-xs bg-red-400/10 hover:bg-red-400/20 rounded-lg transition-colors flex-shrink-0">
            Retry
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-20">
          <div className="w-6 h-6 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
        </div>
      ) : tracks.length === 0 ? (
        <div className="text-center py-20 text-muted text-sm">
          {search ? "No tracks match your search" : TAB_CONFIG[tab].emptyMsg}
        </div>
      ) : (
        <>
          {/* Desktop: table */}
          <div className="hidden md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted/60 text-[11px] uppercase tracking-wider border-b border-surface-2">
                  <th className="pb-3 font-medium pl-10">Artist</th>
                  <th className="pb-3 font-medium">Title</th>
                  <th className="pb-3 font-medium">Date</th>
                  <th className="pb-3 font-medium w-28"></th>
                </tr>
              </thead>
              <tbody>
                {tracks.map((track) => {
                  const isPlaying = globalPlayer.currentTrack?.id === track.id;
                  const isExpanded = expandedTrack === track.id;
                  return (
                    <tr key={track.id} className="group">
                      <td colSpan={4} className="p-0">
                        <div
                          className={`flex items-center border-b transition-colors cursor-pointer ${
                            isPlaying
                              ? "bg-accent/5 border-accent/10"
                              : "border-surface-1 hover:bg-surface-1/50"
                          }`}
                          onClick={() => setExpandedTrack(isExpanded ? null : track.id)}
                        >
                          <div className="py-3 pr-4 pl-1 text-foreground font-medium text-sm flex-[2] flex items-center gap-2">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handlePlay(track);
                              }}
                              className={`w-7 h-7 flex-shrink-0 flex items-center justify-center rounded-full transition-all ${
                                isPlaying
                                  ? "bg-accent text-surface-0 shadow-lg shadow-accent/20"
                                  : "bg-surface-2 text-muted group-hover:text-foreground hover:bg-accent hover:text-surface-0"
                              }`}
                            >
                              {isPlaying && globalPlayer.playing ? (
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>
                              ) : (
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                              )}
                            </button>
                            <span className="truncate">{track.artist}</span>
                          </div>
                          <div className="py-3 pr-4 text-foreground/70 text-sm flex-[2] truncate">
                            {track.episode_id ? (
                              <button
                                onClick={(e) => { e.stopPropagation(); handleGoToStack(track); }}
                                className="hover:text-accent hover:underline underline-offset-2 transition-colors truncate text-left"
                                title={track.episode?.title ? `Go to ${track.episode.title}` : "Go to stack"}
                              >
                                {track.title}
                              </button>
                            ) : track.title}
                          </div>
                          <div className="py-3 pr-4 text-muted/50 text-xs font-mono flex-1">
                            {formatDate(track.voted_at || track.created_at)}
                          </div>
                          <div className="py-3 w-28 flex justify-end pr-2">
                            <div className="flex items-center gap-1.5">
                              {track.spotify_url && (
                                <a
                                  href={track.spotify_url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  onClick={(e) => e.stopPropagation()}
                                  className="p-1 rounded hover:bg-surface-2 text-green-400/50 hover:text-green-400 transition-colors"
                                  title="Open in Spotify"
                                >
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg>
                                </a>
                              )}
                              {track.youtube_url && (
                                <button
                                  onClick={(e) => { e.stopPropagation(); openYouTube(track.youtube_url!); }}
                                  className="p-1 rounded hover:bg-surface-2 text-red-400/50 hover:text-red-400 transition-colors"
                                  title="Listen on YouTube"
                                >
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>
                                </button>
                              )}
                              {!track.storage_path && !track.audio_url && track.youtube_url && (
                                <button
                                  onClick={(e) => { e.stopPropagation(); handleFetchAudio(track); }}
                                  className={`p-1 rounded transition-colors ${
                                    track.dl_failed_at
                                      ? "text-muted/20 cursor-not-allowed"
                                      : downloading.has(track.id)
                                      ? "text-muted animate-pulse"
                                      : "text-muted/40 hover:text-accent hover:bg-surface-2"
                                  }`}
                                  title={track.dl_failed_at ? "Audio not found" : "Fetch audio"}
                                  disabled={!!track.dl_failed_at || downloading.has(track.id)}
                                >
                                  {downloading.has(track.id) ? (
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="animate-spin"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
                                  ) : (
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
                                  )}
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                        {/* Expandable actions */}
                        {isExpanded && (
                          <div className="px-3 py-2.5 border-b border-surface-2 bg-surface-1/30 flex items-center gap-2">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handlePlay(track);
                              }}
                              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-accent/15 text-accent hover:bg-accent/25 transition-colors"
                            >
                              {isPlaying && globalPlayer.playing ? "Pause" : "Play"}
                              {isPlaying && globalPlayer.source === "spotify" && " via Spotify"}
                              {isPlaying && globalPlayer.source === "audio" && " via Audio"}
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); handleToggleSeed(track); }}
                              disabled={seeding.has(track.id)}
                              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                                track.seed_id
                                  ? "bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25"
                                  : "text-muted hover:text-emerald-400 hover:bg-emerald-500/10"
                              } disabled:opacity-50`}
                              title={track.seed_id ? "Remove seed" : "Plant as seed"}
                            >
                              {seeding.has(track.id) ? "..." : track.seed_id ? "Seeded" : "Seed"}
                            </button>
                            <div className="flex-1" />
                            {moveOptions(track.id).map((opt) => (
                              <button
                                key={opt.status}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleChangeStatus(track.id, opt.status);
                                }}
                                disabled={updating.has(track.id)}
                                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${opt.color} disabled:opacity-50`}
                              >
                                {opt.label}
                              </button>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile: cards */}
          <div className="md:hidden space-y-1.5">
            {tracks.map((track) => {
              const isPlaying = globalPlayer.currentTrack?.id === track.id;
              const isExpanded = expandedTrack === track.id;
              return (
                <div
                  key={track.id}
                  className={`rounded-xl overflow-hidden transition-colors ${
                    isPlaying ? "bg-accent/5 ring-1 ring-accent/15" : "bg-surface-1"
                  }`}
                >
                  <div
                    className="p-3.5 flex items-center gap-3 cursor-pointer"
                    onClick={() => setExpandedTrack(isExpanded ? null : track.id)}
                  >
                    {/* Cover art / play button */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handlePlay(track);
                      }}
                      className="w-11 h-11 rounded-lg flex-shrink-0 flex items-center justify-center overflow-hidden"
                      style={
                        safeCoverUrl(track.cover_art_url)
                          ? {
                              backgroundImage: `url(${safeCoverUrl(track.cover_art_url)})`,
                              backgroundSize: "cover",
                              backgroundPosition: "center",
                            }
                          : {
                              background: `linear-gradient(135deg, hsl(${(track.artist.length * 37) % 360}, 40%, 20%), hsl(${(track.title.length * 53) % 360}, 50%, 12%))`,
                            }
                      }
                    >
                      <span className={`w-7 h-7 flex items-center justify-center rounded-full backdrop-blur-sm transition-all ${
                        isPlaying ? "bg-accent/90 text-surface-0" : "bg-black/40 text-foreground/80"
                      }`}>
                        {isPlaying && globalPlayer.playing ? (
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>
                        ) : (
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                        )}
                      </span>
                    </button>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{track.artist}</p>
                      <p className="text-xs text-foreground/50 truncate">{track.title}</p>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <span className="text-[10px] text-muted/40 font-mono">
                        {formatDate(track.voted_at || track.created_at)}
                      </span>
                    </div>
                  </div>
                  {/* Expandable actions */}
                  {isExpanded && (
                    <div className="px-3.5 pb-3 flex items-center gap-2 flex-wrap">
                      {track.spotify_url && (
                        <a
                          href={track.spotify_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="p-2 rounded-lg text-green-400/60 hover:text-green-400 hover:bg-green-400/10 transition-colors"
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg>
                        </a>
                      )}
                      {track.youtube_url && (
                        <button
                          onClick={(e) => { e.stopPropagation(); openYouTube(track.youtube_url!); }}
                          className="p-2 rounded-lg text-red-400/60 hover:text-red-400 hover:bg-red-400/10 transition-colors"
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>
                        </button>
                      )}
                      <button
                        onClick={(e) => { e.stopPropagation(); handleToggleSeed(track); }}
                        disabled={seeding.has(track.id)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                          track.seed_id
                            ? "bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25"
                            : "text-muted hover:text-emerald-400 hover:bg-emerald-500/10"
                        } disabled:opacity-50`}
                        title={track.seed_id ? "Remove seed" : "Plant as seed"}
                      >
                        {seeding.has(track.id) ? "..." : track.seed_id ? "Seeded" : "Seed"}
                      </button>
                      <div className="flex-1" />
                      {moveOptions(track.id).map((opt) => (
                        <button
                          key={opt.status}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleChangeStatus(track.id, opt.status);
                          }}
                          disabled={updating.has(track.id)}
                          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${opt.color} disabled:opacity-50`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-4 mt-8 mb-4">
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                className="px-4 py-2 text-sm bg-surface-1 rounded-xl disabled:opacity-30 hover:bg-surface-2 transition-colors"
              >
                ← Prev
              </button>
              <span className="text-xs text-muted/50 font-mono">
                {page + 1} / {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
                className="px-4 py-2 text-sm bg-surface-1 rounded-xl disabled:opacity-30 hover:bg-surface-2 transition-colors"
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
