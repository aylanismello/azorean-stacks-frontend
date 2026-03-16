"use client";

import { useState, useEffect, useCallback } from "react";
import { Seed, EpisodeTrack } from "@/lib/types";
import { SeedForm } from "@/components/SeedForm";
import { useAuth } from "@/components/AuthProvider";
import { isReseed } from "@/lib/seeds";
import { openYouTube } from "@/lib/youtube";

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
  const [discoverResult, setDiscoverResult] = useState<{ tracks_found: number } | null>(null);
  const [tab, setTab] = useState<"all" | "reseeds">("all");
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

  const handleAddSeed = async (input: string) => {
    try {
      const res = await fetch("/api/seeds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input }),
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

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/seeds/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete seed");
      setSeeds((prev) => prev.filter((s) => s.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete seed");
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

      {/* Enriching banner */}
      {enriching && (
        <div className="mb-4 p-3 bg-accent/10 border border-accent/20 rounded-lg text-sm text-accent flex items-center gap-2">
          <span className="w-3.5 h-3.5 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
          Finding tracks...
        </div>
      )}

      {discoverResult && (
        <div className="mb-4 p-3 bg-accent/10 border border-accent/20 rounded-lg text-sm text-accent flex items-center justify-between">
          <span>
            {discoverResult.tracks_found > 0
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
              onToggle={handleToggle}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SeedCard({
  seed,
  onToggle,
  onDelete,
}: {
  seed: Seed;
  onToggle: (id: string, active: boolean) => void;
  onDelete: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const episodes = seed.episodes || [];
  const lastRun = seed.last_run;
  const totalFound = (seed.discovery_count || 0) + episodes.length;
  const noMatches = lastRun && lastRun.tracks_found === 0 && episodes.length === 0;
  const isEnriching = seed.created_at &&
    (Date.now() - new Date(seed.created_at).getTime()) < 2 * 60 * 60 * 1000 &&
    totalFound === 0;

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
            {isEnriching && (
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
            <SeedEpisodeRow key={ep.id} episode={ep} seedArtist={seed.artist} seedTitle={seed.title} />
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
    </div>
  );
}

function SeedEpisodeRow({ episode: ep, seedArtist, seedTitle }: {
  episode: { id: string; title: string | null; url: string; source: string; aired_date: string | null; match_type: string; matched_tracks?: { artist: string; title: string }[] };
  seedArtist?: string;
  seedTitle?: string;
}) {
  const [open, setOpen] = useState(false);
  const [tracks, setTracks] = useState<EpisodeTrack[]>([]);
  const [loading, setLoading] = useState(false);

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

  const statusDot = (s: string) => {
    if (s === "approved") return "bg-green-500";
    if (s === "rejected") return "bg-red-500";
    if (s === "skipped") return "bg-amber-400";
    return "bg-surface-4";
  };

  const statusColor = (s: string) => {
    if (s === "approved") return "text-green-400";
    if (s === "rejected") return "text-red-400";
    if (s === "skipped") return "text-amber-400";
    return "text-muted";
  };

  return (
    <div className="border-b border-surface-3/50 last:border-b-0">
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
      </button>

      {/* Expanded: track list */}
      {open && (
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
            <div className="space-y-0.5">
              {tracks.map((t) => (
                <SeedTrackRow key={t.id} track={t} statusDot={statusDot} statusColor={statusColor} />
              ))}
            </div>
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
}: {
  track: EpisodeTrack;
  statusDot: (s: string) => string;
  statusColor: (s: string) => string;
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
      {local.cover_art_url ? (
        <img src={local.cover_art_url} alt="" className="w-5 h-5 rounded flex-shrink-0 object-cover" />
      ) : (
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${statusDot(local.status)}`} />
      )}
      <span className={`flex-1 min-w-0 truncate ${statusColor(local.status)}`}>
        {local.artist} — {local.title}
      </span>
      <div className="flex gap-1.5 flex-shrink-0 items-center">
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
        {t.spotify_url && (
          <a href={t.spotify_url} target="_blank" rel="noopener noreferrer" className="text-[9px] text-green-400/60 hover:text-green-400">
            SP
          </a>
        )}
        {t.youtube_url && (
          <button onClick={() => openYouTube(t.youtube_url!)} className="text-[9px] text-red-400/60 hover:text-red-400">
            YT
          </button>
        )}
      </div>
    </div>
  );
}
