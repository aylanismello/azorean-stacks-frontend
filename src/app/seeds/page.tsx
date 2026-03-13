"use client";

import { useState, useEffect, useCallback } from "react";
import { Seed } from "@/lib/types";
import { SeedForm } from "@/components/SeedForm";

export default function SeedsPage() {
  const [seeds, setSeeds] = useState<Seed[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  const handleAddSeed = async (artist: string, title: string) => {
    try {
      const res = await fetch("/api/seeds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ artist, title }),
      });
      if (!res.ok) throw new Error("Failed to add seed");
      fetchSeeds();
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

  return (
    <div className="px-4 md:px-6 pt-4 md:pt-8 max-w-2xl mx-auto pb-24">
      <h1 className="text-xl font-semibold mb-6">Seeds</h1>

      {/* Add seed form */}
      <div className="mb-8">
        <p className="text-sm text-muted mb-3">
          Add tracks as seeds — Pico uses these as starting points for discovery.
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
  const noMatches = lastRun && lastRun.tracks_found === 0;

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
          <p className="text-sm font-medium text-white truncate">
            {seed.artist}
          </p>
          <p className="text-xs text-white/60 truncate">{seed.title}</p>
          {/* Episode count hint */}
          {episodes.length > 0 && (
            <p className="text-[10px] text-muted mt-0.5">
              {episodes.length} episode{episodes.length !== 1 ? "s" : ""} {expanded ? "▾" : "▸"}
            </p>
          )}
        </button>

        {/* Discovery count + no-match warning */}
        <div className="text-right flex-shrink-0">
          <p className="text-sm font-mono text-accent">
            {seed.discovery_count || 0}
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

      {expanded && episodes.length === 0 && (
        <div className="border-t border-surface-3 px-4 py-3">
          <p className="text-[11px] text-muted/50">No episodes linked to this seed yet</p>
        </div>
      )}
    </div>
  );
}
