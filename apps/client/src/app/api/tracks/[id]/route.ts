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
  const { status, super_liked } = body;

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
  // DB constraint allows: pending, approved, rejected, skipped, listened
  // bad_source is stored as 'rejected' with notes='bad_source' to distinguish it
  const dbStatus = status === "bad_source" ? "rejected" : status;
  const notes = status === "bad_source" ? "bad_source" : undefined;
  const votedAt = ["approved", "rejected", "skipped", "bad_source"].includes(status) ? now : undefined;

  const { error: upsertError } = await supabase
    .from("user_tracks")
    .upsert(
      {
        user_id: user.id,
        track_id: params.id,
        status: dbStatus,
        super_liked: false,
        ...(votedAt ? { voted_at: votedAt } : {}),
        ...(notes ? { notes } : {}),
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
