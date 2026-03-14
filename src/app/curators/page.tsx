"use client";

import { useState, useEffect, useCallback } from "react";
import { Curator, EpisodeTrack } from "@/lib/types";
import { openYouTube } from "@/lib/youtube";

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

function socialIcon(name: string | undefined) {
  const n = (name || "").toLowerCase();
  if (n.includes("instagram")) return "IG";
  if (n.includes("twitter") || n.includes("x.com")) return "X";
  if (n.includes("facebook")) return "FB";
  if (n.includes("soundcloud")) return "SC";
  if (n.includes("bandcamp")) return "BC";
  if (n.includes("mixcloud")) return "MX";
  if (n.includes("discord")) return "DC";
  return (name || "").slice(0, 2).toUpperCase();
}

export default function CuratorsPage() {
  const [curators, setCurators] = useState<Curator[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [enriching, setEnriching] = useState(false);
  const [enrichResult, setEnrichResult] = useState<string | null>(null);
  const [selected, setSelected] = useState<Curator | null>(null);

  const fetchCurators = useCallback(async () => {
    try {
      const res = await fetch("/api/curators");
      if (!res.ok) throw new Error(`Failed to load curators (${res.status})`);
      const data = await res.json();
      setCurators(data.curators || []);
      setTotal(data.total || 0);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load curators");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCurators();
  }, [fetchCurators]);

  const handleEnrich = async () => {
    setEnriching(true);
    setEnrichResult(null);
    try {
      const res = await fetch("/api/curators/enrich", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batch_size: 20 }),
      });
      const data = await res.json();
      setEnrichResult(`Enriched ${data.enriched}/${data.total} curators`);
      fetchCurators();
    } catch {
      setEnrichResult("Enrichment failed");
    } finally {
      setEnriching(false);
    }
  };

  const unenrichedCount = curators.filter((c) => !c.enriched_at).length;

  return (
    <div className="px-4 md:px-6 pt-4 md:pt-8 max-w-5xl mx-auto pb-24">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-xl font-semibold">Curators</h1>
        {unenrichedCount > 0 && (
          <button
            onClick={handleEnrich}
            disabled={enriching}
            className="text-[11px] px-3 py-1.5 rounded-lg bg-accent/10 text-accent hover:bg-accent/20 transition-colors disabled:opacity-50"
          >
            {enriching ? (
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
                Enriching...
              </span>
            ) : (
              `Enrich ${unenrichedCount} curators`
            )}
          </button>
        )}
      </div>
      <p className="text-sm text-muted mb-6">
        {total} DJ{total !== 1 ? "s" : ""} whose tracklists matched your seeds
      </p>

      {enrichResult && (
        <div className="mb-4 p-3 bg-accent/10 border border-accent/20 rounded-lg text-sm text-accent flex items-center justify-between">
          <span>{enrichResult}</span>
          <button onClick={() => setEnrichResult(null)} className="text-accent/60 hover:text-accent">
            ✕
          </button>
        </div>
      )}

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
      ) : curators.length === 0 ? (
        <div className="text-center py-12 text-muted text-sm">
          No curators yet. Run discovery to find some.
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {curators.map((curator) => (
            <CuratorTile
              key={curator.id}
              curator={curator}
              onSelect={() => setSelected(selected?.id === curator.id ? null : curator)}
              isSelected={selected?.id === curator.id}
            />
          ))}
        </div>
      )}

      {/* Detail drawer */}
      {selected && (
        <CuratorDetail
          curator={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

/* ─── Tile ─── */

function CuratorTile({
  curator,
  onSelect,
  isSelected,
}: {
  curator: Curator;
  onSelect: () => void;
  isSelected: boolean;
}) {
  const displayName = curator.enriched_at ? curator.name : titleCase(curator.name);
  const hue1 = (curator.slug.length * 37) % 360;
  const hue2 = (curator.slug.length * 71) % 360;

  return (
    <button
      onClick={onSelect}
      className={`group relative aspect-square rounded-2xl overflow-hidden transition-all duration-200 ${
        isSelected
          ? "ring-2 ring-accent ring-offset-2 ring-offset-[#0a0a0a] scale-[0.97]"
          : "hover:scale-[1.03] hover:shadow-xl active:scale-[0.98]"
      }`}
    >
      {/* Background */}
      {curator.avatar_url ? (
        <img
          src={curator.avatar_url}
          alt=""
          className="absolute inset-0 w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
        />
      ) : (
        <div
          className="absolute inset-0"
          style={{
            background: `linear-gradient(135deg, hsl(${hue1}, 35%, 20%), hsl(${hue2}, 45%, 10%))`,
          }}
        />
      )}

      {/* Gradient overlay */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/30 to-transparent" />

      {/* Match badge */}
      {curator.matched_episodes > 0 && (
        <div className="absolute top-2 right-2 bg-black/60 backdrop-blur-sm rounded-full px-2 py-0.5 flex items-center gap-1">
          <span className="text-[10px] font-mono font-semibold text-accent">
            {curator.matched_episodes}
          </span>
          <span className="text-[8px] text-accent/60">match{curator.matched_episodes !== 1 ? "es" : ""}</span>
        </div>
      )}

      {/* Bottom text */}
      <div className="absolute bottom-0 left-0 right-0 p-3">
        <p className="text-[13px] font-semibold text-white leading-tight line-clamp-2 drop-shadow-lg">
          {displayName}
        </p>
        <div className="flex items-center gap-1.5 mt-1">
          {curator.location && (
            <span className="text-[9px] text-white/50">{curator.location}</span>
          )}
          {curator.location && curator.genres.length > 0 && (
            <span className="text-white/20">·</span>
          )}
          {curator.genres.length > 0 && (
            <span className="text-[9px] text-white/35 truncate">
              {curator.genres.slice(0, 2).join(", ")}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-1.5">
          <span className="text-[9px] text-white/30 font-mono">
            {curator.episode_count} ep{curator.episode_count !== 1 ? "s" : ""}
          </span>
        </div>
      </div>
    </button>
  );
}

/* ─── Detail drawer (fixed bottom sheet) ─── */

interface CuratorEpisode {
  id: string;
  url: string;
  title: string | null;
  source: string;
  aired_date: string | null;
  seeds: Array<{ seed_id: string; artist: string; title: string; match_type: string }>;
  track_stats: { total: number; pending: number; approved: number; rejected: number };
}

function CuratorDetail({ curator, onClose }: { curator: Curator; onClose: () => void }) {
  const [episodes, setEpisodes] = useState<CuratorEpisode[]>([]);
  const [loading, setLoading] = useState(true);
  const displayName = curator.enriched_at ? curator.name : titleCase(curator.name);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/curators/${curator.id}/episodes`)
      .then((r) => r.json())
      .then((d) => setEpisodes(d.episodes || []))
      .finally(() => setLoading(false));
  }, [curator.id]);

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 animate-in fade-in duration-200"
        onClick={onClose}
      />

      {/* Sheet */}
      <div className="fixed inset-x-0 bottom-0 z-50 max-h-[85vh] flex flex-col bg-[#111] border-t border-surface-3 rounded-t-2xl animate-in slide-in-from-bottom duration-300">
        {/* Header */}
        <div className="flex items-start gap-4 p-4 pb-3 border-b border-surface-3/50 flex-shrink-0">
          {curator.avatar_url ? (
            <img
              src={curator.avatar_url}
              alt=""
              className="w-16 h-16 rounded-xl object-cover flex-shrink-0"
            />
          ) : (
            <div
              className="w-16 h-16 rounded-xl flex-shrink-0 flex items-center justify-center text-xl font-bold text-white/40"
              style={{
                background: `linear-gradient(135deg, hsl(${(curator.slug.length * 37) % 360}, 35%, 20%), hsl(${(curator.slug.length * 71) % 360}, 45%, 10%))`,
              }}
            >
              {displayName.charAt(0)}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-semibold text-white leading-tight">{displayName}</h2>
            {(curator.location || curator.genres.length > 0) && (
              <p className="text-xs text-muted mt-0.5">
                {[curator.location, curator.genres.slice(0, 3).join(", ")].filter(Boolean).join(" · ")}
              </p>
            )}
            {curator.description && (
              <p className="text-[11px] text-white/40 mt-1 line-clamp-2 leading-relaxed">
                {curator.description}
              </p>
            )}
            {/* Links */}
            <div className="flex items-center gap-1.5 mt-2 flex-wrap">
              {curator.source_url && (
                <a
                  href={curator.source_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] px-2.5 py-1 rounded-full bg-surface-2 text-accent hover:bg-surface-3 transition-colors"
                >
                  NTS ↗
                </a>
              )}
              {curator.external_links.map((link, i) => (
                <a
                  key={i}
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] px-2 py-0.5 rounded-full bg-surface-2 text-muted hover:text-white hover:bg-surface-3 transition-colors"
                  title={link.name}
                >
                  {socialIcon(link.url || link.name || "")}
                </a>
              ))}
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-muted hover:text-white p-1 -mr-1 -mt-1 transition-colors"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Episode list */}
        <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-3">
          <p className="text-[10px] text-muted uppercase tracking-wider mb-2">
            Episodes · {curator.matched_episodes} matched / {curator.episode_count} total
          </p>
          {loading ? (
            <div className="flex justify-center py-8">
              <div className="w-5 h-5 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
            </div>
          ) : episodes.length === 0 ? (
            <p className="text-[11px] text-muted/50 py-4">No episodes found</p>
          ) : (
            <div className="space-y-0">
              {episodes.map((ep) => (
                <CuratorEpisodeRow key={ep.id} episode={ep} />
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/* ─── Episode row ─── */

function CuratorEpisodeRow({ episode: ep }: { episode: CuratorEpisode }) {
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

  const total = ep.track_stats.total;

  return (
    <div className="border-b border-surface-3/30 last:border-b-0">
      <button
        onClick={handleToggle}
        className="w-full text-left py-2.5 hover:bg-surface-2/30 transition-colors rounded-lg px-2 -mx-2"
      >
        <div className="flex items-center gap-2">
          {ep.aired_date && (
            <span className="text-[11px] text-white/60 font-mono flex-shrink-0 w-20">{ep.aired_date}</span>
          )}
          {total > 0 && (
            <span className="text-[10px] text-muted/40 flex-shrink-0">{total} trk</span>
          )}
          {ep.seeds.map((s, i) => (
            <span
              key={i}
              className={`text-[9px] px-1.5 py-0.5 rounded-full flex-shrink-0 ${
                s.match_type === "full"
                  ? "bg-accent/15 text-accent"
                  : "bg-amber-500/12 text-amber-400"
              }`}
            >
              {s.match_type === "full" ? "exact" : `via ${s.title}`}
            </span>
          ))}
          <div className="flex-1" />
          <span className="text-muted/40 text-[10px]">{open ? "▾" : "▸"}</span>
        </div>
      </button>

      {open && (
        <div className="pl-2 pr-1 pb-3">
          <div className="flex items-center gap-2 mb-2">
            <a
              href={ep.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] px-2.5 py-1 rounded-full bg-surface-2 text-accent hover:bg-surface-3 transition-colors"
            >
              Open on NTS ↗
            </a>
            {ep.track_stats.pending > 0 && (
              <a
                href={`/?episode_id=${ep.id}&episode_title=${encodeURIComponent(ep.title || ep.url)}`}
                className="text-[10px] px-2.5 py-1 rounded-full bg-accent/15 text-accent hover:bg-accent/25 transition-colors font-medium"
              >
                Swipe {ep.track_stats.pending} pending →
              </a>
            )}
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
                <CuratorTrackRow key={t.id} track={t} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── Track row ─── */

function CuratorTrackRow({ track: t }: { track: EpisodeTrack }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(`${t.artist} - ${t.title}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const statusColor = t.status === "approved" || t.status === "downloaded"
    ? "text-green-400" : t.status === "rejected" ? "text-red-400" : "text-muted";

  return (
    <div className="flex items-center gap-2 py-1 text-[13px]">
      {t.cover_art_url ? (
        <img src={t.cover_art_url} alt="" className="w-5 h-5 rounded flex-shrink-0 object-cover" />
      ) : (
        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 bg-surface-4" />
      )}
      <span className={`flex-1 min-w-0 truncate ${statusColor}`}>
        {t.artist} — {t.title}
      </span>
      <div className="flex gap-1.5 flex-shrink-0 items-center">
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
        {t.spotify_url && (
          <a href={t.spotify_url} target="_blank" rel="noopener noreferrer" className="text-[9px] text-green-400/60 hover:text-green-400">SP</a>
        )}
        {t.youtube_url && (
          <button onClick={() => openYouTube(t.youtube_url!)} className="text-[9px] text-red-400/60 hover:text-red-400">YT</button>
        )}
      </div>
    </div>
  );
}
