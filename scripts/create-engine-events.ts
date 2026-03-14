#!/usr/bin/env bun
/**
 * Create the engine_events table.
 *
 * The table must be created manually via Supabase Dashboard SQL editor
 * or the SQL below, because the JS client cannot run DDL statements.
 *
 * CREATE TABLE IF NOT EXISTS engine_events (
 *   id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
 *   event_type TEXT NOT NULL,
 *   seed_id UUID,
 *   status TEXT NOT NULL,
 *   message TEXT,
 *   metadata JSONB DEFAULT '{}',
 *   created_at TIMESTAMPTZ DEFAULT NOW()
 * );
 *
 * -- Enable Realtime on seeds table (required for watcher):
 * ALTER PUBLICATION supabase_realtime ADD TABLE seeds;
 *
 * This script tests connectivity by inserting and then reading back
 * a test event row.
 */
import { getSupabase } from "../lib/supabase";

const db = getSupabase();

async function main() {
  console.log("Testing engine_events table...\n");

  // Try inserting a test event
  const { data, error } = await db.from("engine_events").insert({
    event_type: "watcher_connected",
    status: "info",
    message: "Table connectivity test",
    metadata: { test: true, timestamp: new Date().toISOString() },
  }).select().single();

  if (error) {
    console.error("✗ Insert failed:", error.message);
    console.error("\nThe engine_events table likely does not exist yet.");
    console.error("Create it with this SQL in the Supabase Dashboard:\n");
    console.error(`CREATE TABLE IF NOT EXISTS engine_events (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  event_type TEXT NOT NULL,
  seed_id UUID,
  status TEXT NOT NULL,
  message TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable Realtime on seeds table (required for watcher):
ALTER PUBLICATION supabase_realtime ADD TABLE seeds;`);
    process.exit(1);
  }

  console.log("✓ Test event inserted:", data.id);

  // Read it back
  const { data: readBack } = await db.from("engine_events")
    .select("*").eq("id", data.id).single();

  if (readBack) {
    console.log("✓ Read back successfully:", readBack.event_type, readBack.status);
  }

  // Clean up test row
  await db.from("engine_events").delete().eq("id", data.id);
  console.log("✓ Test row cleaned up");
  console.log("\nengine_events table is ready!");
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
