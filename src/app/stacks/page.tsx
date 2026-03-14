"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

interface StackSeed {
  id: string;
  artist: string;
  title: string;
  active: boolean;
  episodes: { id: string; pending: number }[];
  total_pending: number;
  total_approved: number;
  total_rejected: number;
  total: number;
  cover_art_url: string | null;
}

interface GenreEntry {
  genre: string;
  pending: number;
}

function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#x27;/g, "'");
}

function hueFromString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash % 360);
}

export default function StacksPage() {
  const router = useRouter();
  const [stacks, setStacks] = useState<StackSeed[]>([]);
  const [genres, setGenres] = useState<GenreEntry[]>([]);
  const [totalPending, setTotalPending] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      fetch("/api/stacks").then((r) => {
        if (!r.ok) throw new Error(`Stacks: ${r.status}`);
        return r.json();
      }),
      fetch("/api/genres").then((r) => {
        if (!r.ok) throw new Error(`Genres: ${r.status}`);
        return r.json();
      }),
    ])
      .then(([stackData, genreData]) => {
        setStacks(stackData.stacks || []);
        setTotalPending(stackData.total_pending || 0);
        setGenres(genreData.genres || []);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="w-8 h-8 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center px-6">
        <p className="text-red-400 text-sm mb-3">{error}</p>
        <button
          onClick={() => window.location.reload()}
          className="text-xs text-accent hover:text-accent-bright transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="px-4 md:px-6 pt-4 md:pt-8 max-w-5xl mx-auto pb-24">
      {/* ─── FOR YOU ─────────────────────────── */}
      <button
        onClick={() => router.push("/?source=taste")}
        className="w-full mb-8 group relative rounded-2xl overflow-hidden transition-all duration-200 hover:scale-[1.01] hover:shadow-xl active:scale-[0.99]"
      >
        <div
          className="absolute inset-0"
          style={{
            background: "linear-gradient(135deg, hsl(220, 50%, 18%), hsl(280, 40%, 10%))",
          }}
        />
        <div className="relative px-5 py-6 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-white">For You</h2>
            <p className="text-xs text-white/40 mt-0.5">
              {totalPending} tracks, ranked by taste
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-2xl font-mono font-bold text-accent">{totalPending}</span>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white/40">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </div>
        </div>
      </button>

      {/* ─── GENRES ──────────────────────────── */}
      {genres.length > 0 && (
        <div className="mb-8">
          <h2 className="text-sm font-semibold text-muted uppercase tracking-wider mb-3">Genres</h2>
          <div className="flex flex-wrap gap-2">
            {genres.map((g) => (
              <button
                key={g.genre}
                onClick={() => router.push(`/?source=genre&genre=${encodeURIComponent(g.genre)}`)}
                className="group flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-foreground/5 hover:bg-foreground/10 border border-foreground/10 hover:border-accent/30 transition-all duration-150 active:scale-95"
              >
                <span className="text-xs text-foreground/80 group-hover:text-foreground">{g.genre}</span>
                <span className="text-[10px] font-mono text-foreground/30">{g.pending}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ─── SEEDS ───────────────────────────── */}
      <div>
        <h2 className="text-sm font-semibold text-muted uppercase tracking-wider mb-3">Seeds</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {stacks.map((seed) => (
            <StackTile key={seed.id} seed={seed} onClick={() => {
              const params = new URLSearchParams();
              params.set("source", "seed");
              params.set("seed_artist", seed.artist);
              params.set("seed_name", `${decodeEntities(seed.artist)} — ${decodeEntities(seed.title)}`);
              params.set("from", "stacks");
              params.set("seed_id", seed.id);
              router.push(`/?${params.toString()}`);
            }} />
          ))}
        </div>
      </div>
    </div>
  );
}

function StackTile({ seed, onClick }: { seed: StackSeed; onClick: () => void }) {
  const hue = hueFromString(`${seed.artist}-${seed.title}`);

  return (
    <button
      onClick={onClick}
      className="group relative aspect-square rounded-2xl overflow-hidden transition-all duration-200 hover:scale-[1.03] hover:shadow-xl active:scale-[0.98]"
    >
      {seed.cover_art_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={seed.cover_art_url}
          alt=""
          className="absolute inset-0 w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
        />
      ) : (
        <div
          className="absolute inset-0"
          style={{
            background: `radial-gradient(circle at 30% 30%,
              hsl(${hue}, 40%, 20%) 0%,
              hsl(${hue}, 35%, 12%) 40%,
              hsl(${hue}, 30%, 6%) 100%)`,
          }}
        />
      )}

      <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/30 to-transparent" />

      {seed.total_pending > 0 && (
        <div className="absolute top-2 right-2 bg-black/60 backdrop-blur-sm rounded-full px-2 py-0.5 flex items-center gap-1">
          <span className="text-[10px] font-mono font-semibold text-accent">
            {seed.total_pending}
          </span>
        </div>
      )}

      <div className="absolute bottom-0 left-0 right-0 p-3">
        <p className="text-[13px] font-semibold text-white leading-tight line-clamp-2 drop-shadow-lg">
          {decodeEntities(seed.artist)}
        </p>
        <p className="text-[10px] text-white/50 truncate mt-0.5 drop-shadow">
          {decodeEntities(seed.title)}
        </p>
        <div className="flex items-center gap-2 mt-1">
          <span className="text-[9px] text-white/30 font-mono">
            {seed.episodes.length} ep{seed.episodes.length !== 1 ? "s" : ""}
          </span>
          {seed.total_approved > 0 && (
            <span className="text-[9px] text-green-400/40 font-mono">
              {seed.total_approved} kept
            </span>
          )}
        </div>
      </div>
    </button>
  );
}
