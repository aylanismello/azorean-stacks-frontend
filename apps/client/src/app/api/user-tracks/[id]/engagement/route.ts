import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// PATCH /api/user-tracks/[id]/engagement
// [id] is the track_id (not user_track id).
// Updates listen_pct, listen_duration_ms, action_delay_ms on the user's
// user_tracks row. Creates the row (status=pending) if it doesn't exist yet.
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
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
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const { listen_pct, listen_duration_ms, action_delay_ms } = body;

  // Validate
  if (
    (listen_pct !== undefined && (typeof listen_pct !== "number" || listen_pct < 0 || listen_pct > 100)) ||
    (listen_duration_ms !== undefined && typeof listen_duration_ms !== "number") ||
    (action_delay_ms !== undefined && action_delay_ms !== null && typeof action_delay_ms !== "number")
  ) {
    return NextResponse.json({ error: "Invalid engagement data" }, { status: 400 });
  }

  const db = getServiceClient();
  const trackId = params.id;

  // Upsert: create row if missing (with status=pending), always update engagement fields.
  // Only update engagement fields if they have non-null values.
  const updates: Record<string, unknown> = {};
  if (listen_pct !== undefined) updates.listen_pct = listen_pct;
  if (listen_duration_ms !== undefined) updates.listen_duration_ms = listen_duration_ms;
  if (action_delay_ms !== undefined) updates.action_delay_ms = action_delay_ms;

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ ok: true });
  }

  const { error } = await db
    .from("user_tracks")
    .upsert(
      {
        user_id: user.id,
        track_id: trackId,
        status: "pending",
        ...updates,
      },
      { onConflict: "user_id,track_id" }
    );

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
