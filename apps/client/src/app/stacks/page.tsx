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
  total_playable: number;
  total_processing: number;
  total_unavailable: number;
  cover_art_url: string | null;
  has_exact_match: boolean;
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hideLow, setHideLow] = useState(false);

  useEffect(() => {
    const stored = sessionStorage.getItem("stacks-hide-low-scored");
    if (stored === "1") setHideLow(true);
  }, []);

  const fetchData = () => {
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
        setGenres(genreData.genres || []);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      {/* TODO: radar-discovered shows should eventually get their own section/filter here,
          separate from seed-discovered stacks. e.g. a "Curator Radar" row showing
          high-affinity NTS/Lot Radio shows with pending tracks. */}

      {/* ─── FOR YOU ─────────────────────────── */}
      <button
        onClick={() => router.push("/?source=taste")}
        className="w-full mb-2 group relative rounded-2xl overflow-hidden transition-all duration-200 hover:scale-[1.01] hover:shadow-xl active:scale-[0.99]"
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
            <p className="text-xs text-white/40 mt-0.5">ranked by taste</p>
          </div>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white/40">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </div>
      </button>

      {/* ─── HIDE LOW-SCORED TOGGLE ───────────── */}
      <div className="flex items-center gap-2.5 mb-8 px-1">
        <button
          onClick={() => {
            const next = !hideLow;
            setHideLow(next);
            sessionStorage.setItem("stacks-hide-low-scored", next ? "1" : "0");
          }}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
            hideLow ? "bg-accent" : "bg-foreground/20"
          }`}
        >
          <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
            hideLow ? "translate-x-4.5" : "translate-x-0.5"
          }`} />
        </button>
        <span className="text-xs text-foreground/50">Hide low-scored</span>
      </div>

      {/* ─── GENRES ──────────────────────────── */}
      {genres.length > 0 && <GenreSection genres={genres} router={router} />}

      {/* ─── SEEDS ───────────────────────────── */}
      <div>
        <h2 className="text-sm font-semibold text-muted uppercase tracking-wider mb-3">Seeds</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {stacks.map((seed) => (
            <StackTile
              key={seed.id}
              seed={seed}
              onClick={() => {
                const params = new URLSearchParams();
                params.set("source", "ranked");
                params.set("seed_id", seed.id);
                params.set("seed_name", `${decodeEntities(seed.artist)} — ${decodeEntities(seed.title)}`);
                params.set("from", "stacks");
                router.push(`/?${params.toString()}`);
              }}
              onDetailClick={() => router.push(`/stacks/${seed.id}`)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

const GENRES_COLLAPSED = 8;

function GenreSection({ genres, router }: { genres: GenreEntry[]; router: ReturnType<typeof useRouter> }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? genres : genres.slice(0, GENRES_COLLAPSED);
  const hasMore = genres.length > GENRES_COLLAPSED;

  return (
    <div className="mb-8">
      <h2 className="text-sm font-semibold text-muted uppercase tracking-wider mb-3">Genres</h2>
      <div className="flex flex-wrap gap-2">
        {visible.map((g) => (
          <button
            key={g.genre}
            onClick={() => router.push(`/?source=genre&genre=${encodeURIComponent(g.genre)}`)}
            className="group flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-foreground/5 hover:bg-foreground/10 border border-foreground/10 hover:border-accent/30 transition-all duration-150 active:scale-95"
          >
            <span className="text-xs text-foreground/80 group-hover:text-foreground">{g.genre}</span>
            <span className="text-[10px] font-mono text-foreground/30">{g.pending}</span>
          </button>
        ))}
        {hasMore && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 px-3 py-1.5 rounded-full bg-accent/10 hover:bg-accent/20 border border-accent/20 hover:border-accent/40 transition-all duration-150 active:scale-95"
          >
            <span className="text-xs text-accent">
              {expanded ? "Show less" : `+${genres.length - GENRES_COLLAPSED} more`}
            </span>
          </button>
        )}
      </div>
    </div>
  );
}

function StackTile({
  seed,
  onClick,
  onDetailClick,
}: {
  seed: StackSeed;
  onClick: () => void;
  onDetailClick: () => void;
}) {
  const hue = hueFromString(`${seed.artist}-${seed.title}`);

  return (
    <button
      onClick={onClick}
      className="group relative aspect-square rounded-2xl overflow-hidden transition-all duration-200 hover:scale-[1.03] hover:shadow-xl active:scale-[0.98]"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={seed.cover_art_url || `https://api.dicebear.com/7.x/shapes/svg?seed=${encodeURIComponent(seed.artist)}`}
        alt=""
        className="absolute inset-0 w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
        style={seed.cover_art_url ? undefined : { filter: "brightness(0.4) saturate(1.2)" }}
      />

      <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/30 to-transparent" />

      {seed.total > 0 && (
        <div className="absolute top-2 right-2 bg-black/60 backdrop-blur-sm rounded-full px-2 py-0.5 flex items-center gap-1">
          <span className="text-[10px] font-mono font-semibold text-green-400">
            {seed.total_playable}/{seed.total}
          </span>
        </div>
      )}

      {/* Match type indicator */}
      <div className="absolute top-2 left-2">
        {seed.has_exact_match ? (
          <div className="w-2 h-2 rounded-full bg-green-400/80" title="Exact match found" />
        ) : (
          <div className="px-1.5 py-0.5 rounded bg-black/50 backdrop-blur-sm text-[8px] text-amber-400/80 leading-none" title="Artist-only match">
            artist
          </div>
        )}
      </div>

      <div className="absolute bottom-0 left-0 right-0 p-3">
        <p className="text-[13px] font-semibold text-white leading-tight line-clamp-2 drop-shadow-lg">
          {decodeEntities(seed.artist)}
        </p>
        <p className="text-[10px] text-white/50 truncate mt-0.5 drop-shadow">
          {decodeEntities(seed.title)}
        </p>
        {/* Stats: eps · playable/total · processing · unavailable */}
        <p className="text-[9px] font-mono mt-1 flex flex-wrap gap-x-1.5 items-center">
          <span className="text-white/30">{seed.episodes.length} eps</span>
          {seed.total > 0 && (
            <>
              <span className="text-white/20">·</span>
              <span className="text-green-400/70">{seed.total_playable}/{seed.total} playable</span>
            </>
          )}
          {seed.total_processing > 0 && (
            <>
              <span className="text-white/20">·</span>
              <span className="text-yellow-400/60">{seed.total_processing} ⏳</span>
            </>
          )}
          {seed.total_unavailable > 0 && (
            <>
              <span className="text-white/20">·</span>
              <span className="text-white/25">{seed.total_unavailable} ✗</span>
            </>
          )}
        </p>
        <div className="flex items-center gap-2 mt-0.5">
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); onDetailClick(); }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); onDetailClick(); } }}
            className="text-[9px] text-white/25 hover:text-white/60 font-mono ml-auto transition-colors cursor-pointer"
            title="Browse episodes"
          >
            eps →
          </span>
        </div>
      </div>
    </button>
  );
}
