import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const NTS_API = "https://www.nts.live/api/v2";

interface NTSShow {
  name?: string;
  description?: string;
  location_long?: string;
  genres?: Array<{ id: string; value: string }>;
  moods?: Array<{ id: string; value: string }>;
  external_links?: Array<{ name: string; url: string }>;
  media?: {
    background_large?: string;
    background_medium_large?: string;
    background_medium?: string;
    background_small?: string;
    picture_large?: string;
    picture_medium_large?: string;
    picture_medium?: string;
    picture_small?: string;
  };
}

async function fetchNTSShow(slug: string): Promise<NTSShow | null> {
  try {
    const res = await fetch(`${NTS_API}/shows/${slug}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// POST /api/curators/enrich — enrich unenriched curators from NTS API
// Optional body: { slug: "specific-slug" } to enrich one, or omit for batch
export async function POST(req: NextRequest) {
  const db = getServiceClient();
  const body = await req.json().catch(() => ({}));
  const specificSlug = body.slug as string | undefined;
  const batchSize = Math.min(parseInt(body.batch_size || "10", 10), 20);

  // Get curators to enrich
  let query = db
    .from("curators")
    .select("id, slug")
    .eq("source", "nts");

  if (specificSlug) {
    query = query.eq("slug", specificSlug);
  } else {
    query = query.is("enriched_at", null).limit(batchSize);
  }

  const { data: curators, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!curators || curators.length === 0) {
    return NextResponse.json({ enriched: 0, message: "No curators to enrich" });
  }

  let enriched = 0;
  const errors: string[] = [];

  for (const curator of curators) {
    const show = await fetchNTSShow(curator.slug);
    if (!show) {
      errors.push(`Failed to fetch: ${curator.slug}`);
      continue;
    }

    // Pick best available image
    const avatarUrl =
      show.media?.picture_large ||
      show.media?.picture_medium_large ||
      show.media?.picture_medium ||
      show.media?.background_large ||
      show.media?.background_medium_large ||
      null;

    const genres = (show.genres || []).map((g) => g.value);

    const { error: updateErr } = await db
      .from("curators")
      .update({
        name: show.name || curator.slug,
        description: show.description || null,
        avatar_url: avatarUrl,
        location: show.location_long || null,
        genres,
        external_links: show.external_links || [],
        enriched_at: new Date().toISOString(),
      })
      .eq("id", curator.id);

    if (updateErr) {
      errors.push(`Update failed for ${curator.slug}: ${updateErr.message}`);
    } else {
      enriched++;
    }
  }

  return NextResponse.json({ enriched, total: curators.length, errors });
}
