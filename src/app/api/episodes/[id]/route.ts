import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// PATCH /api/episodes/[id] — update episode (e.g. mark as skipped)
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = getServiceClient();
  const { id } = await params;
  const body = await req.json();

  const updates: Record<string, unknown> = {};

  if (typeof body.skipped === "boolean") {
    updates.skipped = body.skipped;
    updates.skipped_at = body.skipped ? new Date().toISOString() : null;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  const { error } = await supabase
    .from("episodes")
    .update(updates)
    .eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // When skipping, reject all pending tracks and delete their audio from storage
  if (body.skipped) {
    const now = new Date().toISOString();

    // Find tracks that have audio files to clean up
    const { data: tracksWithAudio } = await supabase
      .from("tracks")
      .select("id, storage_path")
      .eq("episode_id", id)
      .eq("status", "pending")
      .not("storage_path", "is", null);

    // Delete audio files from bucket
    if (tracksWithAudio && tracksWithAudio.length > 0) {
      const paths = tracksWithAudio.map((t: { storage_path: string }) => t.storage_path);
      const { error: storageError } = await supabase.storage
        .from("tracks")
        .remove(paths);

      if (storageError) {
        console.error("Failed to delete storage files on episode skip:", storageError);
      }
    }

    // Reject all pending tracks and clear storage references
    await supabase
      .from("tracks")
      .update({
        status: "rejected",
        voted_at: now,
        storage_path: null,
        download_url: null,
      })
      .eq("episode_id", id)
      .eq("status", "pending");
  }

  return NextResponse.json({ ok: true });
}
