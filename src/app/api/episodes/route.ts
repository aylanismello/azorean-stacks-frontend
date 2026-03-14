import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// GET /api/episodes?limit=30&offset=0&source=nts
export async function GET(req: NextRequest) {
  const supabase = getServiceClient();
  const { searchParams } = req.nextUrl;
  const limit = parseInt(searchParams.get("limit") || "30", 10);
  const offset = parseInt(searchParams.get("offset") || "0", 10);
  const source = searchParams.get("source");

  const showSkipped = searchParams.get("show_skipped") === "true";

  let query = supabase
    .from("episodes")
    .select("*, episode_seeds(seed_id, seeds(artist, title))", { count: "exact" })
    .order("crawled_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (source) {
    query = query.eq("source", source);
  }

  if (!showSkipped) {
    query = query.or("skipped.is.null,skipped.eq.false");
  }

  const { data: episodes, error, count } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Get track stats via RPC
  const { data: stats } = await supabase.rpc("episode_track_stats");
  const statsMap = new Map(
    (stats || []).map((s: any) => [s.episode_id, s])
  );

  // Shape response
  const shaped = (episodes || []).map((ep: any) => ({
    id: ep.id,
    url: ep.url,
    title: ep.title,
    source: ep.source,
    aired_date: ep.aired_date,
    crawled_at: ep.crawled_at,
    skipped: ep.skipped || false,
    seeds: (ep.episode_seeds || [])
      .filter((es: any) => es.seeds)
      .map((es: any) => ({ id: es.seed_id, artist: es.seeds.artist, title: es.seeds.title })),
    track_stats: statsMap.get(ep.id) || { total: 0, pending: 0, approved: 0, rejected: 0 },
  }));

  return NextResponse.json({ episodes: shaped, total: count });
}
