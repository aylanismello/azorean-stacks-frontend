import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

function getAuthClient(req: NextRequest) {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return req.cookies.getAll(); },
        setAll() {},
      },
    }
  );
}

// PATCH /api/tracks/[id] — update vote (writes to user_tracks ONLY, never tracks.status)
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = getServiceClient();
  const body = await req.json();
  const { status, super_liked, source_url } = body;

  // Auth required for all votes
  const authClient = getAuthClient(req);
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date().toISOString();

  // Super Like: upsert user_tracks with super_liked=true + approved
  if (super_liked === true) {
    await supabase
      .from("user_tracks")
      .upsert(
        { user_id: user.id, track_id: params.id, super_liked: true, status: "approved", voted_at: now },
        { onConflict: "user_id,track_id" }
      );

    const { data: track, error } = await supabase
      .from("tracks")
      .select("*")
      .eq("id", params.id)
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ...track, status: "approved", super_liked: true, voted_at: now });
  }

  // fix_source: user provided a corrected URL — update DB and let the engine re-download
  if (status === "fix_source" && source_url) {
    const validPrefixes = [
      "https://youtube.com",
      "https://youtu.be",
      "https://www.youtube.com",
      "https://soundcloud.com",
      "https://m.soundcloud.com",
    ];
    if (!validPrefixes.some((p) => (source_url as string).startsWith(p))) {
      return NextResponse.json({ error: "Invalid URL. Must be YouTube or SoundCloud." }, { status: 400 });
    }

    const isYoutube = (source_url as string).startsWith("https://youtube.com") ||
      (source_url as string).startsWith("https://youtu.be") ||
      (source_url as string).startsWith("https://www.youtube.com");

    // Fetch existing track data
    const { data: existing } = await supabase
      .from("tracks")
      .select("*, metadata, storage_path")
      .eq("id", params.id)
      .single();

    if (!existing) {
      return NextResponse.json({ error: "Track not found" }, { status: 404 });
    }

    // Delete old audio file from storage if it exists
    if (existing.storage_path) {
      await supabase.storage.from("tracks").remove([existing.storage_path]);
    }

    // Update track: set new URL, clear storage_path so engine re-downloads
    const updatedMeta = { ...(existing.metadata as Record<string, unknown> ?? {}) };
    if (!isYoutube) {
      updatedMeta.soundcloud_url = source_url;
    }
    updatedMeta.audio_source = isYoutube ? "youtube" : "soundcloud";

    const updatePayload = {
      youtube_url: isYoutube ? source_url : null,
      storage_path: null,
      status: "pending" as const,
      metadata: updatedMeta,
    };
    console.log(`[fix_source] Updating track ${params.id}:`, JSON.stringify(updatePayload));

    const { data: track, error } = await supabase
      .from("tracks")
      .update(updatePayload)
      .eq("id", params.id)
      .select("*")
      .single();

    if (error) {
      console.error(`[fix_source] Update failed for track ${params.id}:`, error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Insert a download request so the engine picks it up immediately via Realtime
    const sourceUrl = isYoutube ? source_url : source_url;
    const { data: dlRequest, error: dlReqErr } = await supabase
      .from("download_requests")
      .insert({
        track_id: params.id,
        youtube_url: sourceUrl as string,
        status: "pending",
      })
      .select("id")
      .single();

    if (dlReqErr || !dlRequest) {
      console.error(`[fix_source] download_request insert failed:`, dlReqErr);
      // Fallback: engine loop will pick it up eventually
      return NextResponse.json({ ...track, queued: true, message: "URL updated. Track will be re-downloaded by the engine shortly." });
    }

    // Poll for completion — check every 2s for up to 45s
    const POLL_INTERVAL = 2000;
    const MAX_WAIT = 45000;
    const startTime = Date.now();

    while (Date.now() - startTime < MAX_WAIT) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL));

      const { data: reqStatus } = await supabase
        .from("download_requests")
        .select("status, result_audio_url, error")
        .eq("id", dlRequest.id)
        .single();

      if (!reqStatus) break;

      if (reqStatus.status === "completed") {
        // Re-fetch the track with updated data
        const { data: updatedTrack } = await supabase
          .from("tracks")
          .select("*")
          .eq("id", params.id)
          .single();

        return NextResponse.json({
          ...(updatedTrack || track),
          audio_url: reqStatus.result_audio_url,
          downloaded: true,
          message: "Track downloaded successfully.",
        });
      }

      if (reqStatus.status === "failed") {
        return NextResponse.json({
          ...track,
          queued: false,
          error: reqStatus.error || "Download failed",
          message: reqStatus.error || "Download failed. You can try again.",
        }, { status: 502 });
      }
    }

    // Timeout — engine is still working on it
    return NextResponse.json({
      ...track,
      queued: true,
      message: "Download in progress — check back shortly.",
    });
  }

  if (!status || !["approved", "rejected", "pending", "skipped", "listened", "bad_source"].includes(status)) {
    return NextResponse.json(
      { error: "Invalid status. Must be: approved, rejected, pending, skipped, listened, bad_source" },
      { status: 400 }
    );
  }

  // 'listened' is a soft-skip: only set if no explicit vote exists yet
  if (status === "listened") {
    const { data: existing } = await supabase
      .from("user_tracks")
      .select("status")
      .eq("user_id", user.id)
      .eq("track_id", params.id)
      .maybeSingle();

    if (!existing || existing.status === "pending") {
      await supabase
        .from("user_tracks")
        .upsert(
          { user_id: user.id, track_id: params.id, status: "listened" },
          { onConflict: "user_id,track_id" }
        );
    }

    const { data: track, error: trackErr } = await supabase
      .from("tracks")
      .select("*")
      .eq("id", params.id)
      .single();
    if (trackErr) return NextResponse.json({ error: trackErr.message }, { status: 500 });
    return NextResponse.json({ ...track, status: existing?.status === "pending" || !existing ? "listened" : existing.status });
  }

  // All other votes: upsert to user_tracks only
  const votedAt = ["approved", "rejected", "skipped", "bad_source"].includes(status) ? now : undefined;

  const { error: upsertError } = await supabase
    .from("user_tracks")
    .upsert(
      {
        user_id: user.id,
        track_id: params.id,
        status,
        super_liked: false,
        ...(votedAt ? { voted_at: votedAt } : {}),
      },
      { onConflict: "user_id,track_id", ignoreDuplicates: false }
    );

  if (upsertError) {
    console.error(`Vote upsert failed for track ${params.id}:`, upsertError);
    return NextResponse.json({ error: `Vote failed: ${upsertError.message}` }, { status: 500 });
  }

  // Fetch track data to return
  const { data: track, error } = await supabase
    .from("tracks")
    .select("*")
    .eq("id", params.id)
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ...track, status, voted_at: votedAt || track.voted_at });
}

// GET /api/tracks/[id]
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("tracks")
    .select("*")
    .eq("id", params.id)
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }

  return NextResponse.json(data);
}
