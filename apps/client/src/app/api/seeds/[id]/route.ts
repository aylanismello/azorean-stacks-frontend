import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

async function getAuthenticatedUser(req: NextRequest) {
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return req.cookies.getAll();
        },
        setAll() {
          // Read-only access to auth cookies in route handlers.
        },
      },
    }
  );

  return supabase.auth.getUser();
}

// PATCH /api/seeds/[id] — toggle active
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = getServiceClient();
  const {
    data: { user },
  } = await getAuthenticatedUser(req);

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();

  const updates: Record<string, unknown> = {};
  if (typeof body.active === "boolean") {
    updates.active = body.active;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  // Only allow updating seeds owned by the current user.
  // Legacy seeds with user_id=NULL are claimed on first update.
  const { data: existing } = await supabase
    .from("seeds")
    .select("user_id")
    .eq("id", params.id)
    .single();

  if (existing && existing.user_id && existing.user_id !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Claim unowned seeds on update
  if (existing && !existing.user_id) {
    updates.user_id = user.id;
  }

  const { data, error } = await supabase
    .from("seeds")
    .update(updates)
    .eq("id", params.id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data);
}

// DELETE /api/seeds/[id]
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = getServiceClient();
  const {
    data: { user },
  } = await getAuthenticatedUser(req);

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ── Cascade cleanup ──

  // 1. Delete discovery_runs (no FK cascade)
  await supabase.from("discovery_runs").delete().eq("seed_id", params.id);

  // 2. Get the seed's track_id so we can find tracks discovered via this seed
  const { data: seed } = await supabase
    .from("seeds")
    .select("track_id")
    .eq("id", params.id)
    .single();

  const seedTrackId = seed?.track_id || null;

  // 3. Delete pending tracks discovered by this seed (keep voted ones for taste signals)
  if (seedTrackId) {
    // Delete storage files for pending tracks before removing them
    const { data: pendingTracks } = await supabase
      .from("tracks")
      .select("id, storage_path")
      .eq("seed_track_id", seedTrackId)
      .eq("status", "pending");

    if (pendingTracks?.length) {
      // Remove storage files
      const storagePaths = pendingTracks
        .map((t: any) => t.storage_path)
        .filter(Boolean);
      if (storagePaths.length > 0) {
        await supabase.storage.from("tracks").remove(storagePaths);
      }

      // Delete the pending tracks
      const pendingIds = pendingTracks.map((t: any) => t.id);
      await supabase.from("episode_tracks").delete().in("track_id", pendingIds);
      await supabase.from("user_tracks").delete().in("track_id", pendingIds);
      await supabase.from("tracks").delete().in("id", pendingIds);
    }

    // Null out seed_track_id on remaining voted tracks (they keep metadata.seed_artist/title)
    await supabase
      .from("tracks")
      .update({ seed_track_id: null })
      .eq("seed_track_id", seedTrackId);
  }

  // 4. Remove episode_seeds links for this seed
  const { data: episodeLinks } = await supabase
    .from("episode_seeds")
    .select("episode_id")
    .eq("seed_id", params.id);

  await supabase.from("episode_seeds").delete().eq("seed_id", params.id);

  // 5. Clean up orphaned episodes (no remaining seed links)
  // Skip independently-crawled sources (e.g. lotradio) — they exist regardless of seeds
  if (episodeLinks?.length) {
    for (const link of episodeLinks) {
      const { data: episode } = await supabase
        .from("episodes")
        .select("source")
        .eq("id", link.episode_id)
        .single();

      if (episode?.source === "lotradio") continue;

      const { count } = await supabase
        .from("episode_seeds")
        .select("*", { count: "exact", head: true })
        .eq("episode_id", link.episode_id);

      if (count === 0) {
        // Check if episode still has any tracks (voted ones we kept)
        const { count: trackCount } = await supabase
          .from("tracks")
          .select("*", { count: "exact", head: true })
          .eq("episode_id", link.episode_id);

        if (trackCount === 0) {
          // Fully orphaned — delete episode
          await supabase.from("episode_tracks").delete().eq("episode_id", link.episode_id);
          await supabase.from("episodes").delete().eq("id", link.episode_id);
        }
      }
    }
  }

  // 6. Delete the seed itself
  const { error } = await supabase
    .from("seeds")
    .delete()
    .eq("id", params.id)
    .or(`user_id.eq.${user.id},user_id.is.null`);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ deleted: true });
}
