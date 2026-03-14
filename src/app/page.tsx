"use client";

import { useState, useEffect, useCallback, useRef, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Track } from "@/lib/types";
import { TrackCard } from "@/components/TrackCard";
import { StackBrowser } from "@/components/StackBrowser";
import { EpisodeTracklist, TracklistSheet } from "@/components/EpisodeTracklist";
import { useGlobalPlayer } from "@/components/GlobalPlayerProvider";

export default function StackPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center min-h-[80vh]">
          <div className="w-8 h-8 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
        </div>
      }
    >
      <StackPageContent />
    </Suspense>
  );
}

function StackPageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const globalPlayer = useGlobalPlayer();

  // URL-driven state
  const episodeId = searchParams.get("episode_id");
  const episodeTitle = searchParams.get("episode_title");
  const browsing = searchParams.get("view") === "stacks";
  const fromEpisodes = searchParams.get("from") === "episodes";

  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [skippingEpisode, setSkippingEpisode] = useState(false);
  const [tracklistOpen, setTracklistOpen] = useState(false);
  const [voteCount, setVoteCount] = useState(0);

  // Track which episode was last selected, so StackBrowser can scroll to it
  const lastEpisodeIdRef = useRef<string | null>(episodeId);

  const setBrowsing = useCallback((val: boolean) => {
    if (val) {
      const params = new URLSearchParams(window.location.search);
      params.set("view", "stacks");
      router.push(`/?${params.toString()}`);
    } else {
      // Just go back if we can, otherwise go home
      router.back();
    }
  }, [router]);

  const buildUrl = useCallback((extra?: string) => {
    let url = `/api/tracks?status=pending&limit=20`;
    if (episodeId) url += `&episode_id=${encodeURIComponent(episodeId)}`;
    if (extra) url += extra;
    return url;
  }, [episodeId]);

  const fetchTracks = useCallback(async () => {
    try {
      const res = await fetch(buildUrl());
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
  }, [buildUrl]);

  useEffect(() => {
    if (!browsing) fetchTracks();
  }, [fetchTracks, browsing]);

  const handleVote = async (id: string, status: "approved" | "rejected", advance: boolean = true) => {
    try {
      const res = await fetch(`/api/tracks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error(`Vote failed (${res.status})`);

      setVoteCount((c) => c + 1);

      if (!advance) return;

      setTracks((prev) => {
        const remaining = prev.filter((t) => t.id !== id);
        if (remaining.length <= 3) {
          const votedId = id;
          const existingIds = new Set(remaining.map((t) => t.id));
          fetch(buildUrl())
            .then((r) => r.ok ? r.json() : null)
            .then((data) => {
              if (!data) return;
              const newTracks = (data.tracks || []).filter(
                (t: Track) => t.id !== votedId && !existingIds.has(t.id)
              );
              if (newTracks.length > 0) {
                setTracks((curr) => {
                  const currIds = new Set(curr.map((t: Track) => t.id));
                  const fresh = newTracks.filter((t: Track) => !currIds.has(t.id));
                  return [...curr, ...fresh];
                });
              }
              setTotal(data.total || 0);
            });
        }
        return remaining;
      });
      setTotal((prev) => prev - 1);
    } catch (err) {
      console.error("Vote error:", err);
      setError("Failed to vote. Please try again.");
    }
  };

  const currentEpisodeId = episodeId || (tracks.length > 0 ? tracks[0].episode_id : null);
  const currentEpisodeTitle = episodeTitle || (tracks.length > 0 ? tracks[0].episode?.title : null);

  const handleSkipEpisode = async () => {
    if (!currentEpisodeId || skippingEpisode) return;
    setSkippingEpisode(true);
    try {
      const res = await fetch(`/api/episodes/${currentEpisodeId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skipped: true }),
      });
      if (!res.ok) throw new Error("Failed to skip episode");

      if (episodeId) {
        if (fromEpisodes) {
          router.push("/episodes");
        } else {
          router.push("/?view=stacks");
        }
      } else {
        setTracks((prev) => prev.filter((t) => t.episode_id !== currentEpisodeId));
        fetchTracks();
        setSkippingEpisode(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to skip episode");
      setSkippingEpisode(false);
    }
  };

  const handleSelectStack = (stackEpisodeId: string | null, stackEpisodeTitle: string | null) => {
    if (stackEpisodeId) {
      lastEpisodeIdRef.current = stackEpisodeId;
      const params = new URLSearchParams();
      params.set("episode_id", stackEpisodeId);
      if (stackEpisodeTitle) params.set("episode_title", stackEpisodeTitle);
      router.push(`/?${params.toString()}`);
    } else {
      router.push("/");
    }
  };

  const handleGoToStacks = useCallback(() => {
    const params = new URLSearchParams();
    params.set("view", "stacks");
    if (lastEpisodeIdRef.current) {
      params.set("scroll_to", lastEpisodeIdRef.current);
    }
    router.push(`/?${params.toString()}`);
  }, [router]);

  const handleGoBack = useCallback(() => {
    if (fromEpisodes) {
      router.push("/episodes");
    } else {
      handleGoToStacks();
    }
  }, [fromEpisodes, router, handleGoToStacks]);

  // Auto-play next track when top card changes
  const currentTopTrackId = tracks.length > 0 ? tracks[0].id : null;
  useEffect(() => {
    if (!currentTopTrackId || browsing) return;
    const t = tracks.find((t) => t.id === currentTopTrackId);
    if (!t) return;
    const hasPlayable = !!(t.audio_url || t.preview_url || t.spotify_url);
    if (!hasPlayable) return;
    if (globalPlayer.currentTrack?.id === currentTopTrackId) return;
    globalPlayer.play({
      id: t.id,
      artist: t.artist,
      title: t.title,
      coverArtUrl: t.cover_art_url,
      spotifyUrl: t.spotify_url,
      audioUrl: t.audio_url || t.preview_url || null,
      episodeId: t.episode_id,
      episodeTitle: t.episode?.title,
      youtubeUrl: t.youtube_url,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTopTrackId, browsing]);

  // Sync tracks order when a track is selected from the tracklist
  useEffect(() => {
    if (!globalPlayer.currentTrack) return;
    setTracks((prev) => {
      const idx = prev.findIndex((t) => t.id === globalPlayer.currentTrack!.id);
      if (idx <= 0) return prev;
      const reordered = [...prev];
      const [selected] = reordered.splice(idx, 1);
      reordered.unshift(selected);
      return reordered;
    });
  }, [globalPlayer.currentTrack?.id]);

  // Auto-advance on song end — drop the finished track instead of rotating
  // If the track was voted on (kept/skipped), it won't reappear in refetch.
  // If unvoted, it stays pending in DB and will return on next refetch.
  const lastEndedCount = useRef(globalPlayer.trackEndedCount);
  useEffect(() => {
    if (globalPlayer.trackEndedCount === lastEndedCount.current) return;
    lastEndedCount.current = globalPlayer.trackEndedCount;
    if (browsing || tracks.length < 2) return;
    const currentId = tracks[0].id;
    if (globalPlayer.currentTrack?.id !== currentId) return;
    setTracks((prev) => {
      if (prev.length < 2) return prev;
      const remaining = prev.slice(1);
      // Refetch if running low
      if (remaining.length <= 3) {
        const existingIds = new Set(remaining.map((t) => t.id));
        fetch(buildUrl())
          .then((r) => r.ok ? r.json() : null)
          .then((data) => {
            if (!data) return;
            const newTracks = (data.tracks || []).filter(
              (t: Track) => !existingIds.has(t.id)
            );
            if (newTracks.length > 0) {
              setTracks((curr) => {
                const currIds = new Set(curr.map((t: Track) => t.id));
                const fresh = newTracks.filter((t: Track) => !currIds.has(t.id));
                return [...curr, ...fresh];
              });
            }
            setTotal(data.total || 0);
          });
      }
      return remaining;
    });
  }, [globalPlayer.trackEndedCount, browsing, tracks, globalPlayer.currentTrack?.id, buildUrl]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (tracklistOpen) {
          setTracklistOpen(false);
        } else {
          handleGoToStacks();
        }
        return;
      }
      if (browsing || tracks.length === 0) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === " ") {
        e.preventDefault();
        globalPlayer.togglePlayPause();
      } else if (e.key === "ArrowLeft" || e.key === "j") {
        handleVote(tracks[0].id, "rejected");
      } else if (e.key === "ArrowRight" || e.key === "k") {
        handleVote(tracks[0].id, "approved");
      } else if (e.key === "l" || e.key === "t") {
        setTracklistOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks, browsing, tracklistOpen, globalPlayer]);

  // ── Browse mode ──
  if (browsing) {
    return (
      <StackBrowser
        onSelectStack={handleSelectStack}
        onClose={() => router.back()}
        scrollToEpisodeId={searchParams.get("scroll_to")}
      />
    );
  }

  // ── Loading ──
  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[80vh]">
        <div className="w-8 h-8 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
      </div>
    );
  }

  // ── Error ──
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[80vh] px-6 text-center">
        <p className="text-sm text-red-400 mb-4">{error}</p>
        <button
          onClick={() => { setError(null); fetchTracks(); }}
          className="px-5 py-2 text-sm bg-surface-2 hover:bg-surface-3 rounded-lg text-muted hover:text-white transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  // ── Empty ──
  if (tracks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[80vh] px-6 text-center">
        {episodeId ? (
          <>
            <h2 className="text-xl font-medium text-white/80 mb-2">All done!</h2>
            <p className="text-sm text-muted max-w-xs">
              No pending tracks left{episodeTitle ? ` in "${episodeTitle}"` : " in this episode"}.
            </p>
            <div className="flex gap-3 mt-6">
              <button
                onClick={handleGoToStacks}
                className="px-5 py-2 text-sm bg-accent/20 hover:bg-accent/30 text-accent rounded-lg transition-colors"
              >
                Browse Stacks
              </button>
              {fromEpisodes && (
                <a
                  href="/episodes"
                  className="px-5 py-2 text-sm bg-surface-2 hover:bg-surface-3 rounded-lg text-muted hover:text-white transition-colors"
                >
                  Back to Episodes
                </a>
              )}
            </div>
          </>
        ) : (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="https://theaggie.org/wp-content/uploads/2019/10/kdvs_fe_JUSTIN_HAN-1536x864.jpg"
              alt=""
              className="w-64 h-40 object-cover rounded-xl mb-6 opacity-60 grayscale hover:grayscale-0 hover:opacity-100 transition-all duration-500"
            />
            <h2 className="text-xl font-medium text-white/80 mb-2">
              Pico&apos;s digging...
            </h2>
            <p className="text-sm text-muted max-w-xs">
              No tracks waiting right now. New discoveries will appear here when the agent finds something.
            </p>
            <button
              onClick={fetchTracks}
              className="mt-6 px-5 py-2 text-sm bg-surface-2 hover:bg-surface-3 rounded-lg text-muted hover:text-white transition-colors"
            >
              Refresh
            </button>
          </>
        )}
      </div>
    );
  }

  // ── Main stack view ──
  return (
    <div className="px-4 pt-2 pb-0 h-[calc(100dvh-3.5rem-env(safe-area-inset-bottom,0px))] flex flex-col overflow-hidden md:h-[calc(100dvh-120px)] md:pb-4">
      {/* Top bar — clean, readable */}
      <div className="flex items-center justify-between mb-3 md:mb-2 md:max-w-6xl md:mx-auto md:w-full md:flex-shrink-0">
        {/* Left: back to stacks */}
        <button
          onClick={handleGoBack}
          className="flex items-center gap-2 px-3 py-2 rounded-xl bg-surface-1 hover:bg-surface-2 border border-surface-2/50 hover:border-surface-3 transition-all group text-muted hover:text-white"
          title={fromEpisodes ? "Back to episodes" : "All stacks"}
        >
          {fromEpisodes ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="group-hover:text-accent transition-colors">
              <rect x="3" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" />
              <rect x="14" y="14" width="7" height="7" rx="1" />
            </svg>
          )}
          <span className="text-xs hidden md:inline">
            {fromEpisodes ? "Episodes" : "All stacks"}
          </span>
        </button>

        {/* Center: pending count */}
        <span className="text-[11px] font-mono text-muted/50">{total} pending</span>

        {/* Right: episode tracklist button (mobile only — desktop always shows it) */}
        {currentEpisodeId && (
          <button
            onClick={() => setTracklistOpen(!tracklistOpen)}
            className="md:hidden flex items-center gap-2 px-3 py-2 rounded-xl bg-surface-1 hover:bg-surface-2 border border-surface-2/50 hover:border-surface-3 transition-all text-muted hover:text-white"
            title="Show episode tracklist"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="8" y1="6" x2="21" y2="6" />
              <line x1="8" y1="12" x2="21" y2="12" />
              <line x1="8" y1="18" x2="21" y2="18" />
              <line x1="3" y1="6" x2="3.01" y2="6" />
              <line x1="3" y1="12" x2="3.01" y2="12" />
              <line x1="3" y1="18" x2="3.01" y2="18" />
            </svg>
            <span className="text-xs truncate max-w-[120px]">
              {currentEpisodeTitle || "Tracklist"}
            </span>
          </button>
        )}
        {!currentEpisodeId && <div className="md:hidden" />}
      </div>

      {/* Desktop: tracklist always visible on left, card on right */}
      <div className="flex-1 min-h-0 flex flex-col md:flex-row md:gap-6 md:max-w-6xl md:mx-auto md:w-full">
        {/* Desktop tracklist sidebar — always visible */}
        {currentEpisodeId && (
          <div className="hidden md:flex md:w-80 md:flex-shrink-0 md:self-stretch">
            <EpisodeTracklist
              episodeId={currentEpisodeId}
              episodeTitle={currentEpisodeTitle}
              refreshKey={voteCount}
            />
          </div>
        )}

        {/* Track card — fills remaining space on mobile, centered on desktop */}
        <div className="flex-1 min-h-0 md:flex md:items-center md:justify-center">
          <TrackCard
            key={tracks[0].id}
            track={tracks[0]}
            onVote={handleVote}
            onSkipEpisode={currentEpisodeId ? handleSkipEpisode : undefined}
            skippingEpisode={skippingEpisode}
          />
        </div>
      </div>

      {/* Mobile tracklist sheet */}
      {currentEpisodeId && (
        <TracklistSheet
          episodeId={currentEpisodeId}
          episodeTitle={currentEpisodeTitle}
          refreshKey={voteCount}
          open={tracklistOpen}
          onClose={() => setTracklistOpen(false)}
        />
      )}

      {/* Keyboard hint (desktop only) */}
      <div className="hidden md:flex justify-center gap-6 py-3 text-xs text-muted md:flex-shrink-0">
        <span>← / j skip</span>
        <span>→ / k keep</span>
        <span>space play/pause</span>
        <span>esc stacks</span>
      </div>
    </div>
  );
}
