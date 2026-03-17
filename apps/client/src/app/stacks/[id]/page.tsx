"use client";

import { useState, useEffect } from "react";
import { useRouter, useParams } from "next/navigation";

interface StackEpisode {
  id: string;
  title: string | null;
  source: string;
  aired_date: string | null;
  match_type: string;
  pending: number;
  approved: number;
  rejected: number;
  total: number;
  cover_art_url: string | null;
  matched_tracks: { artist: string; title: string }[];
}

interface StackSeed {
  id: string;
  artist: string;
  title: string;
  active: boolean;
  episodes: StackEpisode[];
  total_pending: number;
  total_approved: number;
  total_rejected: number;
  total: number;
  cover_art_url: string | null;
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

function VinylDisc({ hue, size = 48 }: { hue: number; size?: number }) {
  return (
    <div
      className="rounded-full flex-shrink-0 relative overflow-hidden"
      style={{
        width: size,
        height: size,
        background: `radial-gradient(circle at 50% 50%,
          hsl(${hue}, 30%, 8%) 0%,
          hsl(${hue}, 40%, 12%) 20%,
          hsl(${hue}, 35%, 8%) 22%,
          hsl(${hue}, 45%, 15%) 40%,
          hsl(${hue}, 35%, 10%) 42%,
          hsl(${hue}, 50%, 18%) 60%,
          hsl(${hue}, 40%, 10%) 62%,
          hsl(${hue}, 45%, 14%) 80%,
          hsl(${hue}, 30%, 6%) 100%)`,
      }}
    >
      <div
        className="absolute rounded-full"
        style={{
          width: size * 0.35,
          height: size * 0.35,
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          background: `hsl(${hue}, 50%, 40%)`,
        }}
      />
      <div
        className="absolute rounded-full bg-surface-0"
        style={{
          width: size * 0.08,
          height: size * 0.08,
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
        }}
      />
    </div>
  );
}

function ProgressBar({ episode }: { episode: StackEpisode }) {
  if (episode.total === 0) return null;
  const approvedPct = (episode.approved / episode.total) * 100;
  const rejectedPct = (episode.rejected / episode.total) * 100;

  return (
    <div className="w-full h-[3px] rounded-full bg-surface-3 overflow-hidden flex">
      {approvedPct > 0 && (
        <div className="h-full bg-green-500/70" style={{ width: `${approvedPct}%` }} />
      )}
      {rejectedPct > 0 && (
        <div className="h-full bg-red-500/30" style={{ width: `${rejectedPct}%` }} />
      )}
    </div>
  );
}

export default function StackDetailPage() {
  const router = useRouter();
  const params = useParams();
  const seedId = params.id as string;

  const [seed, setSeed] = useState<StackSeed | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/stacks")
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to load stacks (${r.status})`);
        return r.json();
      })
      .then((data) => {
        const found = (data.stacks || []).find((s: StackSeed) => s.id === seedId);
        if (!found) {
          setError("Stack not found");
        } else {
          setSeed(found);
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, [seedId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="w-8 h-8 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
      </div>
    );
  }

  if (error || !seed) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center px-6">
        <p className="text-red-400 text-sm mb-3">{error || "Stack not found"}</p>
        <button
          onClick={() => router.push("/stacks")}
          className="text-xs text-accent hover:text-accent-bright transition-colors"
        >
          Back to Stacks
        </button>
      </div>
    );
  }

  const seedHue = hueFromString(`${seed.artist}-${seed.title}`);

  const sortedEpisodes = [...seed.episodes].sort((a, b) => {
    if (a.match_type === "full" && b.match_type !== "full") return -1;
    if (a.match_type !== "full" && b.match_type === "full") return 1;
    if (b.approved !== a.approved) return b.approved - a.approved;
    const dateA = a.aired_date ? new Date(a.aired_date).getTime() : 0;
    const dateB = b.aired_date ? new Date(b.aired_date).getTime() : 0;
    return dateB - dateA;
  });
  const pendingEpisodes = sortedEpisodes.filter((ep) => ep.pending > 0);
  const doneEpisodes = sortedEpisodes.filter((ep) => ep.pending === 0);

  const handleDig = (ep: StackEpisode) => {
    const params = new URLSearchParams();
    params.set("episode_id", ep.id);
    if (ep.title) params.set("episode_title", ep.title);
    params.set("from", "stacks");
    router.push(`/?${params.toString()}`);
  };

  return (
    <div className="px-4 md:px-6 pt-4 md:pt-8 max-w-3xl mx-auto pb-24">
      {/* Back link */}
      <button
        onClick={() => router.push("/stacks")}
        className="flex items-center gap-1.5 text-xs text-muted hover:text-white transition-colors mb-4"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="15 18 9 12 15 6" />
        </svg>
        Stacks
      </button>

      {/* Header */}
      <div className="flex items-center gap-4 mb-6">
        <VinylDisc hue={seedHue} size={56} />
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-semibold text-white truncate">
            {decodeEntities(seed.artist)}
          </h1>
          <p className="text-sm text-white/50 truncate">{decodeEntities(seed.title)}</p>
          <div className="flex items-center gap-3 mt-1 text-xs font-mono text-muted">
            <span>{seed.episodes.length} episode{seed.episodes.length !== 1 ? "s" : ""}</span>
            {seed.total_pending > 0 && (
              <span className="text-white/50">{seed.total_pending} pending</span>
            )}
            {seed.total_approved > 0 && (
              <span className="text-green-400/60">{seed.total_approved} kept</span>
            )}
          </div>
        </div>
      </div>

      {/* Episode list */}
      <div className="space-y-2">
        {pendingEpisodes.length > 0 && (
          <>
            <p className="text-[10px] text-muted uppercase tracking-wider mb-1">
              Pending ({pendingEpisodes.length})
            </p>
            {pendingEpisodes.map((ep) => (
              <EpisodeRow key={ep.id} episode={ep} onDig={() => handleDig(ep)} />
            ))}
          </>
        )}

        {doneEpisodes.length > 0 && (
          <>
            {pendingEpisodes.length > 0 && <div className="border-t border-white/5 my-4" />}
            <p className="text-[10px] text-muted uppercase tracking-wider mb-1">
              Done ({doneEpisodes.length})
            </p>
            {doneEpisodes.map((ep) => (
              <EpisodeRow key={ep.id} episode={ep} done onDig={() => handleDig(ep)} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function EpisodeRow({
  episode,
  done,
  onDig,
}: {
  episode: StackEpisode;
  done?: boolean;
  onDig: () => void;
}) {
  return (
    <div
      className={`rounded-xl p-3 transition-colors ${
        done ? "opacity-40 bg-surface-1/50" : "bg-surface-1"
      }`}
    >
      {/* Top: title + dig button */}
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-white/80 truncate flex-1 min-w-0 text-sm font-medium">
          {episode.title || "Untitled"}
        </span>
        {episode.pending > 0 ? (
          <button
            onClick={onDig}
            className="text-[11px] px-3 py-1 rounded-full bg-accent/10 text-accent hover:bg-accent/20 transition-colors flex-shrink-0 active:scale-95"
          >
            Dig &rarr;
          </button>
        ) : (
          <span className="text-[10px] text-green-400/40 flex-shrink-0">done</span>
        )}
      </div>

      {/* Badges + stats */}
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-muted uppercase tracking-wider flex-shrink-0">
          {episode.source}
        </span>
        <span className={`text-[9px] px-1.5 py-0.5 rounded flex-shrink-0 font-medium ${
          episode.match_type === "full"
            ? "bg-green-500/15 text-green-400"
            : "bg-amber-500/15 text-amber-400"
        }`}>
          {episode.match_type === "full" ? "✓ exact" : "~ artist"}
        </span>
        {episode.aired_date && (
          <span className="text-[10px] text-muted flex-shrink-0">
            {new Date(episode.aired_date).toLocaleDateString("en-US", { day: "2-digit", month: "short", year: "numeric" })}
          </span>
        )}
        <div className="flex items-center gap-1.5 flex-shrink-0 text-[9px] font-mono">
          {episode.approved > 0 && (
            <span className="text-green-400/70">{episode.approved} kept</span>
          )}
          {episode.rejected > 0 && (
            <span className="text-red-400/40">{episode.rejected} skip</span>
          )}
          {episode.pending > 0 && (
            <span className="text-white/40">{episode.pending} pending</span>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <ProgressBar episode={episode} />

      {/* Seed track indicator */}
      {episode.match_type === "full" && (
        <p className="text-[10px] text-green-400/60 mt-1.5">🌱 Seed track in tracklist</p>
      )}

      {/* Artist-only match info */}
      {episode.match_type !== "full" && episode.matched_tracks && episode.matched_tracks.length > 0 && (
        <p className="text-[10px] text-amber-400/60 mt-1.5 truncate">
          found: {episode.matched_tracks.map((t) => t.title).join(", ")}
        </p>
      )}
    </div>
  );
}
