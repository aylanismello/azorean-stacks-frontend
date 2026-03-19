import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// PATCH /api/tracks/[id] — update track status (vote)
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = getServiceClient();
  const body = await req.json();
  const { status, super_liked } = body;

  // Super Like: set super_liked=true, approve, and stamp voted_at
  if (super_liked === true) {
    const updates: Record<string, unknown> = {
      status: "approved",
      voted_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from("tracks")
      .update(updates)
      .eq("id", params.id)
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Get the authed user so we can upsert user_tracks (watcher needs the row to exist)
    const authClient = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() { return req.cookies.getAll(); },
          setAll() {},
        },
      }
    );
    const { data: { user } } = await authClient.auth.getUser();

    if (user) {
      // Upsert so the row is created if it doesn't exist — watcher fires on UPDATE super_liked=true
      await supabase
        .from("user_tracks")
        .upsert(
          { user_id: user.id, track_id: params.id, super_liked: true, status: "approved", voted_at: updates.voted_at },
          { onConflict: "user_id,track_id" }
        );
    }

    return NextResponse.json({ ...data, super_liked: true });
  }

  if (!status || !["approved", "rejected", "pending", "skipped", "listened", "bad_source"].includes(status)) {
    return NextResponse.json(
      { error: "Invalid status. Must be: approved, rejected, pending, skipped, listened, bad_source" },
      { status: 400 }
    );
  }

  // Get authed user for user_tracks write (all votes, not just super_like)
  const authClient = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return req.cookies.getAll(); },
        setAll() {},
      },
    }
  );
  const { data: { user } } = await authClient.auth.getUser();

  // 'listened' is a soft-skip: only update user_tracks, not the global tracks table.
  // Guard: only set 'listened' if no explicit vote has been made yet (status must be 'pending').
  if (status === "listened") {
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
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
    return NextResponse.json(track);
  }

  const updates: Record<string, unknown> = { status };

  if (status === "approved" || status === "rejected" || status === "skipped" || status === "bad_source") {
    updates.voted_at = new Date().toISOString();
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

  // Record vote in user_tracks for all voted statuses (enables weight tuning + engagement analytics)
  // Reset super_liked when changing vote — handles re-votes from super-like to regular vote
  if (user && (status === "approved" || status === "rejected" || status === "skipped" || status === "bad_source")) {
    await supabase
      .from("user_tracks")
      .upsert(
        { user_id: user.id, track_id: params.id, status, super_liked: false, voted_at: updates.voted_at },
        { onConflict: "user_id,track_id", ignoreDuplicates: false }
      );
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
