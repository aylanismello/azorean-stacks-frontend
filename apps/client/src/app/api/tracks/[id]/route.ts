import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { getServiceClient } from "@/lib/supabase";
import { spawn } from "child_process";
import { readFileSync, unlinkSync, existsSync } from "fs";

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

  // fix_source: user provided a corrected URL — download inline via yt-dlp, upload to storage
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
      .select("*, metadata, storage_path, artist, title")
      .eq("id", params.id)
      .single();

    if (!existing) {
      return NextResponse.json({ error: "Track not found" }, { status: 404 });
    }

    // Delete old audio file from storage if it exists
    if (existing.storage_path) {
      await supabase.storage.from("tracks").remove([existing.storage_path]);
    }

    // Download via yt-dlp inline
    const tmpPath = `/tmp/fix-source-${params.id}.mp3`;
    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn("/opt/homebrew/bin/yt-dlp", [
          "-x", "--audio-format", "mp3", "--audio-quality", "0",
          "--no-playlist", "--no-warnings",
          "-o", tmpPath,
          source_url as string,
        ]);
        let stderr = "";
        proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
        const timer = setTimeout(() => { proc.kill("SIGTERM"); reject(new Error("Download timed out after 60s")); }, 60_000);
        proc.on("close", (code) => {
          clearTimeout(timer);
          if (code !== 0) reject(new Error(`yt-dlp exited with code ${code}: ${stderr.slice(-500)}`));
          else resolve();
        });
        proc.on("error", (err) => { clearTimeout(timer); reject(err); });
      });
    } catch (dlErr: any) {
      console.error(`[fix_source] Download failed for track ${params.id}:`, dlErr.message);
      // Clean up tmp file if it exists
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
      return NextResponse.json({ error: `Download failed: ${dlErr.message}` }, { status: 500 });
    }

    // Upload to Supabase storage using same path pattern as engine
    const sanitize = (s: string): string =>
      s.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[^\w\s\-.,()&+]/g, "").replace(/\s+/g, " ").trim().slice(0, 100) || "unknown";
    const storagePath = `${sanitize(existing.artist)}/${sanitize(existing.title)}.mp3`;

    let fileBuffer: Buffer;
    try {
      fileBuffer = readFileSync(tmpPath);
    } catch {
      return NextResponse.json({ error: "Downloaded file not found" }, { status: 500 });
    } finally {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    }

    const { error: uploadErr } = await supabase.storage.from("tracks").upload(storagePath, fileBuffer, {
      contentType: "audio/mpeg", upsert: true,
    });
    if (uploadErr) {
      console.error(`[fix_source] Upload failed for track ${params.id}:`, uploadErr);
      return NextResponse.json({ error: `Upload failed: ${uploadErr.message}` }, { status: 500 });
    }

    // Generate signed URL
    const { data: signed } = await supabase.storage.from("tracks").createSignedUrl(storagePath, 3600);

    // Update track record
    const updatedMeta = { ...(existing.metadata as Record<string, unknown> ?? {}) };
    if (!isYoutube) {
      updatedMeta.soundcloud_url = source_url;
    }
    updatedMeta.audio_source = isYoutube ? "youtube" : "soundcloud";

    const updatePayload = {
      youtube_url: isYoutube ? source_url : null,
      storage_path: storagePath,
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

    // Return track with audio_url so frontend can play immediately
    return NextResponse.json({ ...track, audio_url: signed?.signedUrl || null });
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
