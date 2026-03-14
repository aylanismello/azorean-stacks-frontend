#!/usr/bin/env bun
import { getSupabase } from "../lib/supabase";

const db = getSupabase();

async function main() {
  // Seeds
  const { data: seeds } = await db.from("seeds").select("artist, title, active").order("created_at");
  console.log(`\n=== Seeds (${seeds?.length || 0}) ===`);
  for (const s of seeds || []) console.log(`  ${s.active ? "●" : "○"} ${s.artist} - ${s.title}`);

  // Track counts by status
  for (const status of ["pending", "approved", "rejected", "skipped"]) {
    const { count } = await db.from("tracks").select("*", { count: "exact", head: true }).eq("status", status);
    console.log(`\n${status.toUpperCase()}: ${count}`);
    if (count && count > 0 && status === "pending") {
      const { data } = await db.from("tracks").select("artist, title, source").eq("status", status).limit(10);
      for (const t of data || []) console.log(`  ${t.artist} - ${t.title} [${t.source}]`);
      if (count > 10) console.log(`  ... and ${count - 10} more`);
    }
  }

  // Recent discovery runs
  const { data: runs } = await db.from("discovery_runs").select("*").order("started_at", { ascending: false }).limit(3);
  console.log(`\n=== Recent Runs ===`);
  for (const r of runs || []) {
    console.log(`  ${r.started_at} | found: ${r.tracks_found} | added: ${r.tracks_added} | sources: ${r.sources_searched?.join(", ")}`);
  }
  console.log("");
}

main().catch(console.error);
