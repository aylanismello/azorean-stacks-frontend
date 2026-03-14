import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// GET /api/curators — list curators sorted by seed relevance
export async function GET(req: NextRequest) {
  const db = getServiceClient();
  const { searchParams } = req.nextUrl;
  const limit = parseInt(searchParams.get("limit") || "50", 10);
  const offset = parseInt(searchParams.get("offset") || "0", 10);

  // Fetch curators
  const { data: curators, error } = await db
    .from("curators")
    .select("*");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Episode counts per curator
  const { data: epRows } = await db
    .from("episodes")
    .select("curator_id")
    .not("curator_id", "is", null);

  const epCountMap: Record<string, number> = {};
  for (const r of epRows || []) {
    if (r.curator_id) epCountMap[r.curator_id] = (epCountMap[r.curator_id] || 0) + 1;
  }

  // Seed-matched episode counts per curator (via RPC)
  const { data: matchRows } = await db.rpc("curator_seed_stats");
  const matchMap: Record<string, number> = {};
  for (const r of (matchRows || []) as any[]) {
    matchMap[r.curator_id] = Number(r.matched_episodes);
  }

  // Shape and sort
  const shaped = (curators || []).map((c: any) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    source: c.source,
    source_url: c.source_url,
    avatar_url: c.avatar_url,
    description: c.description,
    location: c.location,
    genres: c.genres || [],
    external_links: c.external_links || [],
    enriched_at: c.enriched_at,
    created_at: c.created_at,
    episode_count: epCountMap[c.id] || 0,
    matched_episodes: matchMap[c.id] || 0,
  }));

  // Sort: seed matches desc, then episode count desc
  shaped.sort((a: any, b: any) => {
    if (b.matched_episodes !== a.matched_episodes) return b.matched_episodes - a.matched_episodes;
    return b.episode_count - a.episode_count;
  });

  const paginated = shaped.slice(offset, offset + limit);

  return NextResponse.json({
    curators: paginated,
    total: shaped.length,
  });
}
