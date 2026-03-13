"use client";

import { useState, useEffect } from "react";
import { Stats } from "@/lib/types";

export default function StatsPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/stats")
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load stats (${res.status})`);
        return res.json();
      })
      .then((data) => {
        setStats(data);
        setError(null);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load stats");
      })
      .finally(() => setLoading(false));
  }, []);

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
          className="px-4 py-2 text-sm bg-surface-2 hover:bg-surface-3 rounded-lg text-muted hover:text-white transition-colors"
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

  return (
    <div className="px-4 md:px-6 pt-4 md:pt-8 max-w-3xl mx-auto">
      <h1 className="text-xl font-semibold mb-6">Taste Dashboard</h1>

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
                      <span className="text-sm text-white truncate">
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
                      <span className="text-sm text-white">
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
                    <p className="text-xs text-white/50 truncate">{run.notes}</p>
                  )}
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="text-sm font-mono text-white">
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
          accent ? "text-accent" : "text-white"
        }`}
      >
        {value}
      </p>
    </div>
  );
}
