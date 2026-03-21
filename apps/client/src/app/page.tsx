"use client";

import { useState, useEffect, useCallback, useRef, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Track } from "@/lib/types";
import { TrackCard } from "@/components/TrackCard";
import { EpisodeTracklist, TracklistSheet } from "@/components/EpisodeTracklist";
import { useGlobalPlayer, PlayerTrack } from "@/components/GlobalPlayerProvider";
import { useSpotify } from "@/components/SpotifyProvider";

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

/** Convert an API Track to a PlayerTrack with all fields the UI needs */
function toPlayerTrack(track: Track): PlayerTrack {
  return {
    id: track.id,
    artist: track.artist,
    title: track.title,
    coverArtUrl: track.cover_art_url || track.episode?.artwork_url || null,
    spotifyUrl: track.spotify_url,
    audioUrl: track.audio_url || track.preview_url || null,
    episodeId: track.episode_id,
    episodeTitle: track.episode?.title,
    youtubeUrl: track.youtube_url,

    // Vote / status
    vote_status: (track as any).vote_status || track.status || "pending",
    super_liked: track.super_liked || false,
    status: track.status,

    // Seed indicators
    is_seed: track.is_seed,
    is_re_seed: track.is_re_seed,
    is_artist_seed: (track as any).is_artist_seed,

    // Discovery metadata
    source: track.source,
    episode_id: track.episode_id,
    episode_title: track.episode?.title || null,
    storage_path: track.storage_path,
    youtube_url: track.youtube_url,
    preview_url: track.preview_url,
    seed_id: track.seed_id,
    seed_track: track.seed_track,
    taste_score: track.taste_score,

    // Source context
    source_url: track.source_url,
    source_context: track.source_context,

    // Episode join data
    episode: track.episode,

    // Metadata bag
    metadata: track.metadata,

    // Scoring metadata
    _ranked_score: (track as any)._ranked_score,
    _score_components: (track as any)._score_components,
    _match_type: (track as any)._match_type,
    _seed_name: (track as any)._seed_name,

    // Voted timestamp
    voted_at: track.voted_at,
  };
}

/** Convert a PlayerTrack back to a Track-like object for components that still expect Track */
function toTrackLike(pt: PlayerTrack): Track {
  return {
    id: pt.id,
    artist: pt.artist,
    title: pt.title,
    cover_art_url: pt.coverArtUrl,
    spotify_url: pt.spotifyUrl,
    audio_url: pt.audioUrl,
    youtube_url: pt.youtubeUrl || pt.youtube_url || null,
    preview_url: pt.preview_url || null,
    episode_id: pt.episodeId || pt.episode_id || null,
    episode: pt.episode || null,
    source: pt.source || "",
    source_url: pt.source_url || null,
    source_context: pt.source_context || null,
    seed_track_id: null,
    download_url: null,
    storage_path: pt.storage_path || null,
    seed_track: pt.seed_track || null,
    metadata: pt.metadata || {},
    status: (pt.vote_status || pt.status || "pending") as Track["status"],
    created_at: "",
    voted_at: pt.voted_at || null,
    downloaded_at: null,
    dl_attempts: 0,
    dl_failed_at: null,
    seed_id: pt.seed_id,
    taste_score: pt.taste_score,
    super_liked: pt.super_liked,
    is_seed: pt.is_seed,
    is_re_seed: pt.is_re_seed,
    // Pass through scoring metadata
    _ranked_score: pt._ranked_score,
    _score_components: pt._score_components,
    _match_type: pt._match_type,
    _seed_name: pt._seed_name,
    // Pass through vote_status for TrackCard
    vote_status: pt.vote_status,
    is_artist_seed: pt.is_artist_seed,
  } as any;
}

/** Check if a PlayerTrack has playable audio */
function isPlayable(t: PlayerTrack): boolean {
  return !!(t.audioUrl || t.storage_path || t.preview_url);
}

function StackPageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const globalPlayer = useGlobalPlayer();
  const { connected: spotifyConnected } = useSpotify();
  // Mobile: account for top bar (3.5rem) + bottom tab bar + player (~4.5rem)
  // Desktop: override with md: classes that account for sidebar nav + player
  const mobileHeightClass = globalPlayer.currentTrack
    ? "h-[calc(100dvh-8rem-env(safe-area-inset-bottom,0px))]"
    : "h-[calc(100dvh-7rem-env(safe-area-inset-bottom,0px))]";
  const desktopPlayerFrameClass = globalPlayer.currentTrack
    ? "md:h-[calc(100dvh-148px)] md:pb-6"
    : "md:h-[calc(100dvh-100px)] md:pb-4";

  // URL-driven state
  const episodeId = searchParams.get("episode_id");
  const episodeTitle = searchParams.get("episode_title");
  const fromSeedId = searchParams.get("seed_id");
  const fromEpisodes = searchParams.get("from") === "episodes";

  // Stack source: "taste" (For You), "genre", "seed", "episode" (legacy), "ranked" (new)
  // Default to taste mode when no source/episode params are set
  const stackSource = searchParams.get("source");
  const genreFilter = searchParams.get("genre");
  const seedFilter = searchParams.get("seed_artist");
  const seedName = searchParams.get("seed_name"); // "Artist — Title" for display
  const isSeedMode = stackSource === "seed";
  const isRankedMode = stackSource === "ranked";
  const isTasteMode = stackSource === "taste" || stackSource === "genre" || isSeedMode || isRankedMode || (!stackSource && !episodeId);

  // Page-level UI state (no track state — provider owns that)
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [hideLowScored, setHideLowScored] = useState(false);

  useEffect(() => {
    const stored = sessionStorage.getItem("stacks-hide-low-scored");
    if (stored === "1") setHideLowScored(true);
  }, []);
  const [skippingEpisode, setSkippingEpisode] = useState(false);
  const [tracklistOpen, setTracklistOpen] = useState(false);
  const [voteCount, setVoteCount] = useState(0);
  const [advancingEpisode, setAdvancingEpisode] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);

  // Don't auto-play until the user has interacted (vote, skip, click track, etc.)
  const userHasInteracted = useRef(false);

  // Ref for global player's current track (avoids stale closures in fetchTracks)
  const playerCurrentTrackRef = useRef(globalPlayer.currentTrack);
  useEffect(() => { playerCurrentTrackRef.current = globalPlayer.currentTrack; }, [globalPlayer.currentTrack]);

  useEffect(() => {
    setAdvancingEpisode(false);
  }, [episodeId]);

  // Whether we're operating in "episode mode" (full episode tracks + position index)
  const [hasEpisodeTracks, setHasEpisodeTracks] = useState(!!episodeId);

  // The current track is ALWAYS from the provider — single source of truth
  const currentTrack = globalPlayer.currentTrack;

  // Position of current track in the queue (for display)
  const currentDisplayIndex = globalPlayer.currentIndex;

  const buildUrl = useCallback((_extra?: string) => {
    // Episode mode: fetch ALL tracks in episode order (not just pending)
    if (episodeId) {
      return `/api/tracks?episode_id=${encodeURIComponent(episodeId)}&limit=100`;
    }
    // Unified FYP endpoint for taste/genre/seed/ranked modes
    let url = `/api/fyp?limit=20`;
    if (hideLowScored) {
      url += `&hide_low=true`;
    }
    if (fromSeedId) {
      url += `&seed_id=${encodeURIComponent(fromSeedId)}`;
    }
    if (genreFilter) {
      url += `&genre=${encodeURIComponent(genreFilter)}`;
    }
    if (seedFilter) {
      url += `&seed_artist=${encodeURIComponent(seedFilter)}`;
    }
    return url;
  }, [episodeId, hideLowScored, fromSeedId, genreFilter, seedFilter]);

  const fetchTracks = useCallback(async () => {
    try {
      const res = await fetch(buildUrl());
      if (!res.ok) throw new Error(`Failed to load tracks (${res.status})`);
      const data = await res.json();
      const apiTracks: Track[] = data.tracks || [];
      const playerTracks = apiTracks.map(toPlayerTrack);

      setTotal(data.total || 0);
      setError(null);
      setAdvancingEpisode(false);

      // Hand tracks to the provider — it owns the queue.
      // Never interrupt active playback.
      const playingTrack = playerCurrentTrackRef.current;

      if (episodeId && playerTracks.length > 0) {
        const firstPlayablePending = playerTracks.findIndex((t) => t.status === "pending" && isPlayable(t));
        const startIndex = firstPlayablePending >= 0 ? firstPlayablePending : 0;
        setHasEpisodeTracks(true);

        if (playingTrack) {
          const playingIdx = playerTracks.findIndex(t => t.id === playingTrack.id);
          if (playingIdx >= 0) {
            globalPlayer.setQueue(playerTracks, playingIdx);
          } else {
            globalPlayer.setQueue(playerTracks, startIndex);
            globalPlayer.loadTrack(playerTracks[startIndex]);
          }
        } else {
          globalPlayer.setQueue(playerTracks, startIndex);
          globalPlayer.loadTrack(playerTracks[startIndex]);
        }
      } else if (playerTracks.length > 0) {
        const existingQueue = globalPlayer.queue;
        if (existingQueue.length > 0) {
          // Queue already populated — append only genuinely new tracks to preserve vote state
          const existingIds = new Set(existingQueue.map(t => t.id));
          const newTracks = playerTracks.filter(t => !existingIds.has(t.id));
          if (newTracks.length > 0) {
            globalPlayer.appendToQueue(newTracks);
          }
        } else {
          // Initial load — set the full queue
          globalPlayer.setQueue(playerTracks, 0);
          const firstPlayable = playerTracks.findIndex(isPlayable);
          if (firstPlayable >= 0) {
            globalPlayer.loadTrack(playerTracks[firstPlayable]);
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load tracks");
    } finally {
      setLoading(false);
    }
  }, [buildUrl, episodeId]);

  useEffect(() => {
    fetchTracks();
  }, [fetchTracks]);

  const advanceToNextEpisode = useCallback(async () => {
    setAdvancingEpisode(true);
    try {
      const res = await fetch("/api/tracks?status=pending&limit=20");
      if (!res.ok) throw new Error("Failed to fetch next episode");
      const data = await res.json();
      const curEpId = episodeId || currentTrack?.episodeId;
      const nextTrack = (data.tracks || []).find(
        (t: Track) => t.episode_id && t.episode_id !== curEpId
      ) || data.tracks?.[0];

      if (nextTrack?.episode_id) {
        const params = new URLSearchParams();
        params.set("episode_id", nextTrack.episode_id);
        if (nextTrack.episode?.title) params.set("episode_title", nextTrack.episode.title);
        router.push(`/?${params.toString()}`);
      } else {
        setAdvancingEpisode(false);
        router.push("/");
      }
    } catch {
      setAdvancingEpisode(false);
      router.push("/");
    }
  }, [router, episodeId, currentTrack?.episodeId]);

  const handleSuperLike = async (id: string) => {
    userHasInteracted.current = true;
    try {
      const res = await fetch(`/api/tracks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ super_liked: true }),
      });
      if (!res.ok) throw new Error(`Super like failed (${res.status})`);

      if (spotifyConnected) {
        fetch("/api/spotify/sync-seeds", { method: "POST" }).catch(() => {});
      }

      // Update vote in provider — single source of truth
      globalPlayer.updateTrackVote(id, "approved", true);
      setVoteCount((c) => c + 1);
    } catch (err) {
      console.error("Super like error:", err);
      setError("Failed to super like. Please try again.");
    }
  };

  const handleVote = async (id: string, status: "approved" | "rejected" | "skipped" | "bad_source", advance: boolean = true) => {
    userHasInteracted.current = true;
    try {
      const res = await fetch(`/api/tracks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error(`Vote failed (${res.status})`);

      if (status === "approved" && spotifyConnected) {
        fetch("/api/spotify/sync-seeds", { method: "POST" }).catch(() => {});
      }

      // Update vote in provider — single source of truth
      globalPlayer.updateTrackVote(id, status);
      setVoteCount((c) => c + 1);

      if (!advance) return;

      const queue = globalPlayer.queue;

      if (hasEpisodeTracks) {
        // Episode mode: check if any playable pending tracks remain
        const remainingPending = queue.filter((t) => t.id !== id && (t.vote_status === "pending" || t.status === "pending") && isPlayable(t));
        if (remainingPending.length === 0) {
          advanceToNextEpisode();
          return;
        }
        // Advance to next pending + playable track
        const curPos = globalPlayer.currentIndex;
        let nextPos = -1;
        for (let i = curPos + 1; i < queue.length; i++) {
          if (queue[i].id !== id && (queue[i].vote_status === "pending" || queue[i].status === "pending") && isPlayable(queue[i])) { nextPos = i; break; }
        }
        if (nextPos >= 0) {
          globalPlayer.playFromQueue(nextPos);
        } else {
          advanceToNextEpisode();
        }
      } else {
        // Taste/ranked mode: advance to next pending track in queue
        const curPos = globalPlayer.currentIndex;
        let nextPos = -1;
        for (let i = curPos + 1; i < queue.length; i++) {
          if (queue[i].id !== id && (queue[i].vote_status === "pending" || queue[i].status === "pending") && isPlayable(queue[i])) { nextPos = i; break; }
        }
        if (nextPos >= 0) {
          globalPlayer.playFromQueue(nextPos);
        }

        // Batch loading: if running low on pending tracks, fetch more
        const pendingAhead = queue.slice(curPos + 1).filter((t) => (t.vote_status === "pending" || t.status === "pending") && isPlayable(t));
        if (pendingAhead.length <= 3) {
          fetch(buildUrl())
            .then((r) => r.ok ? r.json() : null)
            .then((data) => {
              if (!data) return;
              const newTracks = (data.tracks || []) as Track[];
              if (newTracks.length > 0) {
                globalPlayer.appendToQueue(newTracks.map(toPlayerTrack));
              }
              setTotal(data.total || 0);
            });
        }

        setTotal((prev) => Math.max(0, prev - 1));
      }
    } catch (err) {
      console.error("Vote error:", err);
      setError("Failed to vote. Please try again.");
    }
  };

  // Episode identity — URL-driven or derived from current track
  const derivedEpisodeRef = useRef<{ id: string | null; title: string | null }>({ id: null, title: null });

  if (episodeId) {
    derivedEpisodeRef.current = { id: episodeId, title: episodeTitle };
  } else if (!isTasteMode && currentTrack) {
    const topEpisodeId = currentTrack.episodeId || currentTrack.episode_id || null;
    const topEpisodeTitle = currentTrack.episodeTitle || currentTrack.episode_title || currentTrack.episode?.title || null;
    if (topEpisodeId && !derivedEpisodeRef.current.id) {
      derivedEpisodeRef.current = { id: topEpisodeId, title: topEpisodeTitle };
    } else if (topEpisodeId && derivedEpisodeRef.current.id) {
      const hasLockedEpisodeTracks = globalPlayer.queue.some((t) => (t.episodeId || t.episode_id) === derivedEpisodeRef.current.id);
      if (!hasLockedEpisodeTracks) {
        derivedEpisodeRef.current = { id: topEpisodeId, title: topEpisodeTitle };
      }
    }
  }

  const currentEpisodeId = isTasteMode ? null : derivedEpisodeRef.current.id;
  const currentEpisodeTitle = isTasteMode ? null : derivedEpisodeRef.current.title;

  // When a derived episode is detected in legacy all-pending mode, re-fetch ALL tracks
  const derivedFetchedRef = useRef<string | null>(null);
  useEffect(() => {
    if (episodeId) return;
    if (isTasteMode) return;
    if (!currentEpisodeId) return;
    if (derivedFetchedRef.current === currentEpisodeId) return;
    derivedFetchedRef.current = currentEpisodeId;

    fetch(`/api/tracks?episode_id=${encodeURIComponent(currentEpisodeId)}&limit=100`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (!data?.tracks?.length) return;
        const playerTracks = (data.tracks as Track[]).map(toPlayerTrack);
        setTotal(data.total || 0);
        setHasEpisodeTracks(true);
        const firstPlayable = playerTracks.findIndex((t) => t.status === "pending" && isPlayable(t));
        const startIdx = firstPlayable >= 0 ? firstPlayable : 0;
        globalPlayer.setQueue(playerTracks, startIdx);
        if (playerTracks[startIdx]) {
          globalPlayer.loadTrack(playerTracks[startIdx]);
        }
      });
  }, [currentEpisodeId, episodeId, isTasteMode]);

  // Sidebar/tracklist click → jump to that track via global player
  const handleTrackSelect = useCallback((trackId: string) => {
    userHasInteracted.current = true;
    const idx = globalPlayer.queue.findIndex((t) => t.id === trackId);
    if (idx >= 0) {
      const origin = typeof window !== "undefined" ? window.location.pathname + window.location.search : "/";
      globalPlayer.playFromQueue(idx, origin);
    }
  }, [globalPlayer]);

  const handleSkipEpisode = async () => {
    userHasInteracted.current = true;
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
          router.push("/stacks");
        }
      } else {
        derivedEpisodeRef.current = { id: null, title: null };
        derivedFetchedRef.current = null;
        setHasEpisodeTracks(false);
        fetchTracks();
        setSkippingEpisode(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to skip episode");
      setSkippingEpisode(false);
    }
  };

  const handleGoToStacks = useCallback(() => {
    router.push("/stacks");
  }, [router]);

  const handleGoBack = useCallback(() => {
    if (fromEpisodes) {
      router.push("/episodes");
    } else {
      handleGoToStacks();
    }
  }, [fromEpisodes, handleGoToStacks]);

  // Auto-advance on song end — move to next track in order
  const lastEndedCount = useRef(globalPlayer.trackEndedCount);
  useEffect(() => {
    if (globalPlayer.trackEndedCount === lastEndedCount.current) return;
    lastEndedCount.current = globalPlayer.trackEndedCount;

    const queue = globalPlayer.queue;

    if (hasEpisodeTracks) {
      // Episode mode: advance to next playable track via the global player queue
      const curPos = globalPlayer.currentIndex;
      let nextPos = -1;
      for (let i = curPos + 1; i < queue.length; i++) {
        if (isPlayable(queue[i])) {
          nextPos = i;
          break;
        }
      }
      if (nextPos >= 0) {
        globalPlayer.playFromQueue(nextPos);
      } else {
        advanceToNextEpisode();
      }
      return;
    }

    // Taste/ranked mode: advance to next pending + playable track
    const curPos = globalPlayer.currentIndex;
    let nextPos = -1;
    for (let i = curPos + 1; i < queue.length; i++) {
      if ((queue[i].vote_status === "pending" || queue[i].status === "pending") && isPlayable(queue[i])) {
        nextPos = i;
        break;
      }
    }
    if (nextPos >= 0) {
      globalPlayer.playFromQueue(nextPos);
    }

    // Batch loading when running low on pending tracks
    const pendingAhead = queue.slice(curPos + 1).filter((t) => (t.vote_status === "pending" || t.status === "pending") && isPlayable(t));
    if (pendingAhead.length <= 3) {
      fetch(buildUrl())
        .then((r) => r.ok ? r.json() : null)
        .then((data) => {
          if (!data) return;
          const newTracks = (data.tracks || []) as Track[];
          if (newTracks.length > 0) {
            globalPlayer.appendToQueue(newTracks.map(toPlayerTrack));
          }
          setTotal(data.total || 0);
        });
    }
  }, [globalPlayer.trackEndedCount, globalPlayer.currentIndex, globalPlayer.queue, buildUrl, hasEpisodeTracks, globalPlayer, advanceToNextEpisode]);

  // Preload next track's audio when current track reaches 75% completion
  const preloadTriggeredRef = useRef<string | null>(null);
  useEffect(() => {
    if (!globalPlayer.currentTrack || globalPlayer.duration <= 0 || globalPlayer.progress <= 0) return;
    if (globalPlayer.progress / globalPlayer.duration < 0.75) return;
    if (preloadTriggeredRef.current === globalPlayer.currentTrack.id) return;
    preloadTriggeredRef.current = globalPlayer.currentTrack.id;

    const queue = globalPlayer.queue;
    const curIdx = globalPlayer.currentIndex;
    let nextTrack: PlayerTrack | undefined;
    if (hasEpisodeTracks) {
      for (let i = curIdx + 1; i < queue.length; i++) {
        if (queue[i].status === "pending") { nextTrack = queue[i]; break; }
      }
    } else if (curIdx + 1 < queue.length) {
      nextTrack = queue[curIdx + 1];
    }

    if (nextTrack && (nextTrack.audioUrl || nextTrack.preview_url)) {
      globalPlayer.preloadTrack(nextTrack);
    }
  }, [globalPlayer.progress, globalPlayer.duration, globalPlayer.currentTrack?.id, globalPlayer.currentIndex, globalPlayer.queue, hasEpisodeTracks]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (contextOpen) {
          setContextOpen(false);
        } else if (tracklistOpen) {
          setTracklistOpen(false);
        }
        return;
      }
      if (!currentTrack) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === " ") {
        e.preventDefault();
        globalPlayer.togglePlayPause();
      } else if (e.key === "ArrowLeft" || e.key === "j") {
        handleVote(currentTrack.id, "rejected");
      } else if (e.key === "ArrowRight" || e.key === "k") {
        handleVote(currentTrack.id, "approved");
      } else if (e.key === "l" || e.key === "t") {
        setTracklistOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracklistOpen, contextOpen, globalPlayer, currentTrack?.id]);

  // ── Advancing to next episode ──
  if (advancingEpisode) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[80vh] px-6 text-center gap-4">
        <div className="w-8 h-8 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
        <div>
          <h2 className="text-lg font-medium text-foreground/80">Episode complete</h2>
          <p className="text-sm text-muted mt-1">Loading next episode...</p>
        </div>
      </div>
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
          className="px-5 py-2 text-sm bg-surface-2 hover:bg-surface-3 rounded-lg text-muted hover:text-foreground transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  // ── Empty ──
  const queue = globalPlayer.queue;
  const hasTracksButNonePlayable = queue.length > 0 && !currentTrack;

  if (!currentTrack) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[80vh] px-6 text-center">
        {hasTracksButNonePlayable ? (
          <>
            <h2 className="text-xl font-medium text-foreground/80 mb-2">
              No playable tracks yet — processing
            </h2>
            <p className="text-sm text-muted max-w-xs">
              {queue.length} track{queue.length !== 1 ? "s" : ""} found but audio is still being processed. Check back soon.
            </p>
            <button
              onClick={fetchTracks}
              className="mt-6 px-5 py-2 text-sm bg-surface-2 hover:bg-surface-3 rounded-lg text-muted hover:text-foreground transition-colors"
            >
              Refresh
            </button>
          </>
        ) : episodeId ? (
          <>
            <h2 className="text-xl font-medium text-foreground/80 mb-2">All done!</h2>
            <p className="text-sm text-muted max-w-xs">
              No pending tracks left{episodeTitle ? ` in "${episodeTitle}"` : " in this episode"}.
            </p>
            <div className="flex gap-3 mt-6">
              <button
                onClick={() => router.push("/stacks")}
                className="px-5 py-2 text-sm bg-accent/20 hover:bg-accent/30 text-accent rounded-lg transition-colors"
              >
                Browse Stacks
              </button>
              {fromEpisodes && (
                <a
                  href="/episodes"
                  className="px-5 py-2 text-sm bg-surface-2 hover:bg-surface-3 rounded-lg text-muted hover:text-foreground transition-colors"
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
            <h2 className="text-xl font-medium text-foreground/80 mb-2">
              Pico&apos;s digging...
            </h2>
            <p className="text-sm text-muted max-w-xs">
              No tracks waiting right now. New discoveries will appear here when the agent finds something.
            </p>
            <button
              onClick={fetchTracks}
              className="mt-6 px-5 py-2 text-sm bg-surface-2 hover:bg-surface-3 rounded-lg text-muted hover:text-foreground transition-colors"
            >
              Refresh
            </button>
          </>
        )}
      </div>
    );
  }

  // Convert current PlayerTrack to Track-like for TrackCard + context modal
  const currentTrackLike = toTrackLike(currentTrack);

  // Convert queue to TrackListItem-like for EpisodeTracklist directTracks mode
  const queueAsTracklistItems = queue.map((t) => ({
    id: t.id,
    artist: t.artist,
    title: t.title,
    status: t.vote_status || t.status || "pending",
    spotify_url: t.spotifyUrl,
    youtube_url: t.youtubeUrl || t.youtube_url || null,
    cover_art_url: t.coverArtUrl,
    preview_url: t.preview_url || t.audioUrl || null,
    audio_url: t.audioUrl,
    storage_path: t.storage_path || null,
    is_seed: t.is_seed,
    is_re_seed: t.is_re_seed,
    is_artist_seed: t.is_artist_seed,
    super_liked: t.super_liked,
    vote_status: t.vote_status || t.status || "pending",
    _match_type: t._match_type,
    _ranked_score: t._ranked_score,
  }));

  // When viewing a specific seed's stack, derive seed context from URL params
  const parsedSeedContext = (() => {
    if (!seedName) return null;
    const parts = seedName.split(" — ");
    if (parts.length >= 2) return { artist: parts[0], title: parts.slice(1).join(" — ") };
    return { artist: seedName, title: "" };
  })();

  // ── Main stack view ──
  return (
    <div className={`px-4 pt-2 pb-0 ${mobileHeightClass} flex flex-col overflow-hidden ${desktopPlayerFrameClass}`}>
      {/* Top bar — stack identity always visible */}
      <div className="relative flex items-center justify-between mb-3 md:mb-2 md:max-w-6xl md:mx-auto md:w-full md:flex-shrink-0 min-h-[40px]">
        {/* Left: back to stacks */}
        <button
          onClick={handleGoBack}
          className="flex items-center gap-1.5 text-muted hover:text-foreground transition-colors flex-shrink-0 z-10"
          title={fromEpisodes ? "Back to episodes" : "All stacks"}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          <span className="text-xs hidden md:inline">
            {fromEpisodes ? "Episodes" : "Stacks"}
          </span>
        </button>

        {/* Center: stack name — absolutely centered, always prominent */}
        <button
          onClick={handleGoBack}
          className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none"
        >
          <span className="text-sm font-semibold text-foreground truncate max-w-[200px] md:max-w-[400px] pointer-events-auto">
            {hasEpisodeTracks && currentEpisodeTitle
              ? currentEpisodeTitle
              : seedName
                ? seedName
                : genreFilter
                  ? genreFilter
                  : "For You"}
          </span>
          <span className="text-[10px] font-mono text-muted/60 pointer-events-auto">
            {hasEpisodeTracks
              ? `${currentDisplayIndex + 1} / ${total}`
              : isRankedMode
                ? `ranked queue — ${total} tracks`
                : `${total} pending`}
          </span>
        </button>

        {/* Right: tracklist button (mobile only — desktop always shows sidebar) */}
        <button
          onClick={() => setTracklistOpen(!tracklistOpen)}
          className="md:hidden flex-shrink-0 p-2 text-muted hover:text-foreground transition-colors z-10"
          title="Show tracklist"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="8" y1="6" x2="21" y2="6" />
            <line x1="8" y1="12" x2="21" y2="12" />
            <line x1="8" y1="18" x2="21" y2="18" />
            <line x1="3" y1="6" x2="3.01" y2="6" />
            <line x1="3" y1="12" x2="3.01" y2="12" />
            <line x1="3" y1="18" x2="3.01" y2="18" />
          </svg>
        </button>
      </div>

      {/* Desktop: tracklist always visible on left, card on right */}
      <div className="flex-1 min-h-0 flex flex-col md:flex-row md:gap-6 md:max-w-6xl md:mx-auto md:w-full">
        {/* Desktop tracklist sidebar — always visible */}
        <div className="hidden md:block md:w-80 md:min-w-[20rem] md:max-w-[20rem] md:flex-shrink-0 md:self-stretch">
          {currentEpisodeId ? (
            <EpisodeTracklist
              episodeId={currentEpisodeId}
              episodeTitle={currentEpisodeTitle}
              listTitle={currentEpisodeTitle}
              refreshKey={voteCount}
              seedId={fromSeedId}
              onTrackSelect={handleTrackSelect}
            />
          ) : (
            <EpisodeTracklist
              directTracks={queueAsTracklistItems as any}
              listTitle={seedName || genreFilter || "For You"}
              onTrackSelect={handleTrackSelect}
            />
          )}
        </div>

        {/* Track card — fills remaining space on mobile, centered on desktop */}
        <div className="flex-1 min-h-0 md:flex md:items-center md:justify-center">
          <TrackCard
            key={currentTrack.id}
            track={currentTrackLike}
            onVote={handleVote}
            onSuperLike={handleSuperLike}
            onSkipEpisode={currentEpisodeId ? handleSkipEpisode : undefined}
            skippingEpisode={skippingEpisode}
            onShowContext={() => setContextOpen(true)}
            seedContext={parsedSeedContext}
          />
        </div>
      </div>

      {/* Mobile tracklist sheet — works for all views */}
      <TracklistSheet
        episodeId={currentEpisodeId || undefined}
        episodeTitle={currentEpisodeTitle}
        listTitle={currentEpisodeId ? currentEpisodeTitle : (seedName || genreFilter || "For You")}
        directTracks={currentEpisodeId ? undefined : (queueAsTracklistItems as any)}
        refreshKey={voteCount}
        seedId={fromSeedId}
        open={tracklistOpen}
        onClose={() => setTracklistOpen(false)}
        onTrackSelect={handleTrackSelect}
      />

      {/* Keyboard hint (desktop only) */}
      <div className="hidden md:flex justify-center gap-6 py-3 text-xs text-muted md:flex-shrink-0">
        <span>&larr; / j skip</span>
        <span>&rarr; / k keep</span>
        <span>space play/pause</span>
        <span>esc close</span>
      </div>

      {/* Track context modal */}
      {contextOpen && currentTrack && (
        <TrackContextModal
          track={currentTrackLike}
          stackSource={stackSource}
          genreFilter={genreFilter}
          seedName={seedName}
          seedContext={parsedSeedContext}
          episodeTitle={hasEpisodeTracks ? currentEpisodeTitle : null}
          episodePos={hasEpisodeTracks ? currentDisplayIndex + 1 : null}
          episodeTotal={hasEpisodeTracks ? total : null}
          onClose={() => setContextOpen(false)}
        />
      )}
    </div>
  );
}

// ── Track Context Modal ──────────────────────────────────────────────────────

function TrackContextModal({
  track,
  stackSource,
  genreFilter,
  seedName,
  seedContext,
  episodeTitle,
  episodePos,
  episodeTotal,
  onClose,
}: {
  track: Track;
  stackSource: string | null;
  genreFilter: string | null;
  seedName: string | null;
  seedContext?: { artist: string; title: string } | null;
  episodeTitle: string | null;
  episodePos: number | null;
  episodeTotal: number | null;
  onClose: () => void;
}) {
  const meta = (track.metadata ?? {}) as Record<string, unknown>;
  const seedArtist = (seedContext?.artist || (track as any)._seed_artist || track.seed_track?.artist || meta.seed_artist) as string | undefined;
  const seedTitle = (seedContext?.title || (track as any)._seed_title || track.seed_track?.title || meta.seed_title) as string | undefined;
  const coOccurrence = meta.co_occurrence as number | undefined;
  const genre = meta.genre as string | undefined;
  const discoveryMethod = meta.discovery_method as string | undefined;
  const curatorSlug = meta.curator_slug as string | undefined;
  const matchType = (track as any)._match_type as string | undefined;
  const rankedScore = (track as any)._ranked_score as number | undefined;
  const scoreComponents = (track as any)._score_components as Record<string, number> | undefined;

  const modeLabel = () => {
    if (episodeTitle) return `Episode: ${episodeTitle}${episodePos && episodeTotal ? ` — track ${episodePos} of ${episodeTotal}` : ""}`;
    if (stackSource === "seed" && seedName) return `Seed stack: ${seedName}`;
    if (stackSource === "genre" && genreFilter) return `Genre filter: ${genreFilter}`;
    return "For You — ranked by taste profile";
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end md:items-center justify-center"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative w-full md:max-w-sm mx-auto bg-surface-1 border border-foreground/10 rounded-t-2xl md:rounded-2xl shadow-2xl p-5 space-y-4 md:mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">Why this track?</h3>
          <button
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded-full hover:bg-foreground/10 text-foreground/40 hover:text-foreground transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Source episode */}
        {(track.source || track.source_context || track.episode) && (
          <div>
            <p className="text-[10px] text-muted uppercase tracking-wider mb-1">Source Episode</p>
            {(() => {
              const linkUrl = track.source_url || track.episode?.url || null;
              const label = track.source_context || track.episode?.title || track.source;
              if (linkUrl) {
                return (
                  <a
                    href={linkUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-accent hover:text-accent-bright underline underline-offset-2 decoration-accent/30"
                  >
                    {label}
                  </a>
                );
              }
              return <p className="text-sm text-foreground/80">{label}</p>;
            })()}
          </div>
        )}

        {/* Discovery Method */}
        <div>
          <p className="text-[10px] text-muted uppercase tracking-wider mb-1">Discovery Method</p>
          {discoveryMethod === "radar:curator" ? (
            <p className="text-sm text-foreground/80">
              📡 Curator Radar{curatorSlug && <span className="text-foreground/50"> · {curatorSlug}</span>}
            </p>
          ) : matchType === "artist" ? (
            <p className="text-sm text-foreground/80">
              🌿 Re-seed Discovery
              {seedArtist && (
                <span className="text-foreground/50"> · via {seedArtist}{seedTitle ? ` — ${seedTitle}` : ""}</span>
              )}
            </p>
          ) : (
            <p className="text-sm text-foreground/80">🌱 Seed Discovery</p>
          )}
        </div>

        {/* Seed connection */}
        {seedArtist && (
          <div>
            <p className="text-[10px] text-muted uppercase tracking-wider mb-1">Seed Connection</p>
            <p className="text-sm text-foreground/80">
              <span className="text-foreground">{seedArtist}</span>
              {seedTitle && <span className="text-foreground/50"> — {seedTitle}</span>}
            </p>
          </div>
        )}

        {/* Mode context */}
        <div>
          <p className="text-[10px] text-muted uppercase tracking-wider mb-1">Context</p>
          <p className="text-sm text-foreground/80">{modeLabel()}</p>
        </div>

        {/* Taste signals */}
        {(typeof track.taste_score === "number" || genre || typeof rankedScore === "number") && (
          <div>
            <p className="text-[10px] text-muted uppercase tracking-wider mb-1">Taste Signals</p>
            <div className="flex flex-wrap gap-2">
              {typeof rankedScore === "number" && (
                <span className={`text-xs font-mono px-2 py-0.5 rounded ${rankedScore >= 50 ? "bg-green-500/15 text-green-400" : rankedScore >= 25 ? "bg-amber-500/15 text-amber-400" : "bg-red-500/15 text-red-400"}`}>
                  rank {rankedScore}/100
                </span>
              )}
              {typeof track.taste_score === "number" && track.taste_score !== 0 && (
                <span className={`text-xs font-mono px-2 py-0.5 rounded ${track.taste_score > 0 ? "bg-green-500/15 text-green-400" : "bg-red-500/15 text-red-400"}`}>
                  taste {track.taste_score > 0 ? "+" : ""}{track.taste_score.toFixed(2)}
                </span>
              )}
              {genre && (
                <span className="text-xs px-2 py-0.5 rounded bg-surface-2 text-muted">{genre}</span>
              )}
            </div>
            {scoreComponents && (
              <div className="flex flex-wrap gap-1.5 mt-1.5">
                {Object.entries(scoreComponents).map(([key, val]) => (
                  val !== 0 && (
                    <span key={key} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-surface-2 text-muted">
                      {key.replace(/_/g, " ")} {val > 0 ? "+" : ""}{val}
                    </span>
                  )
                ))}
              </div>
            )}
          </div>
        )}

        {/* Co-occurrence */}
        {coOccurrence && coOccurrence > 1 && (
          <div>
            <p className="text-[10px] text-muted uppercase tracking-wider mb-1">Co-occurrence</p>
            <p className="text-sm text-foreground/80">Appears in {coOccurrence} DJ sets with your seeds</p>
          </div>
        )}
      </div>
    </div>
  );
}
