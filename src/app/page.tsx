"use client";

import { useState, useEffect, useCallback } from "react";
import { Track } from "@/lib/types";
import { TrackCard } from "@/components/TrackCard";

export default function StackPage() {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const fetchTracks = useCallback(async () => {
    try {
      const res = await fetch("/api/tracks?status=pending&limit=20");
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
  }, []);

  useEffect(() => {
    fetchTracks();
  }, [fetchTracks]);

  const handleVote = async (id: string, status: "approved" | "rejected") => {
    try {
      const res = await fetch(`/api/tracks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error(`Vote failed (${res.status})`);

      setTracks((prev) => {
        const remaining = prev.filter((t) => t.id !== id);

        // Refetch when running low
        if (remaining.length <= 3) {
          const votedId = id;
          const existingIds = new Set(remaining.map((t) => t.id));
          fetch("/api/tracks?status=pending&limit=20")
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

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (tracks.length === 0) return;
      // Don't trigger shortcuts when typing in inputs
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "ArrowLeft" || e.key === "j") {
        handleVote(tracks[0].id, "rejected");
      } else if (e.key === "ArrowRight" || e.key === "k") {
        handleVote(tracks[0].id, "approved");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[80vh]">
        <div className="w-8 h-8 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
      </div>
    );
  }

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

  if (tracks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[80vh] px-6 text-center">
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
          No tracks waiting right now. New discoveries will appear here when the
          agent finds something.
        </p>
        <button
          onClick={fetchTracks}
          className="mt-6 px-5 py-2 text-sm bg-surface-2 hover:bg-surface-3 rounded-lg text-muted hover:text-white transition-colors"
        >
          Refresh
        </button>
      </div>
    );
  }

  return (
    <div className="px-4 pt-4 md:pt-8">
      {/* Counter */}
      <div className="text-center mb-6">
        <span className="text-sm text-muted font-mono">
          {total} track{total !== 1 ? "s" : ""} waiting
        </span>
      </div>

      {/* Current card */}
      <TrackCard key={tracks[0].id} track={tracks[0]} onVote={handleVote} />

      {/* Keyboard hint (desktop only) */}
      <div className="hidden md:flex justify-center gap-6 mt-6 text-xs text-muted">
        <span>← / j to skip</span>
        <span>→ / k to keep</span>
      </div>
    </div>
  );
}
