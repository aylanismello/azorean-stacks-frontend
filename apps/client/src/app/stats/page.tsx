"use client";

import { useState, useEffect } from "react";
import { Stats, PipelineStats, EngineStats } from "@/lib/types";

interface TasteDay {
  day: string;
  approved: number;
  rejected: number;
  total: number;
  rate: number | null;
}

interface TasteMetrics {
  daily: TasteDay[];
  summary: {
    total_votes: number;
    total_approved: number;
    last_7d_rate: number | null;
    last_7d_votes: number;
  };
}

export default function StatsPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [pipeline, setPipeline] = useState<PipelineStats | null>(null);
  const [engine, setEngine] = useState<EngineStats | null>(null);
  const [taste, setTaste] = useState<TasteMetrics | null>(null);
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
      fetch("/api/stats/taste").then((res) => {
        if (!res.ok) return null;
        return res.json();
      }).catch(() => null),
    ])
      .then(([statsData, pipelineData, engineData, tasteData]) => {
        setStats(statsData);
        setPipeline(pipelineData);
        setEngine(engineData);
        if (tasteData) setTaste(tasteData);
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

      {/* Taste Metrics */}
      {taste && (
        <div className="mb-10">
          <h2 className="text-sm font-medium text-muted mb-4 uppercase tracking-wider">
            Taste Trend
          </h2>
          <div className="grid grid-cols-3 gap-3 mb-4">
            <div className="bg-surface-1 rounded-xl p-4">
              <p className="text-xs text-muted mb-1">7-day Approval</p>
              <p className={`text-2xl font-semibold font-mono ${
                taste.summary.last_7d_rate === null ? "text-muted" :
                taste.summary.last_7d_rate >= 50 ? "text-green-400" : "text-red-400"
              }`}>
                {taste.summary.last_7d_rate !== null ? `${taste.summary.last_7d_rate}%` : "—"}
              </p>
              <p className="text-[10px] text-muted mt-1">{taste.summary.last_7d_votes} votes</p>
            </div>
            <div className="bg-surface-1 rounded-xl p-4">
              <p className="text-xs text-muted mb-1">All-time Approved</p>
              <p className="text-2xl font-semibold font-mono text-accent">
                {taste.summary.total_approved.toLocaleString()}
              </p>
              <p className="text-[10px] text-muted mt-1">of {taste.summary.total_votes.toLocaleString()} voted</p>
            </div>
            <div className="bg-surface-1 rounded-xl p-4">
              <p className="text-xs text-muted mb-1">All-time Rate</p>
              <p className={`text-2xl font-semibold font-mono ${
                taste.summary.total_votes === 0 ? "text-muted" :
                (taste.summary.total_approved / taste.summary.total_votes) >= 0.5 ? "text-green-400" : "text-red-400"
              }`}>
                {taste.summary.total_votes > 0
                  ? `${Math.round((taste.summary.total_approved / taste.summary.total_votes) * 100)}%`
                  : "—"}
              </p>
            </div>
          </div>

          {taste.daily.length > 0 && (
            <div className="bg-surface-1 rounded-xl p-4">
              <p className="text-xs text-muted uppercase tracking-wider mb-3">Daily Approval Rate (last 30 days)</p>
              <div className="flex items-end gap-1 h-20">
                {taste.daily.map((d) => {
                  const rate = d.rate ?? 0;
                  const heightPct = Math.max(rate, 4);
                  const color = rate >= 70 ? "bg-green-400" : rate >= 40 ? "bg-amber-400" : "bg-red-400";
                  const shortDay = d.day.slice(5); // "MM-DD"
                  return (
                    <div key={d.day} className="flex-1 flex flex-col items-center gap-1 group relative">
                      <div className="w-full flex items-end h-16">
                        <div
                          className={`w-full rounded-sm ${color} opacity-70 group-hover:opacity-100 transition-opacity`}
                          style={{ height: `${heightPct}%` }}
                          title={`${shortDay}: ${rate}% (${d.approved}/${d.total})`}
                        />
                      </div>
                      {taste.daily.length <= 14 && (
                        <span className="text-[8px] text-muted/50 font-mono leading-none">{shortDay}</span>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="flex justify-between mt-2">
                <span className="text-[10px] text-muted/50">{taste.daily[0]?.day}</span>
                <span className="text-[10px] text-muted/50">{taste.daily[taste.daily.length - 1]?.day}</span>
              </div>
            </div>
          )}
        </div>
      )}

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
    </div>
  );
}

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
