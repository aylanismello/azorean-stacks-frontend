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
    <div className="px-4 md:px-6 pt-4 md:pt-8 max-w-2xl mx-auto">
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
            <div
              key={seed.id}
              className={`flex items-center gap-4 p-4 rounded-xl transition-colors ${
                seed.active
                  ? "bg-surface-1"
                  : "bg-surface-1/50 opacity-60"
              }`}
            >
              {/* Active indicator */}
              <button
                onClick={() => handleToggle(seed.id, seed.active)}
                className={`w-3 h-3 rounded-full flex-shrink-0 transition-colors ${
                  seed.active ? "bg-accent" : "bg-surface-4"
                }`}
                title={seed.active ? "Active — click to deactivate" : "Inactive — click to activate"}
              />

              {/* Info */}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-white truncate">
                  {seed.artist}
                </p>
                <p className="text-xs text-white/60 truncate">{seed.title}</p>
              </div>

              {/* Discovery count */}
              <div className="text-right flex-shrink-0">
                <p className="text-sm font-mono text-accent">
                  {seed.discovery_count || 0}
                </p>
                <p className="text-[10px] text-muted">found</p>
              </div>

              {/* Delete */}
              <button
                onClick={() => handleDelete(seed.id)}
                className="p-1.5 text-muted hover:text-red-400 transition-colors text-xs"
                title="Remove seed"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
