import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const db = getServiceClient();

    // Track pipeline breakdown — need counts from tracks table
    // We fetch counts via RPC-style raw queries using supabase filters

    // Total tracks
    const { count: total } = await db
      .from("tracks")
      .select("id", { count: "exact", head: true });

    // Failed: status = 'failed' OR spotify_url = '' (union via .or)
    const { count: failedUnion } = await db
      .from("tracks")
      .select("id", { count: "exact", head: true })
      .or("status.eq.failed,spotify_url.eq.");

    // Downloaded: storage_path IS NOT NULL
    const { count: downloaded } = await db
      .from("tracks")
      .select("id", { count: "exact", head: true })
      .not("storage_path", "is", null);

    // Enriched (not downloaded): (spotify_url IS NOT NULL OR youtube_url IS NOT NULL) AND storage_path IS NULL AND status = 'pending'
    // Use .or for spotify_url/youtube_url, then filter out downloaded + failed
    const { count: enriched } = await db
      .from("tracks")
      .select("id", { count: "exact", head: true })
      .or("spotify_url.not.is.null,youtube_url.not.is.null")
      .is("storage_path", null)
      .eq("status", "pending")
      .neq("spotify_url", "");

    // Pending (not enriched): status = 'pending' AND spotify_url IS NULL AND youtube_url IS NULL
    const { count: pending } = await db
      .from("tracks")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending")
      .is("spotify_url", null)
      .is("youtube_url", null);

    const totalCount = total ?? 0;
    const downloadedCount = downloaded ?? 0;
    const enrichedCount = enriched ?? 0;
    const pendingCount = pending ?? 0;
    const failedCount = failedUnion ?? 0;

    const pct = (n: number) =>
      totalCount > 0 ? Math.round((n / totalCount) * 1000) / 10 : 0;

    // Watcher: last watcher_connected OR watcher_reconnect event — ONLINE if within last 10 min
    // watcher_reconnect is emitted after reconnects and replaces watcher_connected in that scenario
    const { data: watcherEvents } = await db
      .from("engine_events")
      .select("created_at, event_type")
      .in("event_type", ["watcher_connected", "watcher_reconnect"])
      .order("created_at", { ascending: false })
      .limit(1);

    const lastWatcherEvent = watcherEvents?.[0] ?? null;
    const connectedAt = lastWatcherEvent?.created_at ?? null;
    const online =
      connectedAt != null &&
      Date.now() - new Date(connectedAt).getTime() < 30 * 60 * 1000;

    // Last discover run
    const { data: discoverRuns } = await db
      .from("discovery_runs")
      .select("completed_at, started_at, tracks_found, tracks_added")
      .order("completed_at", { ascending: false })
      .limit(1);

    const lastDiscover = discoverRuns?.[0] ?? null;

    // Last download run: look for download_completed or super_like_completed engine events
    const { data: downloadEvents } = await db
      .from("engine_events")
      .select("created_at, metadata")
      .in("event_type", ["download_completed", "super_like_completed", "batch_download_completed"])
      .order("created_at", { ascending: false })
      .limit(1);

    const lastDownloadEvent = downloadEvents?.[0] ?? null;

    return NextResponse.json({
      tracks: {
        total: totalCount,
        pending: pendingCount,
        enriched: enrichedCount,
        downloaded: downloadedCount,
        failed: failedCount,
        pending_pct: pct(pendingCount),
        enriched_pct: pct(enrichedCount),
        downloaded_pct: pct(downloadedCount),
        failed_pct: pct(failedCount),
      },
      watcher: {
        online,
        connected_at: connectedAt,
        event_type: lastWatcherEvent?.event_type ?? null,
      },
      last_discover: lastDiscover
        ? {
            at: lastDiscover.completed_at ?? lastDiscover.started_at,
            tracks_found: lastDiscover.tracks_found ?? 0,
          }
        : null,
      last_download: lastDownloadEvent
        ? {
            at: lastDownloadEvent.created_at,
            tracks_downloaded:
              (lastDownloadEvent.metadata as Record<string, unknown>)?.count ??
              1,
          }
        : null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
