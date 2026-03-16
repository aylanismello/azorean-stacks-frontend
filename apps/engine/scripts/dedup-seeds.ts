#!/usr/bin/env bun
/**
 * Dedup Seeds — finds duplicate seeds (same artist + title, case insensitive),
 * keeps the oldest one, deactivates newer duplicates, and transfers episode_seeds links.
 *
 * Usage: bun run dedup-seeds.ts [--dry-run]
 */
import { parseArgs } from "util";
import { getSupabase } from "../lib/supabase";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "dry-run": { type: "boolean", default: false },
  },
  strict: false,
});

const dryRun = values["dry-run"] || false;

async function main() {
  console.log(`\n=== Dedup Seeds ===`);
  console.log(`Time: ${new Date().toISOString()}`);
  if (dryRun) console.log(`[DRY RUN] — no changes will be written\n`);
  else console.log("");

  const db = getSupabase();

  // Fetch all seeds
  const { data: seeds, error } = await db
    .from("seeds")
    .select("id, artist, title, active, created_at")
    .order("created_at", { ascending: true });

  if (error) {
    console.error(`Failed to fetch seeds: ${error.message}`);
    process.exit(1);
  }

  if (!seeds || seeds.length === 0) {
    console.log("No seeds found.");
    return;
  }

  console.log(`Total seeds: ${seeds.length}`);

  // Group by normalized (artist, title) — case insensitive
  const groups = new Map<string, typeof seeds>();
  for (const seed of seeds) {
    const key = `${seed.artist.toLowerCase().trim()}::${seed.title.toLowerCase().trim()}`;
    const group = groups.get(key) || [];
    group.push(seed);
    groups.set(key, group);
  }

  const duplicateGroups = [...groups.values()].filter((g) => g.length > 1);
  console.log(`Duplicate groups found: ${duplicateGroups.length}`);

  if (duplicateGroups.length === 0) {
    console.log("No duplicates to process.");
    return;
  }

  let totalDeactivated = 0;
  let totalTransferred = 0;
  let totalErrors = 0;

  for (const group of duplicateGroups) {
    // Seeds are already sorted by created_at ascending — first is oldest (survivor)
    const [survivor, ...duplicates] = group;
    const dupIds = duplicates.map((d) => d.id);

    console.log(`\nDuplicate: "${survivor.artist} — ${survivor.title}"`);
    console.log(`  Keeping:     ${survivor.id} (created ${survivor.created_at})`);
    for (const dup of duplicates) {
      console.log(`  Deactivating: ${dup.id} (created ${dup.created_at}, active=${dup.active})`);
    }

    if (dryRun) continue;

    // 1. Transfer episode_seeds from duplicates to survivor
    for (const dup of duplicates) {
      // Get all episode_seeds for this duplicate
      const { data: epSeeds } = await db
        .from("episode_seeds")
        .select("episode_id, match_type")
        .eq("seed_id", dup.id);

      if (epSeeds && epSeeds.length > 0) {
        console.log(`  Transferring ${epSeeds.length} episode_seeds from ${dup.id} to ${survivor.id}`);

        for (const link of epSeeds) {
          // Upsert to survivor — if it already exists, the conflict is ignored
          const { error: transferErr } = await db
            .from("episode_seeds")
            .upsert(
              { episode_id: link.episode_id, seed_id: survivor.id, match_type: link.match_type },
              { onConflict: "episode_id,seed_id" }
            );

          if (transferErr) {
            console.error(`    Transfer error for episode ${link.episode_id}: ${transferErr.message}`);
            totalErrors++;
          } else {
            totalTransferred++;
          }
        }

        // Delete old links from duplicate
        await db.from("episode_seeds").delete().eq("seed_id", dup.id);
      }
    }

    // 2. Deactivate the duplicate seeds
    const { error: deactivateErr } = await db
      .from("seeds")
      .update({ active: false })
      .in("id", dupIds);

    if (deactivateErr) {
      console.error(`  Deactivate error: ${deactivateErr.message}`);
      totalErrors++;
    } else {
      totalDeactivated += dupIds.length;
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Duplicate groups: ${duplicateGroups.length}`);
  console.log(`Seeds deactivated: ${totalDeactivated}`);
  console.log(`Episode links transferred: ${totalTransferred}`);
  console.log(`Errors: ${totalErrors}`);

  if (dryRun) {
    console.log(`\n[DRY RUN] — run without --dry-run to apply changes`);
  }
}

main().catch((err) => {
  console.error("Dedup seeds failed:", err);
  process.exit(1);
});
