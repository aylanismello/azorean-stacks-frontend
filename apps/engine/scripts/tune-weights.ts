#!/usr/bin/env bun
/**
 * tune-weights.ts
 * ===============
 * Analyzes recent user actions and engagement data to dynamically adjust
 * the 5 scoring weights used in the ranked queue endpoint.
 *
 * Algorithm:
 *   1. Fetch the last 100 user actions with engagement + track signals
 *   2. For each action, extract which scoring signals were strongest
 *   3. Compute correlation between each signal and approval/rejection outcomes
 *   4. Shift weights: correlated-with-approvals go up, correlated-with-rejections go down
 *   5. Apply skip-at-percentage heuristic (Part 6) for nuanced negative weighting
 *   6. Normalize to sum = 100
 *   7. Insert new row into taste_weights
 *
 * Run:
 *   bun run tune-weights [--user-id <uuid>]
 */
import { getSupabase } from "../lib/supabase";

// Default weights (sum = 100)
const BASE_WEIGHTS = {
  seed_proximity: 30,
  source_quality: 25,
  artist_familiarity: 20,
  recency: 15,
  co_occurrence: 10,
};

// Maximum adjustment per run (prevents wild oscillations)
const MAX_DELTA = 8;
// Minimum weight — no signal can go to zero
const MIN_WEIGHT = 3;

/**
 * Part 6: Skip-at-percentage heuristic.
 * Returns the negative weight multiplier for a skip based on listen_pct.
 */
function skipNegativeWeight(listenPct: number | null): number {
  if (listenPct === null) return 0.6; // unknown → moderate negative
  if (listenPct < 10) return 1.0;   // bailed immediately → strong negative
  if (listenPct < 30) return 0.6;   // didn't like it → moderate
  if (listenPct < 60) return 0.3;   // mild negative
  return 0.1;                        // heard most of it → barely negative
}

async function main() {
  console.log(`\n=== Tune Taste Weights ===`);
  console.log(`Time: ${new Date().toISOString()}\n`);

  const db = getSupabase();

  // Resolve user ID
  let userId: string | null = null;
  const userIdArgIdx = process.argv.indexOf("--user-id");
  if (userIdArgIdx !== -1 && process.argv[userIdArgIdx + 1]) {
    userId = process.argv[userIdArgIdx + 1];
    console.log(`User filter: ${userId}`);
  } else {
    const { data: firstUserRow } = await db
      .from("user_tracks")
      .select("user_id")
      .not("user_id", "is", null)
      .order("voted_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    userId = firstUserRow?.user_id ?? null;
    if (userId) console.log(`Auto-detected user: ${userId}`);
    else { console.log("No users found. Exiting."); return; }
  }

  // 1. Fetch last 100 user_tracks with engagement data
  const { data: actions, error: actionsErr } = await db
    .from("user_tracks")
    .select("track_id, status, listen_pct, listen_duration_ms, action_delay_ms, voted_at, super_liked")
    .eq("user_id", userId)
    .in("status", ["approved", "rejected", "skipped"])
    .order("voted_at", { ascending: false })
    .limit(100);

  if (actionsErr || !actions || actions.length === 0) {
    console.log("No actions found. Exiting.");
    return;
  }

  console.log(`Analyzing ${actions.length} recent actions`);

  const trackIds = actions.map((a: any) => a.track_id);

  // 2. Fetch track signals: episode match type, artist approval, seed info
  const { data: tracksData } = await db
    .from("tracks")
    .select("id, artist, episode_id, seed_track_id, created_at, metadata")
    .in("id", trackIds);

  const trackMap = new Map((tracksData || []).map((t: any) => [t.id, t]));

  // 3. Fetch episode → match_type for these tracks
  const episodeIds = [...new Set((tracksData || []).map((t: any) => t.episode_id).filter(Boolean))];
  let episodeMatchMap = new Map<string, string>(); // episode_id → match_type
  if (episodeIds.length > 0) {
    const { data: episodeSeeds } = await db
      .from("episode_seeds")
      .select("episode_id, match_type")
      .in("episode_id", episodeIds);
    for (const es of (episodeSeeds || []) as any[]) {
      // Prefer 'full' match type if multiple seeds
      if (!episodeMatchMap.has(es.episode_id) || es.match_type === "full") {
        episodeMatchMap.set(es.episode_id, es.match_type || "artist");
      }
    }
  }

  // 4. Fetch which artists have been approved (familiarity signal)
  const { data: approvedArtistsData } = await db
    .from("tracks")
    .select("artist")
    .eq("status", "approved")
    .limit(2000);
  const approvedArtistsSet = new Set(
    (approvedArtistsData || []).map((t: any) => (t.artist || "").toLowerCase())
  );

  // 5. Fetch all seed artists for familiarity check
  const { data: seedsData } = await db
    .from("seeds")
    .select("artist")
    .eq("active", true);
  const seedArtistsSet = new Set(
    (seedsData || []).map((s: any) => (s.artist || "").toLowerCase())
  );

  // 6. Episode approval stats (source quality signal)
  const { data: votedByEp } = await db
    .from("tracks")
    .select("episode_id, status")
    .in("episode_id", episodeIds)
    .in("status", ["approved", "rejected"]);
  const epStats = new Map<string, { approved: number; rejected: number }>();
  for (const t of (votedByEp || []) as any[]) {
    const s = epStats.get(t.episode_id) || { approved: 0, rejected: 0 };
    if (t.status === "approved") s.approved++;
    else s.rejected++;
    epStats.set(t.episode_id, s);
  }

  // 7. Compute per-signal correlations
  // For each weight dimension, accumulate: positive_weight (approvals) and negative_weight (rejections)
  const signalCorrelation: Record<keyof typeof BASE_WEIGHTS, { positive: number; negative: number; samples: number }> = {
    seed_proximity: { positive: 0, negative: 0, samples: 0 },
    source_quality: { positive: 0, negative: 0, samples: 0 },
    artist_familiarity: { positive: 0, negative: 0, samples: 0 },
    recency: { positive: 0, negative: 0, samples: 0 },
    co_occurrence: { positive: 0, negative: 0, samples: 0 },
  };

  // Also track recency timestamps for normalization
  const allTimestamps = (tracksData || [])
    .map((t: any) => new Date(t.created_at).getTime())
    .filter((ts: number) => !isNaN(ts));
  const minTs = allTimestamps.length > 0 ? Math.min(...allTimestamps) : 0;
  const maxTs = allTimestamps.length > 0 ? Math.max(...allTimestamps) : 1;
  const tsRange = maxTs - minTs || 1;

  // Co-occurrence: count how many episode_ids each artist appears in (across all fetched tracks)
  const artistEpSets = new Map<string, Set<string>>();
  for (const t of (tracksData || []) as any[]) {
    const key = (t.artist || "").toLowerCase();
    if (!artistEpSets.has(key)) artistEpSets.set(key, new Set());
    if (t.episode_id) artistEpSets.get(key)!.add(t.episode_id);
  }
  const maxCo = Math.max(...Array.from(artistEpSets.values()).map((s) => s.size), 1);

  for (const action of actions as any[]) {
    const track = trackMap.get(action.track_id);
    if (!track) continue;

    const artistLower = (track.artist || "").toLowerCase();
    const epId = track.episode_id as string | null;
    const matchType = epId ? (episodeMatchMap.get(epId) || "unknown") : "unknown";

    // Compute signal strengths (0–1 normalized) for this track
    const signals = {
      seed_proximity: matchType === "full" ? 1.0 : matchType === "artist" ? 0.33 : 0,
      source_quality: (() => {
        if (!epId) return 0.5;
        const stat = epStats.get(epId);
        if (!stat) return 0.5;
        const total = stat.approved + stat.rejected;
        return total >= 3 ? stat.approved / total : 0.5;
      })(),
      artist_familiarity: approvedArtistsSet.has(artistLower)
        ? 1.0
        : seedArtistsSet.has(artistLower)
        ? 0.5
        : 0,
      recency: (() => {
        const ts = new Date(track.created_at).getTime();
        return (ts - minTs) / tsRange;
      })(),
      co_occurrence: (() => {
        const cnt = artistEpSets.get(artistLower)?.size ?? 1;
        return Math.min(cnt, maxCo) / maxCo;
      })(),
    };

    // Determine action weight (positive for approvals, negative for rejections/skips)
    let actionWeight: number;
    if (action.super_liked) {
      actionWeight = 2.0; // strong positive
    } else if (action.status === "approved") {
      actionWeight = 1.0;
    } else if (action.status === "skipped") {
      // Part 6: weight the negativity based on how much they listened
      actionWeight = -skipNegativeWeight(action.listen_pct as number | null);
    } else {
      // rejected
      actionWeight = -1.0;
    }

    // Accumulate: if signal was strong AND action was positive → positive correlation
    for (const [signal, strength] of Object.entries(signals) as [keyof typeof BASE_WEIGHTS, number][]) {
      const corr = signalCorrelation[signal];
      // Only count signals that had meaningful presence (>0.2)
      if (strength > 0.2) {
        if (actionWeight > 0) {
          corr.positive += strength * actionWeight;
        } else {
          corr.negative += strength * Math.abs(actionWeight);
        }
        corr.samples++;
      }
    }
  }

  console.log("\nSignal correlation analysis:");
  for (const [signal, corr] of Object.entries(signalCorrelation)) {
    const total = corr.positive + corr.negative;
    const rate = total > 0 ? corr.positive / total : 0.5;
    console.log(`  ${signal}: +${corr.positive.toFixed(2)} / -${corr.negative.toFixed(2)} → rate: ${(rate * 100).toFixed(1)}% (${corr.samples} samples)`);
  }

  // 8. Compute current weights (read last row or use defaults)
  const { data: lastWeights } = await db
    .from("taste_weights")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const currentWeights: typeof BASE_WEIGHTS = lastWeights
    ? {
        seed_proximity: lastWeights.seed_proximity,
        source_quality: lastWeights.source_quality,
        artist_familiarity: lastWeights.artist_familiarity,
        recency: lastWeights.recency,
        co_occurrence: lastWeights.co_occurrence,
      }
    : { ...BASE_WEIGHTS };

  console.log("\nCurrent weights:", currentWeights);

  // Need at least 10 actions to tune (avoid premature tuning)
  if (actions.length < 10) {
    console.log(`\nOnly ${actions.length} actions — need at least 10 to tune. Inserting defaults.`);
    await insertWeights(db, userId, currentWeights);
    return;
  }

  // 9. Adjust weights: positive correlation → increase, negative → decrease
  const newWeights = { ...currentWeights };

  for (const signal of Object.keys(BASE_WEIGHTS) as (keyof typeof BASE_WEIGHTS)[]) {
    const corr = signalCorrelation[signal];
    const total = corr.positive + corr.negative;
    if (total < 1 || corr.samples < 3) continue; // not enough data for this signal

    // Positive correlation rate (0–1)
    const rate = corr.positive / total;
    // Convert to delta: 0.5 = no change, >0.5 = increase, <0.5 = decrease
    const delta = (rate - 0.5) * 2 * MAX_DELTA; // range: -MAX_DELTA to +MAX_DELTA
    newWeights[signal] = Math.max(MIN_WEIGHT, currentWeights[signal] + delta);
  }

  // 10. Normalize to sum = 100
  const weightSum = Object.values(newWeights).reduce((a, b) => a + b, 0);
  const scale = 100 / weightSum;
  const normalized: typeof BASE_WEIGHTS = {
    seed_proximity: Math.round(newWeights.seed_proximity * scale * 10) / 10,
    source_quality: Math.round(newWeights.source_quality * scale * 10) / 10,
    artist_familiarity: Math.round(newWeights.artist_familiarity * scale * 10) / 10,
    recency: Math.round(newWeights.recency * scale * 10) / 10,
    co_occurrence: Math.round(newWeights.co_occurrence * scale * 10) / 10,
  };

  // Fix any rounding drift so sum is exactly 100
  const normalizedSum = Object.values(normalized).reduce((a, b) => a + b, 0);
  const drift = Math.round((100 - normalizedSum) * 10) / 10;
  if (drift !== 0) {
    normalized.seed_proximity = Math.round((normalized.seed_proximity + drift) * 10) / 10;
  }

  console.log("\nNew weights:", normalized);
  console.log(`Sum: ${Object.values(normalized).reduce((a, b) => a + b, 0)}`);

  await insertWeights(db, userId, normalized);
}

async function insertWeights(db: any, userId: string, weights: typeof BASE_WEIGHTS) {
  const { error } = await db.from("taste_weights").insert({
    user_id: userId,
    seed_proximity: weights.seed_proximity,
    source_quality: weights.source_quality,
    artist_familiarity: weights.artist_familiarity,
    recency: weights.recency,
    co_occurrence: weights.co_occurrence,
  });

  if (error) {
    console.error(`\nFailed to insert weights: ${error.message}`);
    process.exit(1);
  } else {
    console.log("\nWeights saved to taste_weights table.");
  }
}

main().catch((err) => {
  console.error("tune-weights failed:", err);
  process.exit(1);
});
