import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const db = getServiceClient();

    // Auth for user-specific rejected count
    const auth = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() { return req.cookies.getAll(); },
          setAll() {},
        },
      }
    );
    const { data: { user } } = await auth.auth.getUser();

    // ── Pipeline breakdown ──────────────────────────────────────────────

    // Total tracks
    const { count: total } = await db
      .from("tracks")
      .select("id", { count: "exact", head: true });

    // ── Mutually exclusive categories (by status first, then data) ──
    // Status is pipeline state only. User votes are in user_tracks.

    // 1. Rejected by current user (from user_tracks)
    let rejected = 0;
    if (user) {
      const { count: rejectedCount } = await db
        .from("user_tracks").select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .eq("status", "rejected");
      rejected = rejectedCount || 0;
    }

    // 2. Skipped (unfindable online)
    const { count: skippedUnfindable } = await db
      .from("tracks").select("id", { count: "exact", head: true })
      .eq("status", "skipped");

    // 3. Failed (enrichment or system error)
    const { count: failedTracks } = await db
      .from("tracks").select("id", { count: "exact", head: true })
      .eq("status", "failed");

    // 4. Downloaded (has audio file, not rejected/skipped/failed)
    const { count: downloaded } = await db
      .from("tracks").select("id", { count: "exact", head: true })
      .not("storage_path", "is", null)
      .in("status", ["pending", "approved"]);

    // 5. Pending download (has youtube_url, no storage_path, status pending/approved)
    const { count: pendingDownload } = await db
      .from("tracks").select("id", { count: "exact", head: true })
      .not("youtube_url", "is", null).neq("youtube_url", "")
      .is("storage_path", null)
      .in("status", ["pending", "approved"]);

    // 6. Pending enrichment (no youtube_url yet, status pending/approved)
    const { count: pendingEnrichment } = await db
      .from("tracks").select("id", { count: "exact", head: true })
      .or("youtube_url.is.null,youtube_url.eq.")
      .is("storage_path", null)
      .in("status", ["pending", "approved"]);

    const totalCount = total ?? 0;
    const downloadedCount = downloaded ?? 0;
    const pendingEnrichmentCount = pendingEnrichment ?? 0;
    const pendingDownloadCount = pendingDownload ?? 0;
    const skippedCount = skippedUnfindable ?? 0;
    const failedDownloadCount = 0; // merged into failed
    const failedEnrichmentCount = failedTracks ?? 0;
    const rejectedCount = rejected ?? 0;

    const pct = (n: number) =>
      totalCount > 0 ? Math.round((n / totalCount) * 1000) / 10 : 0;

    // ── Enrichment sources ──────────────────────────────────────────────

    // Spotify only: has spotify_url (non-empty), no youtube_url
    const { count: spotifyOnly } = await db
      .from("tracks")
      .select("id", { count: "exact", head: true })
      .not("spotify_url", "is", null)
      .neq("spotify_url", "")
      .is("youtube_url", null);

    // YouTube only: has youtube_url, no spotify_url (or empty)
    const { count: youtubeOnly } = await db
      .from("tracks")
      .select("id", { count: "exact", head: true })
      .not("youtube_url", "is", null)
      .or("spotify_url.is.null,spotify_url.eq.");

    // SoundCloud: metadata->>'audio_source' = 'soundcloud'
    const { count: soundcloud } = await db
      .from("tracks")
      .select("id", { count: "exact", head: true })
      .eq("metadata->>audio_source", "soundcloud");

    // MusicBrainz: metadata->>'musicbrainz_id' is not null
    const { count: musicbrainz } = await db
      .from("tracks")
      .select("id", { count: "exact", head: true })
      .not("metadata->>musicbrainz_id", "is", null);

    // Both Spotify + YouTube
    const { count: bothSpotifyYoutube } = await db
      .from("tracks")
      .select("id", { count: "exact", head: true })
      .not("spotify_url", "is", null)
      .neq("spotify_url", "")
      .not("youtube_url", "is", null);

    // No match: no spotify and no youtube
    const { count: noMatch } = await db
      .from("tracks")
      .select("id", { count: "exact", head: true })
      .or("spotify_url.is.null,spotify_url.eq.")
      .is("youtube_url", null);

    // ── Watcher status ──────────────────────────────────────────────────

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

    // ── Last discover run ───────────────────────────────────────────────

    const { data: discoverRuns } = await db
      .from("discovery_runs")
      .select("completed_at, started_at, tracks_found, tracks_added")
      .order("completed_at", { ascending: false })
      .limit(1);

    const lastDiscover = discoverRuns?.[0] ?? null;

    // ── Last download event ─────────────────────────────────────────────

    const { data: downloadEvents } = await db
      .from("engine_events")
      .select("created_at, metadata")
      .in("event_type", ["download_completed", "super_like_completed", "batch_download_completed"])
      .order("created_at", { ascending: false })
      .limit(1);

    const lastDownloadEvent = downloadEvents?.[0] ?? null;

    // ── Throughput rates (last 10 min) ──────────────────────────────────

    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    const { count: enrichEventsCount } = await db
      .from("engine_events")
      .select("id", { count: "exact", head: true })
      .in("event_type", ["enrich_completed"])
      .gte("created_at", tenMinAgo);

    const { count: downloadEventsCount } = await db
      .from("engine_events")
      .select("id", { count: "exact", head: true })
      .in("event_type", ["download_drain_completed", "batch_download_completed", "super_like_completed"])
      .gte("created_at", tenMinAgo);

    const enrichRate = Math.round(((enrichEventsCount ?? 0) / 10) * 10) / 10;
    const downloadRate = Math.round(((downloadEventsCount ?? 0) / 10) * 10) / 10;

    const etaEnrichment = enrichRate > 0
      ? Math.round(pendingEnrichmentCount / enrichRate)
      : null;

    const etaDownload = downloadRate > 0
      ? Math.round(pendingDownloadCount / downloadRate)
      : null;

    return NextResponse.json({
      pipeline: {
        total: totalCount,
        pending_enrichment: pendingEnrichmentCount,
        pending_download: pendingDownloadCount,
        downloaded: downloadedCount,
        skipped_unfindable: skippedCount,
        failed_download: failedDownloadCount,
        failed_enrichment: failedEnrichmentCount,
        rejected: rejectedCount,
        percentages: {
          pending_enrichment: pct(pendingEnrichmentCount),
          pending_download: pct(pendingDownloadCount),
          downloaded: pct(downloadedCount),
          skipped_unfindable: pct(skippedCount),
          failed_download: pct(failedDownloadCount),
          failed_enrichment: pct(failedEnrichmentCount),
          rejected: pct(rejectedCount),
        },
      },
      enrichment_sources: {
        spotify_only: spotifyOnly ?? 0,
        youtube_only: youtubeOnly ?? 0,
        soundcloud: soundcloud ?? 0,
        musicbrainz: musicbrainz ?? 0,
        both_spotify_youtube: bothSpotifyYoutube ?? 0,
        no_match: noMatch ?? 0,
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
      enrichment_rate: enrichRate,
      download_rate: downloadRate,
      eta_enrichment: etaEnrichment,
      eta_download: etaDownload,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
