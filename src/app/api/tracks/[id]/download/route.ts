import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { execFile } from "child_process";
import { readFileSync, unlinkSync, existsSync, mkdirSync, readdirSync } from "fs";

// GET /api/tracks/[id]/download — get download URL
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = getServiceClient();
  const { data: track, error } = await supabase
    .from("tracks")
    .select("id, storage_path, download_url, artist, title")
    .eq("id", params.id)
    .single();

  if (error || !track) {
    return NextResponse.json({ error: "Track not found" }, { status: 404 });
  }

  // If we have a file in Supabase Storage, generate a signed URL
  if (track.storage_path) {
    const { data: signed, error: signError } = await supabase.storage
      .from("tracks")
      .createSignedUrl(track.storage_path, 3600); // 1 hour

    if (signError || !signed) {
      return NextResponse.json(
        { error: "Failed to generate download URL" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      url: signed.signedUrl,
      filename: `${track.artist} - ${track.title}`.replace(/[/\\?%*:|"<>]/g, ""),
    });
  }

  // If we have an external download URL
  if (track.download_url) {
    return NextResponse.json({
      url: track.download_url,
      filename: `${track.artist} - ${track.title}`.replace(/[/\\?%*:|"<>]/g, ""),
    });
  }

  return NextResponse.json(
    { error: "No download available yet", queued: true },
    { status: 202 }
  );
}

function sanitize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s\-.,()&+]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100) || "unknown";
}

function ytdlp(url: string, outPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = execFile(
      "yt-dlp",
      ["-x", "--audio-format", "mp3", "--audio-quality", "0", "--no-playlist", "--no-warnings", "-o", outPath, url],
      { timeout: 120_000 },
      (err) => {
        if (err && "code" in err && typeof err.code === "number") {
          resolve(err.code);
        } else if (err) {
          reject(err);
        } else {
          resolve(0);
        }
      }
    );
  });
}

// POST /api/tracks/[id]/download — attempt on-demand download
export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = getServiceClient();
  const { data: track, error } = await supabase
    .from("tracks")
    .select("id, storage_path, youtube_url, artist, title, dl_attempts, dl_failed_at")
    .eq("id", params.id)
    .single();

  if (error || !track) {
    return NextResponse.json({ error: "Track not found" }, { status: 404 });
  }

  // Already has audio
  if (track.storage_path) {
    const { data: signed } = await supabase.storage
      .from("tracks")
      .createSignedUrl(track.storage_path, 3600);
    return NextResponse.json({ success: true, audio_url: signed?.signedUrl });
  }

  // No youtube URL to try
  if (!track.youtube_url) {
    await supabase.from("tracks").update({
      dl_attempts: (track.dl_attempts || 0) + 1,
      dl_failed_at: new Date().toISOString(),
    }).eq("id", track.id);
    return NextResponse.json({ error: "No source URL available to download" }, { status: 404 });
  }

  // Attempt download
  const tmpDir = "/tmp/stacks-api";
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });

  const videoId = `dl-${track.id.slice(0, 8)}`;
  const outPath = `${tmpDir}/${videoId}.%(ext)s`;
  const expectedPath = `${tmpDir}/${videoId}.mp3`;

  try {
    const exitCode = await ytdlp(track.youtube_url, outPath);

    if (exitCode !== 0) {
      await supabase.from("tracks").update({
        dl_attempts: (track.dl_attempts || 0) + 1,
        dl_failed_at: new Date().toISOString(),
      }).eq("id", track.id);
      return NextResponse.json({ error: "Download failed" }, { status: 502 });
    }

    // Find the output file
    let localPath = expectedPath;
    if (!existsSync(localPath)) {
      const f = readdirSync(tmpDir).find((f) => f.startsWith(videoId));
      if (f) localPath = `${tmpDir}/${f}`;
      else {
        await supabase.from("tracks").update({
          dl_attempts: (track.dl_attempts || 0) + 1,
          dl_failed_at: new Date().toISOString(),
        }).eq("id", track.id);
        return NextResponse.json({ error: "Download produced no file" }, { status: 502 });
      }
    }

    // Upload to Supabase Storage
    const storagePath = `${sanitize(track.artist)}/${sanitize(track.title)}.mp3`;
    const { error: uploadError } = await supabase.storage
      .from("tracks")
      .upload(storagePath, readFileSync(localPath), {
        contentType: "audio/mpeg",
        upsert: true,
      });

    // Clean up temp file
    try { unlinkSync(localPath); } catch {}

    if (uploadError) {
      await supabase.from("tracks").update({
        dl_attempts: (track.dl_attempts || 0) + 1,
        dl_failed_at: new Date().toISOString(),
      }).eq("id", track.id);
      return NextResponse.json({ error: "Upload to storage failed" }, { status: 500 });
    }

    // Generate signed URL
    const { data: signed } = await supabase.storage
      .from("tracks")
      .createSignedUrl(storagePath, 3600);

    // Update track record
    await supabase.from("tracks").update({
      storage_path: storagePath,
      download_url: signed?.signedUrl || "",
      downloaded_at: new Date().toISOString(),
      dl_attempts: 0,
      dl_failed_at: null,
    }).eq("id", track.id);

    return NextResponse.json({
      success: true,
      audio_url: signed?.signedUrl,
      storage_path: storagePath,
    });
  } catch (err) {
    await supabase.from("tracks").update({
      dl_attempts: (track.dl_attempts || 0) + 1,
      dl_failed_at: new Date().toISOString(),
    }).eq("id", track.id);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Download failed" },
      { status: 500 }
    );
  }
}
