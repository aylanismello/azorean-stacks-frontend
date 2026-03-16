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

  const { data, error } = await supabase
    .from("seeds")
    .update(updates)
    .eq("id", params.id)
    .or(`user_id.eq.${user.id},user_id.is.null`)
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

  // discovery_runs.seed_id does not cascade on delete, so clean up history first
  const { error: runsError } = await supabase
    .from("discovery_runs")
    .delete()
    .eq("seed_id", params.id);

  if (runsError) {
    return NextResponse.json({ error: runsError.message }, { status: 500 });
  }

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
