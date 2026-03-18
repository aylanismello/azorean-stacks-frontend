"use client";

import { useState, useEffect } from "react";
import { Stats, PipelineStats, EngineStats } from "@/lib/types";

// ── Algorithm API types ───────────────────────────────────────────────────────

interface WeightSnapshot {
  seed_proximity: number;
  source_quality: number;
  artist_familiarity: number;
  recency: number;
  co_occurrence: number;
  created_at: string;
}

interface SessionSummary {
  start: string;
  end: string;
  total: number;
  approved: number;
  rejected: number;
  skipped: number;
  approval_rate: number | null;
  avg_listen_pct: number | null;
}

interface SeedHitRate {
  seed_id: string;
  artist: string;
  title: string;
  approved: number;
  rejected: number;
  skipped: number;
  total_voted: number;
  approval_rate: number | null;
  flag: boolean;
}

interface TrendDay {
  day: string;
  approved: number;
  rejected: number;
  total: number;
  rate: number | null;
}

interface AlgorithmStats {
  current_weights: WeightSnapshot & { updated_at: string | null };
  weight_history: WeightSnapshot[];
  session_breakdown: SessionSummary[];
  per_seed_hit_rate: SeedHitRate[];
  approval_trend: TrendDay[];
  using_defaults: boolean;
}

// ── Weight config ─────────────────────────────────────────────────────────────

const WEIGHT_KEYS: Array<{
  key: keyof Omit<WeightSnapshot, "created_at">;
  label: string;
  color: string;
  line: string;
}> = [
  { key: "seed_proximity",    label: "Seed Proximity",    color: "bg-blue-500",   line: "#3b82f6" },
  { key: "source_quality",    label: "Source Quality",    color: "bg-purple-500", line: "#a855f7" },
  { key: "artist_familiarity",label: "Artist Familiar.",  color: "bg-green-500",  line: "#22c55e" },
  { key: "recency",           label: "Recency",           color: "bg-amber-500",  line: "#f59e0b" },
  { key: "co_occurrence",     label: "Co-occurrence",     color: "bg-teal-500",   line: "#14b8a6" },
];

// ── Page ──────────────────────────────────────────────────────────────────────

export default function StatsPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [pipeline, setPipeline] = useState<PipelineStats | null>(null);
  const [engine, setEngine] = useState<EngineStats | null>(null);
  const [algo, setAlgo] = useState<AlgorithmStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [secondsAgo, setSecondsAgo] = useState(0);

  const fetchAll = () =>
    Promise.all([
      fetch("/api/stats").then((res) => {
        if (!res.ok) throw new Error(`Failed to load stats (${res.status})`);
        return res.json();
      }),
      fetch("/api/stats/pipeline").then((res) => {
        if (!res.ok) throw new Error(`Failed to load pipeline stats (${res.status})`);
        return res.json();
      }),
      fetch("/api/stats/engine").then((res) => {
        if (!res.ok) throw new Error(`Failed to load engine stats (${res.status})`);
        return res.json();
      }),
      fetch("/api/stats/algorithm").then((res) => {
        if (!res.ok) throw new Error(`Failed to load algorithm stats (${res.status})`);
        return res.json();
      }),
    ])
      .then(([statsData, pipelineData, engineData, algoData]) => {
        setStats(statsData);
        setPipeline(pipelineData);
        setEngine(engineData);
        setAlgo(algoData);
        setLastUpdated(new Date());
        setSecondsAgo(0);
        setError(null);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load stats");
      });

  useEffect(() => {
    fetchAll().finally(() => setLoading(false));

    const refreshInterval = setInterval(fetchAll, 30_000);
    return () => clearInterval(refreshInterval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tick "last updated X seconds ago"
  useEffect(() => {
    const tick = setInterval(() => {
      if (lastUpdated) {
        setSecondsAgo(Math.floor((Date.now() - lastUpdated.getTime()) / 1000));
      }
    }, 1000);
    return () => clearInterval(tick);
  }, [lastUpdated]);

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <div className="w-6 h-6 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <p className="text-sm text-red-400 mb-4">{error}</p>
        <button
          onClick={() => window.location.reload()}
          className="px-4 py-2 text-sm bg-surface-2 hover:bg-surface-3 rounded-lg text-muted hover:text-foreground transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!stats) return null;

  const maxSourceCount = Math.max(...stats.source_breakdown.map((s) => s.count), 1);

  const maxArtistCount = Math.max(...stats.top_artists.map((a) => a.count), 1);

  const sourceLabel = (s: string) => {
    const labels: Record<string, string> = {
      nts: "NTS Radio",
      "1001tracklists": "1001TL",
      spotify: "Spotify",
      bandcamp: "Bandcamp",
      manual: "Manual",
    };
    return labels[s] || s;
  };

  const formatDate = (d: string) =>
    new Date(d).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });

  const formatSecondsAgo = (s: number) => {
    if (s < 60) return `${s}s ago`;
    return `${Math.floor(s / 60)}m ago`;
  };

  return (
    <div className="px-4 md:px-6 pt-4 md:pt-8 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold">Taste Dashboard</h1>
        {lastUpdated && (
          <span className="text-[11px] text-muted/60 font-mono">
            updated {formatSecondsAgo(secondsAgo)}
          </span>
        )}
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-10">
        <StatCard label="Pending" value={stats.total_pending} accent />
        <StatCard label="Reviewed" value={stats.total_reviewed} />
        <StatCard label="Approved" value={stats.total_approved} />
        <StatCard
          label="Approval Rate"
          value={`${Math.round(stats.approval_rate * 100)}%`}
        />
      </div>

      {/* Engine Status */}
      {engine && (
        <div className="mb-10">
          <h2 className="text-sm font-medium text-muted mb-4 uppercase tracking-wider">
            Engine Status
          </h2>

          {/* Watcher + rates */}
          <div className="grid grid-cols-3 gap-3 mb-4">
            <div className="bg-surface-1 rounded-xl p-4">
              <p className="text-xs text-muted mb-1">Watcher</p>
              <p
                className={`text-sm font-semibold ${
                  engine.watcher.online ? "text-green-400" : "text-red-400"
                }`}
              >
                {engine.watcher.online ? "ONLINE" : "OFFLINE"}
              </p>
              {engine.watcher.connected_at && (
                <p className="text-[10px] text-muted mt-1 font-mono">
                  since {formatDate(engine.watcher.connected_at)}
                </p>
              )}
            </div>
            <div className="bg-surface-1 rounded-xl p-4">
              <p className="text-xs text-muted mb-1">Enrichment Rate</p>
              <p className="text-2xl font-semibold font-mono text-accent">
                {engine.tracks.total > 0
                  ? `${Math.round(((engine.tracks.enriched + engine.tracks.downloaded) / engine.tracks.total) * 100)}%`
                  : "—"}
              </p>
            </div>
            <div className="bg-surface-1 rounded-xl p-4">
              <p className="text-xs text-muted mb-1">Download Rate</p>
              <p className="text-2xl font-semibold font-mono text-accent">
                {engine.tracks.total > 0
                  ? `${Math.round((engine.tracks.downloaded / engine.tracks.total) * 100)}%`
                  : "—"}
              </p>
            </div>
          </div>

          {/* Track pipeline breakdown */}
          <div className="bg-surface-1 rounded-xl p-4 mb-4">
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs text-muted uppercase tracking-wider">
                Track Pipeline
              </p>
              <p className="text-xs text-muted font-mono">
                {engine.tracks.total.toLocaleString()} total
              </p>
            </div>
            <div className="space-y-3">
              <PipelineBar
                label="Downloaded"
                count={engine.tracks.downloaded}
                pct={engine.tracks.downloaded_pct}
                color="bg-green-400"
              />
              <PipelineBar
                label="Enriched"
                count={engine.tracks.enriched}
                pct={engine.tracks.enriched_pct}
                color="bg-accent"
              />
              <PipelineBar
                label="Pending"
                count={engine.tracks.pending}
                pct={engine.tracks.pending_pct}
                color="bg-surface-3"
              />
              <PipelineBar
                label="Failed"
                count={engine.tracks.failed}
                pct={engine.tracks.failed_pct}
                color="bg-red-400/60"
              />
            </div>
          </div>

          {/* Last runs */}
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-surface-1 rounded-xl p-4">
              <p className="text-xs text-muted mb-1">Last Discover Run</p>
              {engine.last_discover ? (
                <>
                  <p className="text-xs font-mono text-foreground/70">
                    {formatDate(engine.last_discover.at)}
                  </p>
                  <p className="text-[11px] text-muted mt-1">
                    {engine.last_discover.tracks_found} tracks found
                  </p>
                </>
              ) : (
                <p className="text-xs text-muted/50">No runs yet</p>
              )}
            </div>
            <div className="bg-surface-1 rounded-xl p-4">
              <p className="text-xs text-muted mb-1">Last Download Run</p>
              {engine.last_download ? (
                <>
                  <p className="text-xs font-mono text-foreground/70">
                    {formatDate(engine.last_download.at)}
                  </p>
                  <p className="text-[11px] text-muted mt-1">
                    {String(engine.last_download.tracks_downloaded)} downloaded
                  </p>
                </>
              ) : (
                <p className="text-xs text-muted/50">No downloads yet</p>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-8">
        {/* Top Artists */}
        <div>
          <h2 className="text-sm font-medium text-muted mb-4 uppercase tracking-wider">
            Top Approved Artists
          </h2>
          {stats.top_artists.length === 0 ? (
            <p className="text-sm text-muted/60">No data yet</p>
          ) : (
            <div className="space-y-2">
              {stats.top_artists.map((a) => (
                <div key={a.artist} className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm text-foreground truncate">
                        {a.artist}
                      </span>
                      <span className="text-xs text-muted font-mono ml-2">
                        {a.count}
                      </span>
                    </div>
                    <div className="h-1 bg-surface-2 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-accent/60 rounded-full"
                        style={{
                          width: `${(a.count / maxArtistCount) * 100}%`,
                        }}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Sources */}
        <div>
          <h2 className="text-sm font-medium text-muted mb-4 uppercase tracking-wider">
            Discovery Sources
          </h2>
          {stats.source_breakdown.length === 0 ? (
            <p className="text-sm text-muted/60">No data yet</p>
          ) : (
            <div className="space-y-2">
              {stats.source_breakdown.map((s) => (
                <div key={s.source} className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm text-foreground">
                        {sourceLabel(s.source)}
                      </span>
                      <span className="text-xs text-muted font-mono ml-2">
                        {s.count}
                      </span>
                    </div>
                    <div className="h-1 bg-surface-2 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-accent/40 rounded-full"
                        style={{
                          width: `${(s.count / maxSourceCount) * 100}%`,
                        }}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Recent Discovery Runs */}
      <div className="mt-10">
        <h2 className="text-sm font-medium text-muted mb-4 uppercase tracking-wider">
          Recent Discovery Runs
        </h2>
        {stats.recent_runs.length === 0 ? (
          <p className="text-sm text-muted/60">No runs recorded yet</p>
        ) : (
          <div className="space-y-2">
            {stats.recent_runs.map((run) => (
              <div
                key={run.id}
                className="bg-surface-1 rounded-xl p-4 flex items-center gap-4"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 mb-1">
                    <span className="text-xs text-muted font-mono">
                      {formatDate(run.started_at)}
                    </span>
                    {run.sources_searched && (
                      <span className="text-[10px] text-muted/60">
                        {run.sources_searched.join(", ")}
                      </span>
                    )}
                  </div>
                  {run.notes && (
                    <p className="text-xs text-foreground/50 truncate">{run.notes}</p>
                  )}
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="text-sm font-mono text-foreground">
                    +{run.tracks_added}
                  </p>
                  <p className="text-[10px] text-muted">
                    of {run.tracks_found} found
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Pipeline Health */}
      {pipeline && (
        <div className="mt-10 mb-10">
          <h2 className="text-sm font-medium text-muted mb-4 uppercase tracking-wider">
            Pipeline Health
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            <StatCard label="Super-Liked" value={pipeline.super_likes.total} />
            <StatCard label="Downloaded" value={pipeline.super_likes.downloaded} />
            <StatCard
              label="Pending DL"
              value={pipeline.super_likes.pending}
              accent={pipeline.super_likes.pending > 0}
            />
            <div className="bg-surface-1 rounded-xl p-4">
              <p className="text-xs text-muted mb-1">Watcher</p>
              <p className={`text-sm font-semibold ${pipeline.watcher.connected_at ? "text-green-400" : "text-red-400"}`}>
                {pipeline.watcher.connected_at ? "Connected" : "Offline"}
              </p>
              {pipeline.watcher.connected_at && (
                <p className="text-[10px] text-muted mt-1 font-mono">
                  since {formatDate(pipeline.watcher.connected_at)}
                </p>
              )}
            </div>
          </div>

          {pipeline.watcher.last_event && (
            <p className="text-xs text-muted mb-4">
              Last event:{" "}
              <span className="font-mono text-foreground/60">
                {formatDate(pipeline.watcher.last_event)}
              </span>
            </p>
          )}

          {pipeline.last_events.length > 0 && (
            <div className="space-y-1">
              {pipeline.last_events.map((ev, i) => (
                <div
                  key={i}
                  className="bg-surface-1 rounded-lg px-4 py-2 flex items-center gap-3"
                >
                  <span
                    className={`text-[10px] font-mono shrink-0 px-1.5 py-0.5 rounded ${
                      ev.status === "completed"
                        ? "bg-green-400/10 text-green-400"
                        : ev.status === "failed"
                          ? "bg-red-400/10 text-red-400"
                          : "bg-accent/10 text-accent"
                    }`}
                  >
                    {ev.status}
                  </span>
                  <span className="text-xs text-foreground/70 truncate flex-1">
                    {(ev.event_type || ev.type || "").replace(/_/g, " ")}
                    {ev.metadata?.message ? ` — ${ev.metadata.message}` : ""}
                  </span>
                  <span className="text-[10px] text-muted font-mono shrink-0">
                    {formatDate(ev.created_at)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Algorithm Section ─────────────────────────────────────────────── */}
      {algo && (
        <div className="mt-10 mb-16">
          <h2 className="text-sm font-medium text-muted mb-6 uppercase tracking-wider">
            Algorithm
            {algo.using_defaults && (
              <span className="ml-2 text-[10px] text-amber-400/80 normal-case tracking-normal font-normal">
                using defaults
              </span>
            )}
          </h2>

          {/* 1. Current Weights — stacked bar */}
          <div className="bg-surface-1 border border-white/5 rounded-xl p-4 mb-4">
            <p className="text-xs text-muted uppercase tracking-wider mb-3">
              Current Weights
            </p>
            <WeightsBar weights={algo.current_weights} />
            {algo.current_weights.updated_at && (
              <p className="text-[10px] text-muted/50 font-mono mt-3">
                last updated {formatDate(algo.current_weights.updated_at)}
              </p>
            )}
          </div>

          {/* 2. Weight History */}
          <div className="bg-surface-1 border border-white/5 rounded-xl p-4 mb-4">
            <p className="text-xs text-muted uppercase tracking-wider mb-3">
              Weight History — 30 days
            </p>
            {algo.weight_history.length < 2 ? (
              <p className="text-xs text-muted/50 py-4 text-center">
                Not enough history yet
              </p>
            ) : (
              <WeightHistoryChart history={algo.weight_history} />
            )}
          </div>

          {/* 3. Session Breakdown */}
          <div className="bg-surface-1 border border-white/5 rounded-xl p-4 mb-4">
            <p className="text-xs text-muted uppercase tracking-wider mb-3">
              Recent Sessions
            </p>
            {algo.session_breakdown.length === 0 ? (
              <p className="text-xs text-muted/50">No sessions yet</p>
            ) : (
              <div className="space-y-3">
                {algo.session_breakdown.map((s, i) => (
                  <SessionRow key={i} session={s} formatDate={formatDate} />
                ))}
              </div>
            )}
          </div>

          {/* 4. Per-Seed Hit Rate */}
          <div className="bg-surface-1 border border-white/5 rounded-xl p-4 mb-4">
            <p className="text-xs text-muted uppercase tracking-wider mb-3">
              Per-Seed Hit Rate
            </p>
            {algo.per_seed_hit_rate.length === 0 ? (
              <p className="text-xs text-muted/50">No seed data yet</p>
            ) : (
              <SeedHitRateTable seeds={algo.per_seed_hit_rate} />
            )}
          </div>

          {/* 5. Approval Trend */}
          <div className="bg-surface-1 border border-white/5 rounded-xl p-4">
            <p className="text-xs text-muted uppercase tracking-wider mb-3">
              Approval Trend — 30 days
            </p>
            {algo.approval_trend.length === 0 ? (
              <p className="text-xs text-muted/50 py-4 text-center">
                No voting data yet
              </p>
            ) : (
              <ApprovalTrendChart trend={algo.approval_trend} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Algorithm sub-components ──────────────────────────────────────────────────

function WeightsBar({ weights }: { weights: WeightSnapshot }) {
  const total = WEIGHT_KEYS.reduce((sum, w) => sum + (weights[w.key] as number), 0) || 100;
  return (
    <div>
      {/* Stacked bar */}
      <div className="flex h-8 rounded-lg overflow-hidden w-full gap-px">
        {WEIGHT_KEYS.map((w) => {
          const val = weights[w.key] as number;
          const pct = (val / total) * 100;
          return (
            <div
              key={w.key}
              className={`${w.color} flex items-center justify-center overflow-hidden transition-all`}
              style={{ width: `${pct}%` }}
              title={`${w.label}: ${val}`}
            >
              {pct > 10 && (
                <span className="text-[10px] font-mono text-white/90 font-semibold px-1 truncate">
                  {Math.round(pct)}%
                </span>
              )}
            </div>
          );
        })}
      </div>
      {/* Legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-3">
        {WEIGHT_KEYS.map((w) => (
          <div key={w.key} className="flex items-center gap-1.5">
            <div className={`w-2 h-2 rounded-sm ${w.color}`} />
            <span className="text-[11px] text-muted">
              {w.label}{" "}
              <span className="font-mono text-foreground/60">
                {weights[w.key]}
              </span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function WeightHistoryChart({ history }: { history: WeightSnapshot[] }) {
  const W = 600;
  const H = 120;
  const PAD = { top: 10, right: 10, bottom: 24, left: 28 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;

  const allValues = history.flatMap((h) =>
    WEIGHT_KEYS.map((w) => h[w.key] as number)
  );
  const minVal = Math.max(0, Math.min(...allValues) - 3);
  const maxVal = Math.min(100, Math.max(...allValues) + 3);
  const range = maxVal - minVal || 1;

  const xStep = history.length > 1 ? chartW / (history.length - 1) : chartW;

  const toX = (i: number) => PAD.left + i * xStep;
  const toY = (v: number) => PAD.top + chartH - ((v - minVal) / range) * chartH;

  const yTicks = [minVal, minVal + range * 0.5, maxVal].map(Math.round);

  // Date labels: show first, mid, last
  const dateIdxs = [0, Math.floor(history.length / 2), history.length - 1];
  const fmtShort = (d: string) =>
    new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });

  return (
    <div className="w-full overflow-x-auto">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        style={{ minWidth: 280 }}
        preserveAspectRatio="none"
      >
        {/* Y-axis ticks */}
        {yTicks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={toY(t)}
              y2={toY(t)}
              stroke="rgba(255,255,255,0.06)"
              strokeWidth="1"
            />
            <text
              x={PAD.left - 4}
              y={toY(t) + 4}
              textAnchor="end"
              fontSize="9"
              fill="rgba(255,255,255,0.3)"
            >
              {t}
            </text>
          </g>
        ))}

        {/* Date labels */}
        {dateIdxs.map((idx) => (
          <text
            key={idx}
            x={toX(idx)}
            y={H - 4}
            textAnchor="middle"
            fontSize="9"
            fill="rgba(255,255,255,0.3)"
          >
            {fmtShort(history[idx].created_at)}
          </text>
        ))}

        {/* Lines */}
        {WEIGHT_KEYS.map((w) => {
          const points = history
            .map((h, i) => `${toX(i)},${toY(h[w.key] as number)}`)
            .join(" ");
          return (
            <polyline
              key={w.key}
              points={points}
              fill="none"
              stroke={w.line}
              strokeWidth="1.5"
              strokeLinejoin="round"
              strokeLinecap="round"
              opacity={0.85}
            />
          );
        })}

        {/* Dots at last point */}
        {WEIGHT_KEYS.map((w) => {
          const last = history[history.length - 1];
          return (
            <circle
              key={w.key}
              cx={toX(history.length - 1)}
              cy={toY(last[w.key] as number)}
              r="2.5"
              fill={w.line}
            />
          );
        })}
      </svg>

      {/* Legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
        {WEIGHT_KEYS.map((w) => (
          <div key={w.key} className="flex items-center gap-1.5">
            <div className="w-4 h-0.5 rounded-full" style={{ backgroundColor: w.line }} />
            <span className="text-[10px] text-muted">{w.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SessionRow({
  session,
  formatDate,
}: {
  session: SessionSummary;
  formatDate: (d: string) => string;
}) {
  const total = session.total || 1;
  return (
    <div className="border border-white/5 rounded-lg p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] text-muted font-mono">
          {formatDate(session.start)}
        </span>
        <span className="text-[11px] text-muted/60 font-mono">
          {session.total} votes
        </span>
      </div>
      {/* Pills */}
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <span className="text-[11px] px-2 py-0.5 rounded-full bg-green-500/15 text-green-400 font-mono">
          ✓ {session.approved}
        </span>
        <span className="text-[11px] px-2 py-0.5 rounded-full bg-red-500/15 text-red-400 font-mono">
          ✗ {session.rejected}
        </span>
        <span className="text-[11px] px-2 py-0.5 rounded-full bg-surface-3 text-muted font-mono">
          ⤳ {session.skipped}
        </span>
        {session.approval_rate !== null && (
          <span
            className={`text-[11px] px-2 py-0.5 rounded-full font-mono ml-auto ${
              session.approval_rate >= 70
                ? "bg-green-500/10 text-green-400"
                : session.approval_rate >= 40
                  ? "bg-amber-500/10 text-amber-400"
                  : "bg-red-500/10 text-red-400"
            }`}
          >
            {session.approval_rate}% approved
          </span>
        )}
      </div>
      {/* Listen % bar */}
      {session.avg_listen_pct !== null && (
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] text-muted/60">Avg listen</span>
            <span className="text-[10px] text-muted font-mono">
              {session.avg_listen_pct}%
            </span>
          </div>
          <div className="h-1 bg-surface-2 rounded-full overflow-hidden">
            <div
              className="h-full bg-accent/50 rounded-full"
              style={{ width: `${Math.min(session.avg_listen_pct, 100)}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function SeedHitRateTable({ seeds }: { seeds: SeedHitRate[] }) {
  return (
    <div className="space-y-2">
      {seeds.map((seed) => {
        const total = seed.total_voted || 1;
        const approvedPct = (seed.approved / total) * 100;
        const rejectedPct = (seed.rejected / total) * 100;
        const skippedPct = (seed.skipped / total) * 100;

        const rateColor =
          seed.approval_rate === null
            ? "text-muted/40"
            : seed.approval_rate >= 70
              ? "text-green-400"
              : seed.approval_rate >= 40
                ? "text-amber-400"
                : "text-red-400";

        return (
          <div key={seed.seed_id} className="border border-white/5 rounded-lg p-3">
            <div className="flex items-start gap-2 mb-2">
              {seed.flag && (
                <span className="text-red-400 text-sm shrink-0 mt-0.5" title="Below 20% approval">
                  ⚠
                </span>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-xs text-foreground/80 truncate">
                  {seed.artist}
                  {seed.title && (
                    <span className="text-muted/60"> — {seed.title}</span>
                  )}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <span className={`text-sm font-mono font-semibold ${rateColor}`}>
                  {seed.approval_rate !== null ? `${seed.approval_rate}%` : "—"}
                </span>
                <p className="text-[10px] text-muted/50 font-mono">
                  {seed.total_voted} votes
                </p>
              </div>
            </div>
            {/* Approve/reject/skip ratio bar */}
            {seed.total_voted > 0 && (
              <div className="flex h-1.5 rounded-full overflow-hidden gap-px">
                <div
                  className="bg-green-500/70 rounded-l-full"
                  style={{ width: `${approvedPct}%` }}
                />
                <div
                  className="bg-red-500/60"
                  style={{ width: `${rejectedPct}%` }}
                />
                <div
                  className="bg-surface-3 rounded-r-full flex-1"
                  style={{ width: `${skippedPct}%` }}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ApprovalTrendChart({ trend }: { trend: TrendDay[] }) {
  // Compute 7-day rolling average
  const withRolling = trend.map((d, i) => {
    const window = trend.slice(Math.max(0, i - 6), i + 1);
    const validRates = window.map((w) => w.rate).filter((r): r is number => r !== null);
    const rolling = validRates.length > 0
      ? Math.round(validRates.reduce((a, b) => a + b, 0) / validRates.length)
      : null;
    return { ...d, rolling };
  });

  const W = 600;
  const H = 140;
  const PAD = { top: 10, right: 10, bottom: 28, left: 28 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;

  const barW = Math.max(2, chartW / trend.length - 1);
  const xStep = chartW / trend.length;

  const toX = (i: number) => PAD.left + i * xStep + xStep / 2;
  const toY = (v: number) => PAD.top + chartH - (v / 100) * chartH;

  const barColor = (rate: number | null) => {
    if (rate === null) return "rgba(255,255,255,0.1)";
    if (rate >= 70) return "rgba(34,197,94,0.55)";
    if (rate >= 40) return "rgba(245,158,11,0.55)";
    return "rgba(239,68,68,0.5)";
  };

  // Y-axis ticks: 0, 50, 100
  const yTicks = [0, 50, 100];

  // Date labels: first, mid, last
  const dateIdxs = [0, Math.floor(trend.length / 2), trend.length - 1];
  const fmtShort = (d: string) =>
    new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });

  // Rolling average line
  const rollingPoints = withRolling
    .map((d, i) => (d.rolling !== null ? `${toX(i)},${toY(d.rolling)}` : null))
    .filter(Boolean);

  return (
    <div className="w-full overflow-x-auto">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        style={{ minWidth: 280 }}
        preserveAspectRatio="none"
      >
        {/* Y ticks */}
        {yTicks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={toY(t)}
              y2={toY(t)}
              stroke="rgba(255,255,255,0.06)"
              strokeWidth="1"
            />
            <text
              x={PAD.left - 4}
              y={toY(t) + 4}
              textAnchor="end"
              fontSize="9"
              fill="rgba(255,255,255,0.3)"
            >
              {t}%
            </text>
          </g>
        ))}

        {/* Bars */}
        {withRolling.map((d, i) => {
          const barH = d.rate !== null ? ((d.rate / 100) * chartH) : 2;
          return (
            <rect
              key={d.day}
              x={toX(i) - barW / 2}
              y={toY(d.rate ?? 0)}
              width={barW}
              height={barH}
              fill={barColor(d.rate)}
              rx="1"
            />
          );
        })}

        {/* 7-day rolling average line */}
        {rollingPoints.length > 1 && (
          <polyline
            points={rollingPoints.join(" ")}
            fill="none"
            stroke="rgba(255,255,255,0.6)"
            strokeWidth="1.5"
            strokeLinejoin="round"
            strokeLinecap="round"
            strokeDasharray="3 2"
          />
        )}

        {/* Date labels */}
        {dateIdxs.map((idx) => (
          <text
            key={idx}
            x={toX(idx)}
            y={H - 6}
            textAnchor="middle"
            fontSize="9"
            fill="rgba(255,255,255,0.3)"
          >
            {fmtShort(trend[idx].day)}
          </text>
        ))}
      </svg>

      <div className="flex items-center gap-4 mt-1">
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded-sm bg-green-500/55" />
          <span className="text-[10px] text-muted">≥70%</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded-sm bg-amber-500/55" />
          <span className="text-[10px] text-muted">40–69%</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded-sm bg-red-500/50" />
          <span className="text-[10px] text-muted">&lt;40%</span>
        </div>
        <div className="flex items-center gap-1.5 ml-2">
          <div className="w-4 border-t border-dashed border-white/60" />
          <span className="text-[10px] text-muted">7d avg</span>
        </div>
      </div>
    </div>
  );
}

// ── Shared components ─────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: number | string;
  accent?: boolean;
}) {
  return (
    <div className="bg-surface-1 rounded-xl p-4">
      <p className="text-xs text-muted mb-1">{label}</p>
      <p
        className={`text-2xl font-semibold font-mono ${
          accent ? "text-accent" : "text-foreground"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function PipelineBar({
  label,
  count,
  pct,
  color,
}: {
  label: string;
  count: number;
  pct: number;
  color: string;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-foreground/70">{label}</span>
        <span className="text-xs text-muted font-mono">
          {count.toLocaleString()} <span className="text-muted/60">({pct}%)</span>
        </span>
      </div>
      <div className="h-1.5 bg-surface-2 rounded-full overflow-hidden">
        <div
          className={`h-full ${color} rounded-full transition-all`}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
    </div>
  );
}
