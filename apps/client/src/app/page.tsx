"use client";

import { useState, useEffect, useCallback, useRef, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Track } from "@/lib/types";
import { TrackCard } from "@/components/TrackCard";
import { EpisodeTracklist, TracklistSheet } from "@/components/EpisodeTracklist";
import { useGlobalPlayer, PlayerTrack } from "@/components/GlobalPlayerProvider";
import { useSpotify } from "@/components/SpotifyProvider";

function mergeTrackSession(existing: Track[], incoming: Track[]): Track[] {
  const merged = new Map(existing.map((track) => [track.id, track]));
  for (const track of incoming) {
    merged.set(track.id, { ...merged.get(track.id), ...track });
  }

  const seen = new Set<string>();
  const ordered: Track[] = [];

  for (const track of existing) {
    const next = merged.get(track.id);
    if (!next || seen.has(track.id)) continue;
    ordered.push(next);
    seen.add(track.id);
  }

  for (const track of incoming) {
    const next = merged.get(track.id);
    if (!next || seen.has(track.id)) continue;
    ordered.push(next);
    seen.add(track.id);
  }

  return ordered;
}

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

/** Convert a local Track to a PlayerTrack for the global player queue */
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
  };
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
  const fromStacks = searchParams.get("from") === "stacks";
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

  const [tracks, setTracks] = useState<Track[]>([]);
  const [sessionTracks, setSessionTracks] = useState<Track[]>([]);
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

  // Session-level rejection/approval momentum (not persisted to DB)
  const rejectionCounts = useRef<Map<string, number>>(new Map()); // episode_id → reject count
  const seedRejections = useRef<Map<string, number>>(new Map());  // seed_artist → reject count
  const recentApprovals = useRef<Array<{ genres: string[]; seedArtist: string | null }>>([]); // last 5

  // Don't auto-play until the user has interacted (vote, skip, click track, etc.)
  const userHasInteracted = useRef(false);

  // Track whether we've already reconciled player state after a fetch
  const reconciledTrackId = useRef<string | null>(null);
  // Prevent reconciliation from firing on navigation to a new stack
  const skipReconcileRef = useRef(false);
  const stackIdentityRef = useRef<string>("");
  // Ref for global player's current track (avoids stale closures in fetchTracks)
  const playerCurrentTrackRef = useRef(globalPlayer.currentTrack);
  useEffect(() => { playerCurrentTrackRef.current = globalPlayer.currentTrack; }, [globalPlayer.currentTrack]);

  useEffect(() => {
    setAdvancingEpisode(false);
  }, [episodeId]);

  // Whether we're operating in "episode mode" (full episode tracks + position index)
  // This is true both for URL-driven episodes AND derived episodes in all-pending
  const [hasEpisodeTracks, setHasEpisodeTracks] = useState(!!episodeId);

  // Helper: check if a track has playable audio
  const isTrackPlayable = (t: Track) => !!(t.audio_url || t.storage_path);

  // The track currently shown on the card — derived from global player (single source of truth)
  const currentTrack = (() => {
    // If the global player has a track loaded, find it in our local tracks
    if (globalPlayer.currentTrack) {
      const found = tracks.find(t => t.id === globalPlayer.currentTrack!.id);
      if (found) return found;
    }
    // Fallback for initial load (before player has a track):
    // show first playable track without playing it
    if (hasEpisodeTracks) {
      const idx = Math.min(globalPlayer.currentIndex, Math.max(tracks.length - 1, 0));
      const t = tracks[idx];
      if (t && isTrackPlayable(t)) return t;
      for (let i = idx + 1; i < tracks.length; i++) {
        if (isTrackPlayable(tracks[i])) return tracks[i];
      }
      for (let i = 0; i < idx; i++) {
        if (isTrackPlayable(tracks[i])) return tracks[i];
      }
      return null;
    }
    return tracks.find(isTrackPlayable) ?? null;
  })();

  // Position of current track in the local tracks array (for display)
  const currentDisplayIndex = currentTrack ? tracks.findIndex(t => t.id === currentTrack.id) : 0;

  const lastEpisodeIdRef = useRef<string | null>(episodeId);

  // Push tracks from heavily-rejected episodes/seeds to the back of the queue
  const reorderByMomentum = useCallback((trackList: Track[]): Track[] => {
    const normal: Track[] = [];
    const deprioritized: Track[] = [];
    for (const track of trackList) {
      const epId = track.episode_id || null;
      const seedArtist = (track.metadata["seed_artist"] as string) || null;
      const epCount = epId ? (rejectionCounts.current.get(epId) ?? 0) : 0;
      const seedCount = seedArtist ? (seedRejections.current.get(seedArtist) ?? 0) : 0;
      if (epCount >= 3 || seedCount >= 4) deprioritized.push(track);
      else normal.push(track);
    }
    return [...normal, ...deprioritized];
  }, []);

  // Promote tracks matching recent approval genre/seed patterns to the front
  const boostByChain = useCallback((trackList: Track[]): Track[] => {
    if (recentApprovals.current.length < 2) return trackList;
    const genreCounts = new Map<string, number>();
    const seedCounts = new Map<string, number>();
    for (const a of recentApprovals.current) {
      for (const g of a.genres) genreCounts.set(g, (genreCounts.get(g) ?? 0) + 1);
      if (a.seedArtist) seedCounts.set(a.seedArtist, (seedCounts.get(a.seedArtist) ?? 0) + 1);
    }
    const boostedGenres = new Set(Array.from(genreCounts.entries()).filter(([, c]) => c >= 2).map(([g]) => g));
    const boostedSeeds = new Set(Array.from(seedCounts.entries()).filter(([, c]) => c >= 2).map(([s]) => s));
    if (boostedGenres.size === 0 && boostedSeeds.size === 0) return trackList;
    const front: Track[] = [];
    const rest: Track[] = [];
    for (const track of trackList) {
      const genres = (track.metadata["genres"] as string[]) || [];
      const seedArtist = (track.metadata["seed_artist"] as string) || null;
      if (genres.some((g) => boostedGenres.has(g)) || (seedArtist && boostedSeeds.has(seedArtist))) {
        front.push(track);
      } else {
        rest.push(track);
      }
    }
    return [...front, ...rest];
  }, []);


  const buildUrl = useCallback((_extra?: string) => {
    // Episode mode: fetch ALL tracks in episode order (not just pending)
    if (episodeId) {
      return `/api/tracks?episode_id=${encodeURIComponent(episodeId)}&limit=100`;
    }
    // Ranked mode: call the seed's ranked queue endpoint (returns all pending, taste-weighted)
    if (isRankedMode && fromSeedId) {
      return `/api/stacks/${encodeURIComponent(fromSeedId)}/queue`;
    }
    // Taste/genre/seed mode: fetch pending tracks ranked by taste_score
    let url = `/api/tracks?status=pending&limit=20`;
    if (isTasteMode) {
      url += `&order_by=taste_score`;
    }
    if (isTasteMode && hideLowScored) {
      url += `&hide_low=true`;
    }
    if (genreFilter) {
      url += `&genre=${encodeURIComponent(genreFilter)}`;
    }
    if (seedFilter) {
      url += `&seed_artist=${encodeURIComponent(seedFilter)}`;
    }
    return url;
  }, [episodeId, isRankedMode, fromSeedId, isTasteMode, hideLowScored, genreFilter, seedFilter]);

  const fetchTracks = useCallback(async () => {
    reconciledTrackId.current = null;
    try {
      const res = await fetch(buildUrl());
      if (!res.ok) throw new Error(`Failed to load tracks (${res.status})`);
      const data = await res.json();
      let newTracks: Track[] = data.tracks || [];
      // Client-side reordering in taste/genre/seed modes only (not ranked — API handles ordering)
      if (!episodeId && isTasteMode && !isRankedMode) {
        newTracks = reorderByMomentum(newTracks);
        newTracks = boostByChain(newTracks);
      }
      setTracks(newTracks);
      setSessionTracks((prev) =>
        episodeId || !isTasteMode ? newTracks : mergeTrackSession(prev, newTracks)
      );
      setTotal(data.total || 0);
      setError(null);
      setAdvancingEpisode(false);

      // Sync queue to global player
      const playerTracks = newTracks.map(toPlayerTrack);
      if (episodeId && newTracks.length > 0) {
        const firstPlayablePending = newTracks.findIndex((t) => t.status === "pending" && isTrackPlayable(t));
        const startIndex = firstPlayablePending >= 0 ? firstPlayablePending : 0;
        setHasEpisodeTracks(true);
        globalPlayer.setQueue(playerTracks, startIndex);
        // Load first track without playing (before user interaction)
        if (skipReconcileRef.current || !playerCurrentTrackRef.current) {
          globalPlayer.loadTrack(playerTracks[startIndex]);
          skipReconcileRef.current = false;
        }
      } else if (newTracks.length > 0) {
        globalPlayer.setQueue(playerTracks, 0);
        if (skipReconcileRef.current || !playerCurrentTrackRef.current) {
          const firstPlayable = newTracks.findIndex(isTrackPlayable);
          if (firstPlayable >= 0) {
            globalPlayer.loadTrack(playerTracks[firstPlayable]);
          }
          skipReconcileRef.current = false;
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load tracks");
    } finally {
      setLoading(false);
    }
  }, [buildUrl, episodeId, isTasteMode, reorderByMomentum, boostByChain]);

  useEffect(() => {
    fetchTracks();
  }, [fetchTracks]);

  useEffect(() => {
    setSessionTracks([]);
    rejectionCounts.current = new Map();
    seedRejections.current = new Map();
    recentApprovals.current = [];
  }, [episodeId, stackSource, genreFilter, seedFilter]);

  // Track stack identity to skip reconciliation when navigating to a different stack
  const stackIdentity = episodeId || `${stackSource}-${genreFilter}-${seedFilter}`;
  useEffect(() => {
    if (stackIdentityRef.current !== stackIdentity) {
      stackIdentityRef.current = stackIdentity;
      reconciledTrackId.current = null;
      skipReconcileRef.current = true;
    }
  }, [stackIdentity]);

  // Reconcile tracks with globalPlayer.currentTrack after fetch completes.
  // When re-mounting (e.g. navigating back to Playing tab), fetchTracks gets fresh
  // data but globalPlayer still holds the previously-playing track. This syncs them.
  const reconcilePlayerWithTracks = useCallback(() => {
    const playerTrack = globalPlayer.currentTrack;
    if (!playerTrack) return;
    if (reconciledTrackId.current === playerTrack.id) return;

    setTracks((prev) => {
      if (prev.length === 0) return prev;

      if (episodeId || hasEpisodeTracks) {
        // Episode mode: sync queue index to the playing track's position
        const idx = prev.findIndex((t) => t.id === playerTrack.id);
        if (idx >= 0) {
          globalPlayer.setQueue(prev.map(toPlayerTrack), idx);
        }
        // Don't reorder episode tracks — position is semantic
        return prev;
      }

      // Taste/genre/seed mode: promote or prepend the playing track
      const idx = prev.findIndex((t) => t.id === playerTrack.id);
      if (idx === 0) return prev; // already first

      if (idx > 0) {
        // Found in list — move to front
        const reordered = [...prev];
        const [playing] = reordered.splice(idx, 1);
        reordered.unshift(playing);
        return reordered;
      }

      // Not in list — prepend a synthetic track from player state
      // Guard: in seed/ranked mode, only prepend if the player track is from this seed context.
      // If it's not in the seed-filtered list, it belongs to a different stack.
      if (isSeedMode || isRankedMode) return prev;

      const synthetic: Track = {
        id: playerTrack.id,
        artist: playerTrack.artist,
        title: playerTrack.title,
        cover_art_url: playerTrack.coverArtUrl,
        spotify_url: playerTrack.spotifyUrl,
        audio_url: playerTrack.audioUrl,
        episode_id: playerTrack.episodeId,
        status: "pending",
      } as Track;
      return [synthetic, ...prev];
    });

    setSessionTracks((prev) => {
      if (prev.some((track) => track.id === playerTrack.id)) return prev;
      if (isSeedMode || isRankedMode) return prev;

      const synthetic: Track = {
        id: playerTrack.id,
        artist: playerTrack.artist,
        title: playerTrack.title,
        cover_art_url: playerTrack.coverArtUrl,
        spotify_url: playerTrack.spotifyUrl,
        audio_url: playerTrack.audioUrl,
        episode_id: playerTrack.episodeId,
        status: "pending",
      } as Track;

      return [synthetic, ...prev];
    });

    reconciledTrackId.current = playerTrack.id;
    if (!episodeId && !hasEpisodeTracks) {
      userHasInteracted.current = true;
    }
  }, [globalPlayer.currentTrack, episodeId, hasEpisodeTracks, isSeedMode, isRankedMode]);

  // Fire reconciliation when tracks finish loading and player has a current track
  const playerTrackId = globalPlayer.currentTrack?.id ?? null;
  useEffect(() => {
    if (loading) return;
    if (!playerTrackId) return;
    if (skipReconcileRef.current) {
      skipReconcileRef.current = false;
      return;
    }
    reconcilePlayerWithTracks();
  }, [loading, playerTrackId, reconcilePlayerWithTracks]);

  const advanceToNextEpisode = useCallback(async () => {
    setAdvancingEpisode(true);
    try {
      // Fetch pending tracks — find one from a different episode
      const res = await fetch("/api/tracks?status=pending&limit=20");
      if (!res.ok) throw new Error("Failed to fetch next episode");
      const data = await res.json();
      const curEpId = derivedEpisodeRef.current.id || episodeId;
      const nextTrack = (data.tracks || []).find(
        (t: Track) => t.episode_id && t.episode_id !== curEpId
      ) || data.tracks?.[0];

      if (nextTrack?.episode_id) {
        const params = new URLSearchParams();
        params.set("episode_id", nextTrack.episode_id);
        if (nextTrack.episode?.title) params.set("episode_title", nextTrack.episode.title);
        router.push(`/?${params.toString()}`);
      } else {
        // No more pending tracks at all
        setAdvancingEpisode(false);
        router.push("/");
      }
    } catch {
      setAdvancingEpisode(false);
      router.push("/");
    }
  }, [router, episodeId]);

  const handleSuperLike = async (id: string) => {
    userHasInteracted.current = true;
    try {
      const res = await fetch(`/api/tracks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ super_liked: true }),
      });
      if (!res.ok) throw new Error(`Super like failed (${res.status})`);

      // Auto-sync Spotify playlist when a track is super-liked (it becomes approved)
      if (spotifyConnected) {
        fetch("/api/spotify/sync-seeds", { method: "POST" }).catch(() => {});
      }

      // Update local state — super-liked tracks are approved
      setTracks((prev) =>
        prev.map((t) => t.id === id ? { ...t, status: "approved", super_liked: true, voted_at: new Date().toISOString() } : t)
      );
      setSessionTracks((prev) =>
        prev.map((t) => t.id === id ? { ...t, status: "approved", super_liked: true, voted_at: new Date().toISOString() } : t)
      );

      setVoteCount((c) => c + 1);
      // No auto-advance — user taps the [->] button (second tap) to move on
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

      // Auto-sync Spotify playlist when a track is approved
      if (status === "approved" && spotifyConnected) {
        fetch("/api/spotify/sync-seeds", { method: "POST" }).catch(() => {});
      }

      // Update the track's status locally so the UI reflects the vote
      // Clear super_liked when changing vote (e.g. super-like → rejected)
      setTracks((prev) =>
        prev.map((t) => t.id === id ? { ...t, status, super_liked: false, voted_at: new Date().toISOString() } : t)
      );
      setSessionTracks((prev) =>
        prev.map((t) => t.id === id ? { ...t, status, super_liked: false, voted_at: new Date().toISOString() } : t)
      );

      setVoteCount((c) => c + 1);

      if (!advance) return;

      if (hasEpisodeTracks) {
        // Episode mode: check if any playable pending tracks remain (excluding the one we just voted on)
        const remainingPending = tracks.filter((t) => t.id !== id && t.status === "pending" && isTrackPlayable(t));
        if (remainingPending.length === 0) {
          // All tracks voted — advance to next episode
          advanceToNextEpisode();
          return;
        }
        // Advance to next pending + playable track via global player queue
        const curPos = globalPlayer.currentIndex;
        let nextPos = -1;
        for (let i = curPos + 1; i < tracks.length; i++) {
          if (tracks[i].id !== id && tracks[i].status === "pending" && isTrackPlayable(tracks[i])) { nextPos = i; break; }
        }
        if (nextPos < 0) {
          // Wrap around — find first pending + playable before current
          for (let i = 0; i < curPos; i++) {
            if (tracks[i].id !== id && tracks[i].status === "pending" && isTrackPlayable(tracks[i])) { nextPos = i; break; }
          }
        }
        if (nextPos >= 0) {
          globalPlayer.playFromQueue(nextPos);
        }
      } else {
        // All-pending mode: update momentum refs then remove voted track + reorder
        if (isTasteMode) {
          const votedTrack = tracks.find((t) => t.id === id);
          if (votedTrack) {
            if (status === "rejected") {
              const epId = votedTrack.episode_id;
              const seedArtist = votedTrack.metadata["seed_artist"] as string | undefined;
              if (epId) rejectionCounts.current.set(epId, (rejectionCounts.current.get(epId) ?? 0) + 1);
              if (seedArtist) seedRejections.current.set(seedArtist, (seedRejections.current.get(seedArtist) ?? 0) + 1);
            } else if (status === "approved") {
              const genres = (votedTrack.metadata["genres"] as string[]) || [];
              const seedArtist = (votedTrack.metadata["seed_artist"] as string) || null;
              recentApprovals.current = [{ genres, seedArtist }, ...recentApprovals.current].slice(0, 5);
            }
          }
        }
        setTracks((prev) => {
          const remaining = prev.filter((t) => t.id !== id);
          let ordered = remaining;
          // In ranked mode, preserve server-side ordering — no client reordering
          if (isTasteMode && !isRankedMode) {
            ordered = reorderByMomentum(ordered);
            ordered = boostByChain(ordered);
          }
          // Sync queue to provider and play next track
          globalPlayer.setQueue(ordered.map(toPlayerTrack), 0);
          if (ordered.length > 0) {
            globalPlayer.playFromQueue(0);
          }
          // Ranked mode: full queue is loaded upfront, no refetch needed
          if (!isRankedMode && ordered.length <= 3) {
            const votedId = id;
            const existingIds = new Set(ordered.map((t) => t.id));
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
                    let combined = [...curr, ...fresh];
                    if (isTasteMode && !isRankedMode) {
                      combined = reorderByMomentum(combined);
                      combined = boostByChain(combined);
                    }
                    // Re-sync queue with fresh tracks
                    globalPlayer.setQueue(combined.map(toPlayerTrack));
                    return combined;
                  });
                  setSessionTracks((curr) => mergeTrackSession(curr, newTracks));
                }
                setTotal(data.total || 0);
              });
          }
          return ordered;
        });
        setTotal((prev) => prev - 1);
      }
    } catch (err) {
      console.error("Vote error:", err);
      setError("Failed to vote. Please try again.");
    }
  };

  // Stabilize episode: once we derive an episode from the top track, lock it
  // so voting doesn't randomly switch the tracklist to a different episode.
  // In taste/genre mode, skip episode derivation entirely — cards flow freely.
  const derivedEpisodeRef = useRef<{ id: string | null; title: string | null }>({ id: null, title: null });
  const topEpisodeId = currentTrack?.episode_id ?? null;
  const topEpisodeTitle = currentTrack?.episode?.title ?? null;

  if (episodeId) {
    // URL-driven: always use URL value
    derivedEpisodeRef.current = { id: episodeId, title: episodeTitle };
  } else if (!isTasteMode) {
    // Legacy all-pending mode (no source param): derive episode from top track
    if (topEpisodeId && !derivedEpisodeRef.current.id) {
      derivedEpisodeRef.current = { id: topEpisodeId, title: topEpisodeTitle };
    } else if (topEpisodeId && derivedEpisodeRef.current.id) {
      const hasLockedEpisodeTracks = tracks.some((t) => t.episode_id === derivedEpisodeRef.current.id);
      if (!hasLockedEpisodeTracks) {
        derivedEpisodeRef.current = { id: topEpisodeId, title: topEpisodeTitle };
      }
    }
  }
  // In taste/genre mode: no episode locking. derivedEpisodeRef stays null.

  const currentEpisodeId = isTasteMode ? null : derivedEpisodeRef.current.id;
  const currentEpisodeTitle = isTasteMode ? null : derivedEpisodeRef.current.title;

  // When a derived episode is detected in legacy all-pending mode, re-fetch ALL tracks
  // from that episode so we can navigate the full tracklist (not just pending)
  const derivedFetchedRef = useRef<string | null>(null);
  useEffect(() => {
    if (episodeId) return;
    if (isTasteMode) return; // Taste/genre mode: no episode fetching
    if (!currentEpisodeId) return;
    if (derivedFetchedRef.current === currentEpisodeId) return;
    derivedFetchedRef.current = currentEpisodeId;

    fetch(`/api/tracks?episode_id=${encodeURIComponent(currentEpisodeId)}&limit=100`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (!data?.tracks?.length) return;
        setTracks(data.tracks);
        setTotal(data.total || 0);
        setHasEpisodeTracks(true);
        const firstPlayable = data.tracks.findIndex((t: Track) => t.status === "pending" && isTrackPlayable(t));
        const startIdx = firstPlayable >= 0 ? firstPlayable : 0;
        globalPlayer.setQueue(data.tracks.map(toPlayerTrack), startIdx);
        if (data.tracks[startIdx]) {
          globalPlayer.loadTrack(toPlayerTrack(data.tracks[startIdx]));
        }
      });
  }, [currentEpisodeId, episodeId, isTasteMode]);

  // Sidebar/tracklist click → jump to that track via global player (single source of truth)
  const handleTrackSelect = useCallback((trackId: string) => {
    userHasInteracted.current = true;
    // Find the track's index in the queue and jump to it
    const idx = tracks.findIndex((t) => t.id === trackId);
    if (idx >= 0) {
      globalPlayer.playFromQueue(idx);
    }
  }, [tracks, globalPlayer]);

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
        // Reset derived episode state so we pick up the next episode
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

  // Card → Player sync is no longer needed — the global player is the single
  // source of truth. All navigation (tracklist clicks, votes, auto-advance)
  // goes through globalPlayer.playFromQueue() which updates both the player
  // and the card atomically.
  const currentTrackId = currentTrack?.id ?? null;

  // Auto-advance on song end — move to next track in order
  const lastEndedCount = useRef(globalPlayer.trackEndedCount);
  useEffect(() => {
    if (globalPlayer.trackEndedCount === lastEndedCount.current) return;
    lastEndedCount.current = globalPlayer.trackEndedCount;

    if (hasEpisodeTracks) {
      // Episode mode: advance to next playable track via the global player queue.
      const curPos = globalPlayer.currentIndex;
      let nextPos = -1;
      for (let i = curPos + 1; i < tracks.length; i++) {
        const t = tracks[i];
        if (t.audio_url || t.preview_url || t.storage_path || t.spotify_url) {
          nextPos = i;
          break;
        }
      }
      if (nextPos >= 0) {
        globalPlayer.playFromQueue(nextPos);
      } else {
        // No playable tracks ahead — advance to next episode
        advanceToNextEpisode();
      }
      return;
    }

    // All-pending mode: drop finished track, advance via queue
    if (tracks.length < 2) return;
    const currentId = globalPlayer.currentTrack?.id;
    if (!currentId || currentId !== tracks[0]?.id) return;
    setTracks((prev) => {
      if (prev.length < 2) return prev;
      const remaining = prev.slice(1);
      // Update the queue with remaining tracks and play the first one
      globalPlayer.setQueue(remaining.map(toPlayerTrack), 0);
      globalPlayer.playFromQueue(0);
      // Ranked mode: full queue is loaded upfront, no refetch needed
      if (!isRankedMode && remaining.length <= 3) {
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
                let combined = [...curr, ...fresh];
                if (isTasteMode && !isRankedMode) {
                  combined = reorderByMomentum(combined);
                  combined = boostByChain(combined);
                }
                // Re-sync queue with fresh tracks
                globalPlayer.setQueue(combined.map(toPlayerTrack));
                return combined;
              });
              setSessionTracks((curr) => mergeTrackSession(curr, newTracks));
            }
            setTotal(data.total || 0);
          });
      }
      return remaining;
    });
  }, [globalPlayer.trackEndedCount, tracks, globalPlayer.currentTrack?.id, globalPlayer.currentIndex, buildUrl, hasEpisodeTracks, isRankedMode, globalPlayer, advanceToNextEpisode]);

  // Preload next track's audio when current track reaches 75% completion
  const preloadTriggeredRef = useRef<string | null>(null);
  useEffect(() => {
    if (!globalPlayer.currentTrack || globalPlayer.duration <= 0 || globalPlayer.progress <= 0) return;
    if (globalPlayer.progress / globalPlayer.duration < 0.75) return;
    // Only trigger once per track
    if (preloadTriggeredRef.current === globalPlayer.currentTrack.id) return;
    preloadTriggeredRef.current = globalPlayer.currentTrack.id;

    // Find the next track in queue
    let nextTrack: Track | undefined;
    if (hasEpisodeTracks) {
      for (let i = globalPlayer.currentIndex + 1; i < tracks.length; i++) {
        if (tracks[i].status === "pending") { nextTrack = tracks[i]; break; }
      }
    } else if (tracks.length > 1) {
      nextTrack = tracks[1];
    }

    if (nextTrack && (nextTrack.audio_url || nextTrack.preview_url)) {
      globalPlayer.preloadTrack(toPlayerTrack(nextTrack));
    }
  }, [globalPlayer.progress, globalPlayer.duration, globalPlayer.currentTrack?.id, globalPlayer.currentIndex, tracks, hasEpisodeTracks]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (contextOpen) {
          setContextOpen(false);
        } else if (tracklistOpen) {
          setTracklistOpen(false);
        }
        // Do nothing if no modal is open — never navigate away on Escape
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
  }, [tracks, tracklistOpen, contextOpen, globalPlayer]);

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
  // Check if we have tracks but none are playable
  const hasTracksButNonePlayable = tracks.length > 0 && !currentTrack;

  if (!currentTrack) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[80vh] px-6 text-center">
        {hasTracksButNonePlayable ? (
          <>
            <h2 className="text-xl font-medium text-foreground/80 mb-2">
              No playable tracks yet — processing
            </h2>
            <p className="text-sm text-muted max-w-xs">
              {tracks.length} track{tracks.length !== 1 ? "s" : ""} found but audio is still being processed. Check back soon.
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

  // Mark seed tracks for the For You / taste / seed sidebar
  const sessionTracksWithSeedFlag = sessionTracks.map((t) => {
    if (t.seed_id && t.seed_track &&
        t.seed_track.artist.toLowerCase() === t.artist.toLowerCase() &&
        t.seed_track.title.toLowerCase() === t.title.toLowerCase()) {
      return { ...t, is_seed: true };
    }
    return t;
  });

  // When viewing a specific seed's stack, derive seed context from URL params
  // so the "via" line and modal always show the correct seed — not whatever
  // random seed the track might also be linked to.
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
              directTracks={sessionTracksWithSeedFlag as any}
              listTitle={seedName || genreFilter || "For You"}
              onTrackSelect={handleTrackSelect}
            />
          )}
        </div>

        {/* Track card — fills remaining space on mobile, centered on desktop */}
        <div className="flex-1 min-h-0 md:flex md:items-center md:justify-center">
          <TrackCard
            key={currentTrack.id}
            track={currentTrack}
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
        directTracks={currentEpisodeId ? undefined : (sessionTracksWithSeedFlag as any)}
        refreshKey={voteCount}
        seedId={fromSeedId}
        open={tracklistOpen}
        onClose={() => setTracklistOpen(false)}
        onTrackSelect={handleTrackSelect}
      />

      {/* Keyboard hint (desktop only) */}
      <div className="hidden md:flex justify-center gap-6 py-3 text-xs text-muted md:flex-shrink-0">
        <span>← / j skip</span>
        <span>→ / k keep</span>
        <span>space play/pause</span>
        <span>esc close</span>
      </div>

      {/* Track context modal */}
      {contextOpen && currentTrack && (
        <TrackContextModal
          track={currentTrack}
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
