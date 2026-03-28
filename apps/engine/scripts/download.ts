#!/usr/bin/env bun
/**
 * The Stacks — Background Downloader
 *
 * Runs independently from the main pipeline.
 * Finds approved tracks without audio and downloads them.
 * Failed tracks are tracked via dl_attempts / dl_failed_at columns
 * and skipped after 3 failures unless --force is passed.
 *
 * Usage:
 *   bun run download                  # new + not-yet-maxed tracks
 *   bun run download --force          # retry failed tracks too
 *   bun run download --limit 50       # cap batch size
 *   bun run download --duration 60    # loop for 60 minutes
 */
import { parseArgs } from "util";
import { getSupabase } from "../lib/supabase";
import { existsSync, mkdirSync, readFileSync, unlinkSync, readdirSync } from "fs";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    limit: { type: "string", default: "60" },
    force: { type: "boolean", default: false },
    duration: { type: "string" },
  },
  strict: false,
});

const batchLimit = parseInt(String(values.limit || "20"), 10);
const force = values.force || false;
const durationMinutes = values.duration ? parseInt(String(values.duration), 10) : null;
const deadline = durationMinutes ? Date.now() + durationMinutes * 60_000 : null;
const db = getSupabase();
const DL_CONCURRENCY = 15;
const TMP_DIR = "/tmp/stacks";
const DL_TIMEOUT = 90_000;
const MAX_ATTEMPTS = 3;
const YT_DLP_BIN =
  process.env.YT_DLP_BIN ||
  Bun.which("yt-dlp") ||
  "/opt/homebrew/bin/yt-dlp";

function sanitize(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s\-.,()&+]/g, "").replace(/\s+/g, " ").trim().slice(0, 100) || "unknown";
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout: ${label} after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!));
}

async function markFailed(track: any): Promise<void> {
  await db.from("tracks").update({
    dl_attempts: (track.dl_attempts || 0) + 1,
    dl_failed_at: new Date().toISOString(),
  }).eq("id", track.id);
}

async function markSuccess(track: any, storagePath: string, signedUrl: string): Promise<void> {
  await db.from("tracks").update({
    storage_path: storagePath,
    download_url: signedUrl,
    downloaded_at: new Date().toISOString(),
    dl_attempts: 0,
    dl_failed_at: null,
  }).eq("id", track.id);
}

async function tryDownloadUrl(url: string, videoId: string, label: string): Promise<{ ok: boolean; stderr: string }> {
  const outPath = `${TMP_DIR}/${videoId}.%(ext)s`;

  const dlProc = Bun.spawn(
    [YT_DLP_BIN, "-x", "--audio-format", "mp3", "--audio-quality", "0",
     "--no-playlist", "--no-warnings",
     "--retries", "3", "--fragment-retries", "3",
     "--socket-timeout", "30", "--extractor-retries", "3",
     "-o", outPath, url],
    { stdout: "ignore", stderr: "pipe" },
  );

  let exitCode: number;
  let stderrText = "";
  try {
    [stderrText, exitCode] = await Promise.all([
      withTimeout(new Response(dlProc.stderr).text(), DL_TIMEOUT + 5_000, "stderr").catch(() => ""),
      withTimeout(dlProc.exited, DL_TIMEOUT, label),
    ]);
  } catch (err) {
    try { dlProc.kill(); } catch {}
    return { ok: false, stderr: "timeout" };
  }
  return { ok: exitCode === 0, stderr: stderrText };
}

async function soundcloudFallback(artist: string, title: string): Promise<string | null> {
  try {
    const query = `${artist} ${title}`;
    const proc = Bun.spawn(
      [YT_DLP_BIN, "--print", "webpage_url", "--no-download", `scsearch1:${query}`],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [url, exitCode] = await Promise.all([
      withTimeout(new Response(proc.stdout).text(), 15_000, "sc-search").catch(() => ""),
      withTimeout(proc.exited, 15_000, "sc-search-exit").catch(() => 1),
    ]);
    if (exitCode === 0 && url.trim().startsWith("http")) return url.trim();
    return null;
  } catch {
    return null;
  }
}

async function downloadOne(track: any): Promise<boolean> {
  if (!track.youtube_url) return false;
  if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });

  const videoId = `dl-${track.id.slice(0, 8)}`;
  const expectedPath = `${TMP_DIR}/${videoId}.mp3`;
  const label = `${track.artist} - ${track.title}`;

  // Try primary URL (YouTube or SoundCloud)
  let result = await tryDownloadUrl(track.youtube_url, videoId, label);

  // If YouTube failed with bot/429 error, try SoundCloud fallback
  if (!result.ok && track.youtube_url.includes("youtube.com") &&
      (result.stderr.includes("Sign in to confirm") || result.stderr.includes("429"))) {
    console.log(`    ↳ YouTube blocked — trying SoundCloud for ${track.artist} - ${track.title}`);
    const scUrl = await soundcloudFallback(track.artist, track.title);
    if (scUrl) {
      result = await tryDownloadUrl(scUrl, videoId, label);
      if (result.ok) {
        // Update the track's youtube_url to the working SoundCloud URL
        await db.from("tracks").update({ youtube_url: scUrl }).eq("id", track.id);
        console.log(`    ↳ SoundCloud fallback worked!`);
      }
    }
  }

  if (!result.ok) {
    if (result.stderr.trim()) {
      console.error(`    yt-dlp error for ${label}: ${result.stderr.trim().slice(0, 200)}`);
    }
    await markFailed(track);
    return false;
  }

  let localPath = expectedPath;
  if (!existsSync(localPath)) {
    const f = readdirSync(TMP_DIR).find((f) => f.startsWith(videoId));
    if (f) localPath = `${TMP_DIR}/${f}`;
    else {
      await markFailed(track);
      return false;
    }
  }

  const storagePath = `${sanitize(track.artist)}/${sanitize(track.title)}.mp3`;
  const { error } = await db.storage.from("tracks").upload(storagePath, readFileSync(localPath), {
    contentType: "audio/mpeg", upsert: true,
  });
  if (error) {
    await markFailed(track);
    return false;
  }

  const { data: signed } = await db.storage.from("tracks").createSignedUrl(storagePath, 7 * 24 * 3600);
  await markSuccess(track, storagePath, signed?.signedUrl || "");

  try { unlinkSync(localPath); } catch {}
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Graceful shutdown
let shuttingDown = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (shuttingDown) { console.log("\n  Force quit."); process.exit(1); }
    shuttingDown = true;
    console.log(`\n  ${sig} received — finishing current batch then exiting...`);
  });
}

async function runOnce(): Promise<{ downloaded: number; failed: number; empty: boolean }> {
  let query = db.from("tracks").select("*")
    .is("storage_path", null).not("youtube_url", "is", null).neq("youtube_url", "")
    .in("status", ["pending", "approved"])
    .order("created_at").limit(batchLimit);

  if (!force) {
    query = query.lt("dl_attempts", MAX_ATTEMPTS);
  }

  const { data: tracks } = await query;

  if (!tracks?.length) {
    const { count } = await db.from("tracks").select("id", { count: "exact", head: true })
      .is("storage_path", null).not("youtube_url", "is", null).neq("youtube_url", "")
      .in("status", ["pending", "approved"])
      .gte("dl_attempts", MAX_ATTEMPTS);

    if (count && count > 0) {
      console.log(`  Nothing to do. ${count} track${count > 1 ? "s" : ""} skipped (failed ${MAX_ATTEMPTS}+ times).`);
      console.log(`  Run with --force to retry.`);
    } else {
      console.log(`  Nothing to download.`);
    }
    return { downloaded: 0, failed: 0, empty: true };
  }

  let downloaded = 0;
  let failed = 0;

  console.log(`  ${tracks.length} to download (${DL_CONCURRENCY} parallel)\n`);

  for (let i = 0; i < tracks.length; i += DL_CONCURRENCY) {
    if (shuttingDown) break;
    const batch = tracks.slice(i, i + DL_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (t) => {
        const ok = await downloadOne(t);
        const attempt = (t.dl_attempts || 0) + (ok ? 0 : 1);
        console.log(`  ${ok ? "\u2713" : "\u2717"} ${t.artist} - ${t.title}${ok ? "" : ` (${attempt}/${MAX_ATTEMPTS})`}`);
        return ok;
      }),
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) downloaded++;
      else failed++;
    }
  }

  return { downloaded, failed, empty: false };
}

async function cleanupStaleTemps() {
  if (!existsSync(TMP_DIR)) return;
  try {
    const files = readdirSync(TMP_DIR);
    if (files.length > 0) {
      let cleaned = 0;
      for (const f of files) {
        try { unlinkSync(`${TMP_DIR}/${f}`); cleaned++; } catch {}
      }
      if (cleaned > 0) console.log(`  Cleaned ${cleaned} stale temp file(s)`);
    }
  } catch {}
}

async function main() {
  const start = Date.now();
  const mode = deadline ? `looping for ${durationMinutes}m` : "single run";
  console.log(`\n  The Stacks — Downloader${force ? " (force retry)" : ""}`);
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Mode: ${mode}\n`);

  await cleanupStaleTemps();

  let totalDownloaded = 0;
  let totalFailed = 0;
  let runs = 0;

  do {
    if (shuttingDown) break;
    runs++;
    if (deadline) console.log(`\n  ── Run #${runs} (${Math.max(0, Math.ceil((deadline - Date.now()) / 60_000))}m remaining) ──`);

    const { downloaded, failed, empty } = await runOnce();
    totalDownloaded += downloaded;
    totalFailed += failed;

    // If nothing left to download and we're looping, wait before polling again
    if (deadline && !shuttingDown && Date.now() < deadline) {
      const waitTime = empty ? 60_000 : 10_000; // longer pause when queue is drained
      const cooldown = Math.min(waitTime, deadline - Date.now());
      if (cooldown > 2_000) {
        console.log(`  ${empty ? "Queue empty — waiting" : "Cooling down"} ${(cooldown / 1000).toFixed(0)}s before next run...`);
        await sleep(cooldown);
      }
    }
  } while (deadline && Date.now() < deadline && !shuttingDown);

  const elapsed = ((Date.now() - start) / 1000);
  const elapsedStr = elapsed < 60 ? `${elapsed.toFixed(1)}s` : `${(elapsed / 60).toFixed(1)}m`;

  console.log(`\n  ── Done (${elapsedStr}, ${runs} run${runs > 1 ? "s" : ""}) ──`);
  console.log(`  Downloaded: ${totalDownloaded}`);
  if (totalFailed > 0) console.log(`  Failed:     ${totalFailed}`);
  console.log();
}

main().catch((err) => {
  console.error("Downloader failed:", err);
  process.exit(1);
});
