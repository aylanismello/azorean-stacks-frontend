import { getSupabase } from "../lib/supabase";
const db = getSupabase();

async function backfillBatch(filter: string, sources: string[], limit: number) {
  let total = 0;
  let page = 0;
  while (true) {
    let query = db.from("tracks").select("id, spotify_url, youtube_url, metadata");
    
    if (filter === "both") {
      query = query.not("spotify_url", "is", null).neq("spotify_url", "").not("youtube_url", "is", null).neq("youtube_url", "");
    } else if (filter === "yt_only") {
      query = query.or("spotify_url.is.null,spotify_url.eq.").not("youtube_url", "is", null).neq("youtube_url", "");
    } else if (filter === "sp_only") {
      query = query.not("spotify_url", "is", null).neq("spotify_url", "").or("youtube_url.is.null,youtube_url.eq.");
    }
    
    const { data: tracks } = await query.limit(limit);
    if (!tracks?.length) break;
    
    const toUpdate = tracks.filter((t: any) => !(t.metadata as any)?.enrichment_sources);
    if (!toUpdate.length) break;
    
    for (const t of toUpdate) {
      const meta = (t.metadata || {}) as Record<string, any>;
      const s = [...sources];
      if (meta.musicbrainz_id) s.push("musicbrainz");
      const audioSource = t.youtube_url?.includes("soundcloud") ? "soundcloud" : "youtube";
      
      await db.from("tracks").update({
        metadata: { ...meta, enrichment_sources: s, ...(t.youtube_url ? { audio_source: audioSource } : {}) }
      }).eq("id", t.id);
      total++;
    }
    page++;
    console.log(`  ${filter}: page ${page}, updated ${toUpdate.length} (total: ${total})`);
  }
  return total;
}

async function main() {
  console.log("=== Backfilling enrichment_sources ===");
  const n1 = await backfillBatch("both", ["spotify", "youtube"], 500);
  console.log(`spotify+youtube: ${n1}`);
  const n2 = await backfillBatch("yt_only", ["youtube"], 500);
  console.log(`youtube only: ${n2}`);
  const n3 = await backfillBatch("sp_only", ["spotify"], 500);
  console.log(`spotify only: ${n3}`);
  console.log(`\n=== TOTAL: ${n1 + n2 + n3} tracks backfilled ===`);
}

main().catch(console.error);
