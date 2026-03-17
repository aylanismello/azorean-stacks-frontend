"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Seed, EpisodeTrack, PipelineStatus } from "@/lib/types";
import { SeedForm } from "@/components/SeedForm";
import { useAuth } from "@/components/AuthProvider";
import { isReseed } from "@/lib/seeds";
import { openYouTube } from "@/lib/youtube";
import { EpisodeTracklist } from "@/components/EpisodeTracklist";

// Decode common HTML entities that may be stored in DB from NTS/external APIs
function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/g, "'");
}

export default function SeedsPage() {
  const [seeds, setSeeds] = useState<Seed[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [enriching, setEnriching] = useState(false);
  const [enrichingLabel, setEnrichingLabel] = useState<string | null>(null);
  const [discoverResult, setDiscoverResult] = useState<{ tracks_found: number; message?: string } | null>(null);
  const [tab, setTab] = useState<"all" | "reseeds">("all");
  const [pendingDelete, setPendingDelete] = useState<{ id: string; artist: string; title: string } | null>(null);
  const { user } = useAuth();

  const fetchSeeds = useCallback(async () => {
    try {
      const res = await fetch("/api/seeds");
      if (!res.ok) throw new Error(`Failed to load seeds (${res.status})`);
      const data = await res.json();
      setSeeds(data || []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load seeds");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSeeds();
  }, [fetchSeeds]);

  // Adaptive polling: fast (3s) when any seed has an active pipeline, slow (30s) otherwise
  const [pollRate, setPollRate] = useState(30000);
  const pollRateRef = useRef(pollRate);
  pollRateRef.current = pollRate;

  useEffect(() => {
    const hasActive = seeds.some(
      (s) => s.pipeline_status?.state && !["done", "error"].includes(s.pipeline_status.state)
    );
    setPollRate(hasActive ? 3000 : 30000);
  }, [seeds]);

  useEffect(() => {
    const id = setInterval(fetchSeeds, pollRate);
    return () => clearInterval(id);
  }, [fetchSeeds, pollRate]);

  const handleAddSeed = async (input: string) => {
    const trimmed = input.trim();

    // Playlist import flow
    if (trimmed.includes("/playlist/")) {
      setEnriching(true);
      setEnrichingLabel("Importing playlist...");
      setDiscoverResult(null);
      try {
        const res = await fetch("/api/seeds/playlist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ playlist_url: trimmed }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          throw new Error(data?.error || "Failed to import playlist");
        }
        const result = await res.json();
        const msg = result.added > 0
          ? `Added ${result.added} seed${result.added !== 1 ? "s" : ""} from playlist${result.skipped > 0 ? ` (${result.skipped} already existed)` : ""}`
          : `All ${result.skipped} tracks already in your seeds`;
        setDiscoverResult({ tracks_found: result.added, message: msg });
        fetchSeeds();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to import playlist");
      } finally {
        setEnriching(false);
        setEnrichingLabel(null);
      }
      return;
    }

    // Single track flow (existing)
    try {
      const res = await fetch("/api/seeds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: trimmed }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || "Failed to add seed");
      }
      const seed = await res.json();
      fetchSeeds();

      // Trigger fast NTS track discovery, then engine enriches in background
      if (user?.id && seed?.id) {
        setEnriching(true);
        setEnrichingLabel(null);
        setDiscoverResult(null);
        try {
          const discoverRes = await fetch("/api/discover", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ seed_id: seed.id, user_id: user.id }),
          });
          if (discoverRes.ok) {
            const result = await discoverRes.json();
            setDiscoverResult({ tracks_found: result.tracks_found });
            fetchSeeds();
          }
        } catch {
          // Discovery failure is non-blocking — the engine will pick it up
        } finally {
          setEnriching(false);
          setEnrichingLabel(null);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add seed");
    }
  };

  const handleToggle = async (id: string, active: boolean) => {
    try {
      const res = await fetch(`/api/seeds/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !active }),
      });
      if (!res.ok) throw new Error("Failed to update seed");
      setSeeds((prev) =>
        prev.map((s) => (s.id === id ? { ...s, active: !active } : s))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update seed");
    }
  };

  const handleDelete = (id: string) => {
    const seed = seeds.find((s) => s.id === id);
    if (seed) setPendingDelete({ id, artist: seed.artist, title: seed.title });
  };

  const handleConfirmDelete = async () => {
    if (!pendingDelete) return;
    try {
      const res = await fetch(`/api/seeds/${pendingDelete.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete seed");
      setSeeds((prev) => prev.filter((s) => s.id !== pendingDelete.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete seed");
    } finally {
      setPendingDelete(null);
    }
  };

  const handleRemoveEpisode = async (seedId: string, episodeId: string) => {
    try {
      const res = await fetch(`/api/seeds?seed_id=${seedId}&episode_id=${episodeId}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to remove episode");
      setSeeds((prev) =>
        prev.map((s) =>
          s.id === seedId
            ? { ...s, episodes: (s.episodes || []).filter((ep) => ep.id !== episodeId) }
            : s
        )
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove episode");
    }
  };

  const reseeds = seeds.filter(isReseed);
  const displaySeeds = tab === "reseeds" ? reseeds : seeds;

  return (
    <div className="px-4 md:px-6 pt-4 md:pt-8 max-w-2xl md:max-w-3xl mx-auto pb-24">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold">Seeds</h1>
      </div>

      {/* Tabs: All / Re-seeds */}
      <div className="flex items-center gap-1 mb-6 bg-surface-2 rounded-lg p-1 w-fit">
        <button
          onClick={() => setTab("all")}
          className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
            tab === "all" ? "bg-surface-1 text-foreground shadow-sm" : "text-muted hover:text-foreground"
          }`}
        >
          All ({seeds.length})
        </button>
        <button
          onClick={() => setTab("reseeds")}
          className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
            tab === "reseeds" ? "bg-surface-1 text-foreground shadow-sm" : "text-muted hover:text-foreground"
          }`}
        >
          Re-seeds ({reseeds.length})
        </button>
      </div>

      {/* Enriching / importing banner */}
      {enriching && (
        <div className="mb-4 p-3 bg-accent/10 border border-accent/20 rounded-lg text-sm text-accent flex items-center gap-2">
          <span className="w-3.5 h-3.5 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
          {enrichingLabel ?? "Finding tracks..."}
        </div>
      )}

      {discoverResult && (
        <div className="mb-4 p-3 bg-accent/10 border border-accent/20 rounded-lg text-sm text-accent flex items-center justify-between">
          <span>
            {discoverResult.message
              ? discoverResult.message
              : discoverResult.tracks_found > 0
              ? `Found ${discoverResult.tracks_found} tracks — Pico is enriching them in the background`
              : "No tracks found yet — engine will pick this up shortly"}
          </span>
          <button onClick={() => setDiscoverResult(null)} className="text-accent/60 hover:text-accent">
            ✕
          </button>
        </div>
      )}

      {/* Add seed form */}
      <div className="mb-8">
        <p className="text-sm text-muted mb-3">
          Add tracks as seeds — the agent uses these for discovery.
        </p>
        <SeedForm onSubmit={handleAddSeed} />
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
      ) : displaySeeds.length === 0 ? (
        <div className="text-center py-12 text-muted text-sm">
          {tab === "reseeds" ? "No re-seeded tracks yet. Plant seeds from tracks you discover!" : "No seeds yet. Add a track above to get started."}
        </div>
      ) : (
        <div className="space-y-2">
          {displaySeeds.map((seed) => (
            <SeedCard
              key={seed.id}
              seed={seed}
              allSeeds={seeds}
              onToggle={handleToggle}
              onDelete={handleDelete}
              onRemoveEpisode={handleRemoveEpisode}
              onRefresh={fetchSeeds}
            />
          ))}
        </div>
      )}

      {/* Delete confirmation modal */}
      {pendingDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setPendingDelete(null)}
        >
          <div
            className="bg-surface-1 border border-surface-3 rounded-xl p-5 mx-4 max-w-sm w-full shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-sm font-medium text-foreground mb-1">Delete seed?</p>
            <p className="text-xs text-muted mb-4">
              {decodeEntities(pendingDelete.artist)} — {decodeEntities(pendingDelete.title)}
              <br />
              <span className="text-muted/60">This will stop discovery for this track.</span>
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setPendingDelete(null)}
                className="px-3 py-1.5 text-sm rounded-lg bg-surface-2 text-muted hover:text-foreground transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmDelete}
                className="px-3 py-1.5 text-sm rounded-lg bg-red-500/15 text-red-400 hover:bg-red-500/25 transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PipelineStatusBar({ status }: { status: PipelineStatus }) {
  const [showLog, setShowLog] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (showLog && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [showLog, status.log]);

  // "done" only shows if completed within the last 10s
  if (status.state === "done") {
    if (!status.completed_at) return null;
    const age = Date.now() - new Date(status.completed_at).getTime();
    if (age > 10000) return null;
    return (
      <div className="px-4 pb-2 flex items-center gap-1.5">
        <span className="text-green-400">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
        </span>
        <span className="text-[10px] text-green-400">Pipeline complete</span>
      </div>
    );
  }

  const stateDisplay: Record<string, { label: string; indicator: React.ReactNode }> = {
    queued: {
      label: "Queued...",
      indicator: <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse flex-shrink-0" />,
    },
    discovering: {
      label: "Discovering episodes...",
      indicator: (
        <svg className="animate-spin flex-shrink-0" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
      ),
    },
    enriching: {
      label: status.progress ? `Enriching ${status.progress}...` : "Enriching...",
      indicator: (
        <svg className="animate-spin flex-shrink-0" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
      ),
    },
    downloading: {
      label: status.progress ? `Downloading ${status.progress}...` : "Downloading...",
      indicator: (
        <svg className="animate-spin flex-shrink-0" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
      ),
    },
    error: {
      label: status.error || "Pipeline error",
      indicator: <span className="w-1.5 h-1.5 rounded-full bg-red-400 flex-shrink-0" />,
    },
  };

  const display = stateDisplay[status.state];
  if (!display) return null;

  const isError = status.state === "error";
  const textColor = isError ? "text-red-400" : status.state === "queued" ? "text-amber-400" : "text-muted";

  return (
    <div className="px-4 pb-2">
      <div className="flex items-center gap-1.5">
        <span className={textColor}>{display.indicator}</span>
        <span className={`text-[10px] ${textColor} flex-1 min-w-0 truncate`}>{display.label}</span>
        {status.log && status.log.length > 0 && (
          <button
            onClick={() => setShowLog(!showLog)}
            className="text-[9px] text-muted/40 hover:text-muted transition-colors flex-shrink-0"
          >
            {showLog ? "hide log" : "show log"}
          </button>
        )}
      </div>
      {showLog && status.log && status.log.length > 0 && (
        <div
          ref={logRef}
          className="mt-1.5 max-h-24 overflow-y-auto rounded bg-surface-2/60 p-2 font-mono"
        >
          {status.log.map((entry, i) => (
            <div key={i} className="text-[9px] text-muted/70 leading-relaxed">
              <span className="text-muted/40">{entry.t}</span>{" "}
              <span>{entry.msg}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SeedCard({
  seed,
  allSeeds,
  onToggle,
  onDelete,
  onRemoveEpisode,
  onRefresh,
}: {
  seed: Seed;
  allSeeds: Seed[];
  onToggle: (id: string, active: boolean) => void;
  onDelete: (id: string) => void;
  onRemoveEpisode: (seedId: string, episodeId: string) => void;
  onRefresh: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const episodes = seed.episodes || [];
  const lastRun = seed.last_run;
  const totalFound = (seed.discovery_count || 0) + episodes.length;
  const noMatches = lastRun && lastRun.tracks_found === 0 && episodes.length === 0;
  const isEnriching = seed.created_at &&
    (Date.now() - new Date(seed.created_at).getTime()) < 2 * 60 * 60 * 1000 &&
    totalFound === 0;
  const ps = seed.pipeline_status;
  const hasPipelineActivity = ps && ps.state !== null;

  return (
    <div
      className={`rounded-xl transition-colors ${
        seed.active ? "bg-surface-1" : "bg-surface-1/50 opacity-60"
      }`}
    >
      {/* Main row */}
      <div className="flex items-center gap-4 p-4">
        {/* Active indicator */}
        <button
          onClick={() => onToggle(seed.id, seed.active)}
          className={`w-3 h-3 rounded-full flex-shrink-0 transition-colors ${
            seed.active ? "bg-accent" : "bg-surface-4"
          }`}
          title={seed.active ? "Active — click to deactivate" : "Inactive — click to activate"}
        />

        {/* Info — clickable to expand */}
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex-1 min-w-0 text-left"
        >
          <div className="flex items-center gap-1.5">
            <p className="text-sm font-medium text-foreground truncate">
              {decodeEntities(seed.artist)}
            </p>
            {isReseed(seed) && (
              <span className="flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/20" title="Planted from discovery">
                🌱 re-seed
              </span>
            )}
            {isEnriching && !hasPipelineActivity && (
              <span className="flex-shrink-0 flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/20" title="Pico is enriching this seed">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                enriching
              </span>
            )}
          </div>
          <p className="text-xs text-foreground/60 truncate">{decodeEntities(seed.title)}</p>
          {/* Episode count hint */}
          {episodes.length > 0 && (
            <p className="text-[10px] text-muted mt-0.5">
              {seed.curated_count || 0}/{episodes.length} curated {expanded ? "▾" : "▸"}
            </p>
          )}
        </button>

        {/* Discovery count + no-match warning */}
        <div className="text-right flex-shrink-0">
          <p className="text-sm font-mono text-accent">
            {totalFound}
          </p>
          <p className="text-[10px] text-muted">found</p>
          {noMatches && (
            <p className="text-[10px] text-amber-400 mt-0.5" title="Last pipeline run found no matching episodes for this seed">
              no matches
            </p>
          )}
        </div>

        {/* Delete */}
        <button
          onClick={() => onDelete(seed.id)}
          className="p-1.5 text-muted hover:text-red-400 transition-colors text-xs"
          title="Remove seed"
        >
          ✕
        </button>
      </div>

      {/* Pipeline status bar */}
      {hasPipelineActivity && <PipelineStatusBar status={ps!} />}

      {/* No-match banner */}
      {noMatches && seed.active && (
        <div className="mx-4 mb-3 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-[11px] text-amber-400">
          Last run ({new Date(lastRun.started_at).toLocaleDateString()}) found no episodes — consider deactivating or removing this seed.
        </div>
      )}

      {/* Expanded: related episodes */}
      {expanded && episodes.length > 0 && (
        <div className="border-t border-surface-3 px-4 py-3 space-y-0">
          <p className="text-[10px] text-muted uppercase tracking-wider mb-2">Related Episodes</p>
          {[...episodes].sort((a, b) => {
            if (a.match_type === "full" && b.match_type !== "full") return -1;
            if (a.match_type !== "full" && b.match_type === "full") return 1;
            return 0;
          }).map((ep) => (
            <SeedEpisodeRow
              key={ep.id}
              episode={ep}
              seedId={seed.id}
              seedArtist={seed.artist}
              seedTitle={seed.title}
              allSeeds={allSeeds}
              onRemove={onRemoveEpisode}
              onRefresh={onRefresh}
            />
          ))}
        </div>
      )}

      {expanded && isReseed(seed) && (
        <div className="border-t border-surface-3 px-4 py-3">
          <p className="text-[10px] text-emerald-400/60 italic">
            🌱 Planted from discovery — exploration begets exploration
          </p>
        </div>
      )}

      {expanded && episodes.length === 0 && !seed.source && (
        <div className="border-t border-surface-3 px-4 py-3">
          <p className="text-[11px] text-muted/50">No episodes linked to this seed yet</p>
        </div>
      )}

      {/* Aggregate stats */}
      {seed.stats && (seed.stats.tracks > 0 || seed.stats.episodes > 0) && (
        <div className="border-t border-surface-3/50 px-4 py-2">
          <p className="text-[10px] text-muted/50">
            {seed.stats.episodes} episode{seed.stats.episodes !== 1 ? "s" : ""} · {seed.stats.tracks} track{seed.stats.tracks !== 1 ? "s" : ""} · {seed.stats.enriched} enriched · {seed.stats.downloaded} downloaded
          </p>
        </div>
      )}
    </div>
  );
}

function EnrichmentStatusIcon({ trackCount, enrichedCount }: { trackCount: number; enrichedCount: number }) {
  if (trackCount === 0) return null;
  if (enrichedCount === trackCount) {
    return (
      <span className="text-green-400" title="All tracks have audio">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </span>
    );
  }
  if (enrichedCount > 0) {
    return (
      <span className="text-amber-400 text-[9px]" title={`${enrichedCount}/${trackCount} tracks have audio`}>
        {enrichedCount}/{trackCount}
      </span>
    );
  }
  return (
    <span className="text-muted/40" title="No tracks have audio yet">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    </span>
  );
}

function SeedEpisodeRow({ episode: ep, seedId, seedArtist, seedTitle, allSeeds, onRemove, onRefresh }: {
  episode: { id: string; title: string | null; url: string; source: string; aired_date: string | null; match_type: string; matched_tracks?: { artist: string; title: string }[]; track_count?: number; enriched_count?: number };
  seedId: string;
  seedArtist?: string;
  seedTitle?: string;
  allSeeds?: Seed[];
  onRemove: (seedId: string, episodeId: string) => void;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [tracks, setTracks] = useState<EpisodeTrack[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshed, setRefreshed] = useState(false);
  const [pendingRemove, setPendingRemove] = useState(false);

  const handleToggle = async () => {
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (tracks.length > 0) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/episodes/${ep.id}/tracks`);
      if (res.ok) setTracks(await res.json());
    } finally {
      setLoading(false);
    }
  };

  const handleRefresh = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (refreshing) return;
    setRefreshing(true);
    setRefreshed(false);
    try {
      await fetch("/api/commands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "enrich_episode", payload: { episode_id: ep.id } }),
      });
      setRefreshed(true);
      setTimeout(() => setRefreshed(false), 2000);
    } catch {
      // non-blocking
    } finally {
      setRefreshing(false);
    }
  };

  const handleRemoveClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setPendingRemove(true);
  };

  const handleConfirmRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    setPendingRemove(false);
    onRemove(seedId, ep.id);
  };

  const handleCancelRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    setPendingRemove(false);
  };

  const trackCount = ep.track_count ?? 0;
  const enrichedCount = ep.enriched_count ?? 0;

  return (
    <div className="border-b border-surface-3/50 last:border-b-0">
      {/* Remove confirm inline */}
      {pendingRemove ? (
        <div className="py-2.5 px-1 flex items-center gap-2">
          <p className="text-[11px] text-muted flex-1">Remove this episode from the seed?</p>
          <button
            onClick={handleCancelRemove}
            className="text-[10px] px-2 py-0.5 rounded bg-surface-2 text-muted hover:text-foreground transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirmRemove}
            className="text-[10px] px-2 py-0.5 rounded bg-red-500/15 text-red-400 hover:bg-red-500/25 transition-colors"
          >
            Remove
          </button>
        </div>
      ) : (
        <button
          onClick={handleToggle}
          className="w-full text-left py-2.5 hover:bg-surface-2/30 transition-colors rounded-lg px-1 -mx-1"
        >
          {/* Badges row */}
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-2 text-muted uppercase tracking-wider flex-shrink-0">
              {ep.source}
            </span>
            <span className={`text-[9px] px-1 py-0.5 rounded flex-shrink-0 ${
              ep.match_type === "full"
                ? "bg-accent/15 text-accent"
                : "bg-amber-500/15 text-amber-400"
            }`}>
              {ep.match_type === "full" ? "exact" : seedTitle ? `via ${decodeEntities(seedTitle)}` : "artist only"}
            </span>
            {ep.aired_date && (
              <span className="text-[10px] text-muted flex-shrink-0">
                {ep.aired_date}
              </span>
            )}
            <div className="flex-1" />
            {/* Enrichment status icon */}
            <EnrichmentStatusIcon trackCount={trackCount} enrichedCount={enrichedCount} />
            {/* Refresh button */}
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              className={`p-0.5 rounded transition-all ${
                refreshed
                  ? "text-green-400"
                  : refreshing
                  ? "text-muted/40 animate-spin"
                  : "text-muted/40 hover:text-amber-400 hover:bg-surface-3"
              }`}
              title="Re-enrich this episode"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
                <path d="M21 3v5h-5" />
                <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
                <path d="M8 16H3v5" />
              </svg>
            </button>
            {/* Remove episode button */}
            <button
              onClick={handleRemoveClick}
              className="p-0.5 rounded text-muted/30 hover:text-red-400 hover:bg-surface-3 transition-colors"
              title="Remove episode from this seed"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
            <span className="text-muted text-xs">{open ? "▾" : "▸"}</span>
          </div>
          {/* Title */}
          <p className="text-sm text-foreground/80 leading-snug">
            {ep.title || ep.url}
          </p>
          {ep.match_type !== "full" && ep.matched_tracks && ep.matched_tracks.length > 0 && (
            <p className="text-[10px] text-amber-400/60 mt-0.5 truncate">
              found: {ep.matched_tracks.map((t) => t.title).join(", ")}
            </p>
          )}
          {/* Enrichment count summary */}
          {trackCount > 0 && (
            <div className="flex items-center gap-1.5 mt-1">
              <span className="text-[10px] text-muted">
                {trackCount} track{trackCount !== 1 ? "s" : ""}
              </span>
              {enrichedCount === trackCount ? (
                <span className="text-[10px] text-green-400" title="All tracks have audio">✓ all enriched</span>
              ) : enrichedCount > 0 ? (
                <span className="text-[10px] text-amber-400" title={`${enrichedCount}/${trackCount} tracks have audio`}>
                  {enrichedCount}/{trackCount} enriched
                </span>
              ) : (
                <span className="text-[10px] text-muted/50">none enriched</span>
              )}
            </div>
          )}
        </button>
      )}

      {/* Expanded: track list */}
      {open && !pendingRemove && (
        <div className="pl-2 pr-1 pb-3">
          {/* Action buttons */}
          <div className="flex items-center gap-2 mb-2">
            <a
              href={ep.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] px-2.5 py-1 rounded-full bg-surface-2 text-accent hover:bg-surface-3 transition-colors"
            >
              Open on {ep.source === "nts" ? "NTS" : ep.source} ↗
            </a>
            <a
              href={`/?episode_id=${ep.id}&episode_title=${encodeURIComponent(ep.title || ep.url)}`}
              className="text-[10px] px-2.5 py-1 rounded-full bg-accent/15 text-accent hover:bg-accent/25 transition-colors font-medium"
            >
              Swipe →
            </a>
          </div>

          {loading ? (
            <div className="flex justify-center py-3">
              <div className="w-3.5 h-3.5 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
            </div>
          ) : tracks.length === 0 ? (
            <p className="text-[10px] text-muted/50 py-1">No tracks</p>
          ) : (
            <EpisodeTracklist
              directTracks={tracks as any}
              variant="sheet"
            />
          )}
        </div>
      )}
    </div>
  );
}

function SeedTrackRow({
  track: t,
  statusDot,
  statusColor,
  isSeedTrack = false,
  isReseedTrack = false,
}: {
  track: EpisodeTrack;
  statusDot: (s: string) => string;
  statusColor: (s: string) => string;
  isSeedTrack?: boolean;
  isReseedTrack?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [local, setLocal] = useState(t);
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
      const res = await fetch(`/api/tracks/${local.id}/download`, { method: "POST" });
      if (!res.ok) {
        setLocal({ ...local, dl_failed_at: new Date().toISOString(), dl_attempts: (local.dl_attempts || 0) + 1 });
      } else {
        const data = await res.json();
        setLocal({ ...local, storage_path: data.storage_path || "fetched", dl_failed_at: null, dl_attempts: 0 });
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

  const showFetch = !local.storage_path && local.youtube_url;
  const fetchFailed = !!local.dl_failed_at;

  return (
    <div className="flex items-center gap-2 py-1 text-[13px]">
      {isSeedTrack ? (
        <span className="flex-shrink-0 text-sm leading-none">🌱</span>
      ) : local.cover_art_url ? (
        <img src={local.cover_art_url} alt="" className="w-5 h-5 rounded flex-shrink-0 object-cover" />
      ) : (
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${statusDot(local.status)}`} />
      )}
      <span className={`flex-1 min-w-0 truncate ${statusColor(local.status)}`}>
        {local.artist} — {local.title}{isReseedTrack ? " 🌱++" : ""}
      </span>
      <div className="flex gap-1.5 flex-shrink-0 items-center">
        {/* Spotify icon */}
        <span
          title={local.spotify_url ? "On Spotify" : "Not on Spotify"}
          className={local.spotify_url ? "text-green-400" : "text-muted/25"}
        >
          {local.spotify_url ? (
            <a href={local.spotify_url} target="_blank" rel="noopener noreferrer">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm4.586 14.424a.622.622 0 0 1-.857.207c-2.348-1.435-5.304-1.76-8.785-.964a.622.622 0 1 1-.277-1.215c3.809-.87 7.076-.496 9.712 1.115a.623.623 0 0 1 .207.857zm1.224-2.723a.78.78 0 0 1-1.072.257c-2.687-1.652-6.785-2.131-9.965-1.166a.78.78 0 0 1-.973-.519.781.781 0 0 1 .519-.972c3.632-1.102 8.147-.568 11.234 1.328a.78.78 0 0 1 .257 1.072zm.105-2.835C14.692 9.15 9.375 8.977 6.297 9.9a.937.937 0 0 1-.583-1.782c3.532-1.157 9.404-.933 13.115 1.338a.937.937 0 0 1-.914 1.63z"/>
              </svg>
            </a>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm4.586 14.424a.622.622 0 0 1-.857.207c-2.348-1.435-5.304-1.76-8.785-.964a.622.622 0 1 1-.277-1.215c3.809-.87 7.076-.496 9.712 1.115a.623.623 0 0 1 .207.857zm1.224-2.723a.78.78 0 0 1-1.072.257c-2.687-1.652-6.785-2.131-9.965-1.166a.78.78 0 0 1-.973-.519.781.781 0 0 1 .519-.972c3.632-1.102 8.147-.568 11.234 1.328a.78.78 0 0 1 .257 1.072zm.105-2.835C14.692 9.15 9.375 8.977 6.297 9.9a.937.937 0 0 1-.583-1.782c3.532-1.157 9.404-.933 13.115 1.338a.937.937 0 0 1-.914 1.63z"/>
            </svg>
          )}
        </span>
        {/* YouTube icon */}
        <span
          title={local.youtube_url ? "On YouTube" : "Not on YouTube"}
          className={local.youtube_url ? "text-red-400" : "text-muted/25"}
        >
          {local.youtube_url ? (
            <button onClick={() => openYouTube(local.youtube_url!)}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
              </svg>
            </button>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
            </svg>
          )}
        </span>
        {/* Download/storage icon */}
        <span
          title={local.storage_path ? "Audio downloaded" : "No audio"}
          className={local.storage_path ? "text-blue-400" : "text-muted/25"}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </span>
        {showFetch && (
          <button
            onClick={handleFetchAudio}
            disabled={fetching || fetchFailed}
            className={`p-0.5 rounded transition-all ${
              fetchFailed ? "text-muted/20 cursor-not-allowed"
                : fetching ? "text-muted/50 animate-pulse"
                : "text-muted/50 hover:text-accent hover:bg-surface-3"
            }`}
            title={fetchFailed ? "Audio not found" : "Fetch audio"}
          >
            {fetching ? (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="animate-spin"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
            ) : (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
            )}
          </button>
        )}
        <button
          onClick={handleCopy}
          className="p-0.5 rounded hover:bg-surface-3 active:scale-90 transition-all"
          title="Copy artist - title"
        >
          {copied ? (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-muted/50 hover:text-muted">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          )}
        </button>
        <button
          onClick={handleToggleSeed}
          disabled={seeding}
          className={`text-[9px] transition-colors ${
            seeded
              ? "text-emerald-400 hover:text-emerald-300"
              : "text-muted/40 hover:text-emerald-400"
          } disabled:opacity-50`}
          title={seeded ? "Remove seed" : "Plant as seed"}
        >
          {seeding ? "·" : "SD"}
        </button>
      </div>
    </div>
  );
}
