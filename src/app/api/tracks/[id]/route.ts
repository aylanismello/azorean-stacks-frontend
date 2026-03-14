import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// PATCH /api/tracks/[id] — update track status (vote)
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = getServiceClient();
  const body = await req.json();
  const { status } = body;

  if (!status || !["approved", "rejected", "downloaded", "pending"].includes(status)) {
    return NextResponse.json(
      { error: "Invalid status. Must be: approved, rejected, downloaded, pending" },
      { status: 400 }
    );
  }

  const updates: Record<string, unknown> = { status };

  if (status === "approved" || status === "rejected") {
    updates.voted_at = new Date().toISOString();
  }
  if (status === "downloaded") {
    updates.downloaded_at = new Date().toISOString();
  }

  // If rejecting, delete the audio file from storage
  if (status === "rejected") {
    const { data: track } = await supabase
      .from("tracks")
      .select("storage_path")
      .eq("id", params.id)
      .single();

    if (track?.storage_path) {
      const { error: storageError } = await supabase.storage
        .from("tracks")
        .remove([track.storage_path]);

      if (storageError) {
        console.error(`Failed to delete storage file ${track.storage_path}:`, storageError);
        return NextResponse.json(
          { error: `Failed to delete audio file: ${storageError.message}` },
          { status: 500 }
        );
      }

      updates.storage_path = null;
      updates.download_url = null;
    }
  }

  const { data, error } = await supabase
    .from("tracks")
    .update(updates)
    .eq("id", params.id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data);
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
