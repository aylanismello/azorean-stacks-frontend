#!/usr/bin/env bun
import { getSupabase } from "../lib/supabase";

interface SignalAccumulator {
  approvals: number;
  rejections: number;
}

async function main() {
  console.log(`\n=== Update Taste Signals ===`);
  console.log(`Time: ${new Date().toISOString()}\n`);

  const db = getSupabase();

  // Fetch all voted tracks
  const { data: tracks, error } = await db
    .from("tracks")
    .select("artist, title, status, metadata")
    .in("status", ["approved", "rejected"]);

  if (error) {
    console.error(`Failed to fetch tracks: ${error.message}`);
    process.exit(1);
  }

  if (!tracks || tracks.length === 0) {
    console.log("No voted tracks found.");
    return;
  }

  console.log(`Processing ${tracks.length} voted tracks`);

  const signals = new Map<string, SignalAccumulator>();

  function addSignal(type: string, value: string, approved: boolean) {
    const key = `${type}::${value.toLowerCase().trim()}`;
    const existing = signals.get(key) || { approvals: 0, rejections: 0 };
    if (approved) {
      existing.approvals++;
    } else {
      existing.rejections++;
    }
    signals.set(key, existing);
  }

  for (const track of tracks) {
    const approved = track.status === "approved";

    // Artist signal
    if (track.artist) {
      addSignal("artist", track.artist, approved);
    }

    // Extract signals from metadata
    const meta = (track.metadata || {}) as Record<string, unknown>;

    if (Array.isArray(meta.genres)) {
      for (const g of meta.genres) {
        if (typeof g === "string") addSignal("genre", g, approved);
      }
    }

    if (typeof meta.album === "string") {
      addSignal("album", meta.album, approved);
    }
  }

  console.log(`Computed ${signals.size} unique signals`);

  // Upsert signals
  let upserted = 0;
  let errors = 0;

  for (const [key, acc] of signals) {
    const [signalType, value] = key.split("::");
    const total = acc.approvals + acc.rejections;
    const weight = total > 0 ? (acc.approvals - acc.rejections) / total : 0;

    const { error: upsertError } = await db.from("taste_signals").upsert(
      {
        user_id: null,
        signal_type: signalType,
        value,
        weight: Math.round(weight * 1000) / 1000,
        sample_count: total,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,signal_type,value" }
    );

    if (upsertError) {
      console.error(`  Failed to upsert ${key}: ${upsertError.message}`);
      errors++;
    } else {
      upserted++;
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Signals upserted: ${upserted}`);
  console.log(`Errors: ${errors}`);

  // Show top positive signals
  const { data: topSignals } = await db
    .from("taste_signals")
    .select("*")
    .gt("weight", 0)
    .order("weight", { ascending: false })
    .limit(10);

  if (topSignals && topSignals.length > 0) {
    console.log(`\nTop positive signals:`);
    for (const s of topSignals) {
      console.log(
        `  ${s.signal_type}:${s.value} — weight: ${s.weight} (${s.sample_count} samples)`
      );
    }
  }

  // ─── SCORE PENDING TRACKS ─────────────────────────────────
  // Compute taste_score for all pending tracks using the signals we just built.
  // Score = weighted average of matching signal weights:
  //   genre: 0.5, artist: 0.35, album: 0.15

  console.log(`\n=== Scoring Pending Tracks ===`);

  // Load all signals into a lookup map (weight dampened by sample count confidence)
  // Uses Bayesian dampening: weight * samples / (samples + prior)
  // With prior=3: 1 sample → 25%, 3 → 50%, 6 → 67%, 10 → 77%, 20 → 87%
  // This prevents single-vote genres from dominating the rankings.
  const CONFIDENCE_PRIOR = 3;

  const { data: allSignals } = await db
    .from("taste_signals")
    .select("signal_type, value, weight, sample_count");

  const signalMap = new Map<string, number>();
  for (const s of allSignals || []) {
    const samples = s.sample_count || 0;
    const dampened = s.weight * (samples / (samples + CONFIDENCE_PRIOR));
    signalMap.set(`${s.signal_type}::${s.value}`, dampened);
  }

  // Fetch all pending tracks (paginate past 1000-row cap)
  const pending: any[] = [];
  let page = 0;
  while (true) {
    const { data: batch } = await db
      .from("tracks")
      .select("id, artist, metadata")
      .eq("status", "pending")
      .range(page * 1000, (page + 1) * 1000 - 1);
    if (!batch || batch.length === 0) break;
    pending.push(...batch);
    if (batch.length < 1000) break;
    page++;
  }

  console.log(`Scoring ${pending.length} pending tracks`);

  let scored = 0;
  let scoreErrors = 0;

  // Batch updates: collect scores then update in chunks
  const updates: Array<{ id: string; taste_score: number }> = [];

  for (const track of pending) {
    const meta = (track.metadata || {}) as Record<string, unknown>;
    const components: Array<{ weight: number; typeWeight: number }> = [];

    // Artist signal
    const artistKey = `artist::${(track.artist || "").toLowerCase().trim()}`;
    const artistWeight = signalMap.get(artistKey);
    if (artistWeight !== undefined) {
      components.push({ weight: artistWeight, typeWeight: 0.35 });
    }

    // Genre signals (average all matching genres, then apply type weight)
    const genres = Array.isArray(meta.genres) ? meta.genres : [];
    const genreWeights: number[] = [];
    for (const g of genres) {
      if (typeof g !== "string") continue;
      const w = signalMap.get(`genre::${g.toLowerCase().trim()}`);
      if (w !== undefined) genreWeights.push(w);
    }
    if (genreWeights.length > 0) {
      const avgGenre = genreWeights.reduce((a, b) => a + b, 0) / genreWeights.length;
      components.push({ weight: avgGenre, typeWeight: 0.5 });
    }

    // Album signal
    if (typeof meta.album === "string") {
      const albumKey = `album::${meta.album.toLowerCase().trim()}`;
      const albumWeight = signalMap.get(albumKey);
      if (albumWeight !== undefined) {
        components.push({ weight: albumWeight, typeWeight: 0.15 });
      }
    }

    // Composite score: weighted average of components
    let score = 0;
    if (components.length > 0) {
      const totalTypeWeight = components.reduce((s, c) => s + c.typeWeight, 0);
      score = components.reduce((s, c) => s + c.weight * c.typeWeight, 0) / totalTypeWeight;
      score = Math.round(score * 1000) / 1000;
    }

    updates.push({ id: track.id, taste_score: score });
  }

  // Write scores in batches of 100
  for (let i = 0; i < updates.length; i += 100) {
    const batch = updates.slice(i, i + 100);
    const results = await Promise.allSettled(
      batch.map((u) =>
        db.from("tracks").update({ taste_score: u.taste_score }).eq("id", u.id)
      )
    );
    for (const r of results) {
      if (r.status === "fulfilled" && !r.value.error) {
        scored++;
      } else {
        scoreErrors++;
      }
    }
  }

  console.log(`Scored: ${scored}, Errors: ${scoreErrors}`);

  // Show score distribution
  const scoreDist = { positive: 0, zero: 0, negative: 0 };
  for (const u of updates) {
    if (u.taste_score > 0) scoreDist.positive++;
    else if (u.taste_score < 0) scoreDist.negative++;
    else scoreDist.zero++;
  }
  console.log(`Distribution: +${scoreDist.positive} positive, ${scoreDist.zero} neutral, -${scoreDist.negative} negative`);
  console.log("");
}

main().catch((err) => {
  console.error("Signal update failed:", err);
  process.exit(1);
});
