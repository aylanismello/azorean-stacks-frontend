"use client";

import { useState, useEffect, useCallback } from "react";
import { Seed } from "@/lib/types";
import { SeedForm } from "@/components/SeedForm";
import { useSpotify } from "@/components/SpotifyProvider";
import { useAuth } from "@/components/AuthProvider";

export default function SeedsPage() {
  const [seeds, setSeeds] = useState<Seed[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{ synced: number; playlist_url: string | null } | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoverResult, setDiscoverResult] = useState<{ tracks_found: number; tracks_new: number } | null>(null);
  const { connected: spotifyConnected } = useSpotify();
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

      // Trigger on-demand discovery in the background
      if (user?.id && seed?.id) {
        setDiscovering(true);
        setDiscoverResult(null);
        try {
          const discoverRes = await fetch("/api/discover", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ seed_id: seed.id, user_id: user.id }),
          });
          if (discoverRes.ok) {
            const result = await discoverRes.json();
            if (result.tracks_found > 0) {
              setDiscoverResult({ tracks_found: result.tracks_found, tracks_new: result.tracks_new });
            }
            fetchSeeds(); // Refresh to show updated discovery counts
          }
        } catch {
          // Discovery failure is non-blocking — the background engine will pick it up
        } finally {
          setDiscovering(false);
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

  return (
    <div className="px-4 md:px-6 pt-4 md:pt-8 max-w-2xl mx-auto pb-24">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold">Seeds</h1>
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
              "Sync to Spotify"
            )}
          </button>
        )}
      </div>

      {syncResult && (
        <div className="mb-4 p-3 bg-[#1DB954]/10 border border-[#1DB954]/20 rounded-lg text-sm text-[#1DB954] flex items-center justify-between">
          <span>Synced {syncResult.synced} tracks to Spotify</span>
          <div className="flex items-center gap-2">
            {syncResult.playlist_url && (
              <a
                href={syncResult.playlist_url}
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:no-underline"
              >
                Open playlist
              </a>
            )}
            <button onClick={() => setSyncResult(null)} className="text-[#1DB954]/60 hover:text-[#1DB954]">
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Discovering banner */}
      {discovering && (
        <div className="mb-4 p-3 bg-accent/10 border border-accent/20 rounded-lg text-sm text-accent flex items-center gap-2">
          <span className="w-3.5 h-3.5 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
          Discovering tracks...
        </div>
      )}

      {discoverResult && (
        <div className="mb-4 p-3 bg-accent/10 border border-accent/20 rounded-lg text-sm text-accent flex items-center justify-between">
          <span>
            Found {discoverResult.tracks_found} tracks ({discoverResult.tracks_new} new)
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
      ) : seeds.length === 0 ? (
        <div className="text-center py-12 text-muted text-sm">
          No seeds yet. Add a track above to get started.
        </div>
      ) : (
        <div className="space-y-2">
          {seeds.map((seed) => (
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
            <p className="text-sm font-medium text-white truncate">
              {seed.artist}
            </p>
            {seed.source === "re-seed" && (
              <span className="flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/20" title="Planted from discovery">
                🌱 re-seed
              </span>
            )}
          </div>
          <p className="text-xs text-white/60 truncate">{seed.title}</p>
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
        <div className="border-t border-surface-3 px-4 py-3 space-y-1.5">
          <p className="text-[10px] text-muted uppercase tracking-wider mb-2">Related Episodes</p>
          {episodes.map((ep) => (
            <div
              key={ep.id}
              className="flex items-center gap-2 py-1.5 text-sm"
            >
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-2 text-muted uppercase tracking-wider flex-shrink-0">
                {ep.source}
              </span>
              <span className={`text-[9px] px-1 py-0.5 rounded flex-shrink-0 ${
                ep.match_type === "full"
                  ? "bg-accent/15 text-accent"
                  : "bg-amber-500/15 text-amber-400"
              }`}>
                {ep.match_type === "full" ? "exact" : "artist only"}
              </span>
              <a
                href={ep.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-white/80 truncate flex-1 min-w-0 hover:text-white transition-colors"
              >
                {ep.title || ep.url}
              </a>
              {ep.aired_date && (
                <span className="text-[10px] text-muted flex-shrink-0">
                  {ep.aired_date}
                </span>
              )}
              <a
                href={`/?episode_id=${ep.id}&episode_title=${encodeURIComponent(ep.title || ep.url)}`}
                className="text-[10px] px-2 py-0.5 rounded-full bg-accent/10 text-accent hover:bg-accent/20 transition-colors flex-shrink-0"
              >
                Swipe →
              </a>
            </div>
          ))}
        </div>
      )}

      {expanded && seed.source === "re-seed" && (
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
