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
    .select("id, artist, title, status, metadata, episode_id, seed_track_id")
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

    // Artist signal (improved: stronger negative for heavy rejecters)
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

    // NOTE: album signal removed — too sparse, mostly noise
  }

  // ─── SEED AFFINITY SIGNALS ────────────────────────────────
  // Seeds with high approval rate → boost tracks from those seeds
  console.log(`\nComputing seed affinity signals...`);

  const { data: seeds } = await db
    .from("seeds")
    .select("id, artist, title")
    .eq("active", true);

  if (seeds && seeds.length > 0) {
    // Get per-seed track stats
    const tracksBySeed = new Map<string, { approvals: number; rejections: number }>();

    for (const track of tracks) {
      const meta = (track.metadata || {}) as Record<string, unknown>;
      // Tracks can be linked to seeds via metadata.seed_id or seed_track_id
      const seedId = (meta.seed_id as string) || null;
      if (!seedId) continue;

      const acc = tracksBySeed.get(seedId) || { approvals: 0, rejections: 0 };
      if (track.status === "approved") acc.approvals++;
      else acc.rejections++;
      tracksBySeed.set(seedId, acc);
    }

    for (const seed of seeds) {
      const acc = tracksBySeed.get(seed.id);
      if (!acc) continue;
      const total = acc.approvals + acc.rejections;
      if (total < 3) continue; // need enough data

      const rate = acc.approvals / total;
      // >50% approval → positive boost, <20% → negative signal
      if (rate > 0.5 || rate < 0.2) {
        addSignal("seed_affinity", seed.id, rate > 0.5);
      }
    }
  }

  // ─── CURATOR QUALITY SIGNALS ──────────────────────────────
  // NTS show curators with consistent approval rates boost their episode tracks
  console.log(`Computing curator quality signals...`);

  const { data: curators } = await db
    .from("curators")
    .select("id, slug");

  if (curators && curators.length > 0) {
    // Get all episodes for each curator
    const { data: curatorEpisodes } = await db
      .from("episodes")
      .select("id, curator_id")
      .not("curator_id", "is", null);

    if (curatorEpisodes && curatorEpisodes.length > 0) {
      const episodesByCurator = new Map<string, string[]>();
      for (const ep of curatorEpisodes) {
        if (!ep.curator_id) continue;
        const arr = episodesByCurator.get(ep.curator_id) || [];
        arr.push(ep.id);
        episodesByCurator.set(ep.curator_id, arr);
      }

      // Map episode_id → curator_id for O(1) lookup
      const episodeToCurator = new Map<string, string>();
      for (const ep of curatorEpisodes) {
        if (ep.curator_id) episodeToCurator.set(ep.id, ep.curator_id);
      }

      // Accumulate approval stats per curator from voted tracks
      const curatorStats = new Map<string, { approvals: number; rejections: number }>();
      for (const track of tracks) {
        if (!track.episode_id) continue;
        const curatorId = episodeToCurator.get(track.episode_id);
        if (!curatorId) continue;
        const acc = curatorStats.get(curatorId) || { approvals: 0, rejections: 0 };
        if (track.status === "approved") acc.approvals++;
        else acc.rejections++;
        curatorStats.set(curatorId, acc);
      }

      // Map curator id → slug for signal value
      const curatorSlugMap = new Map(curators.map((c: any) => [c.id, c.slug]));

      for (const [curatorId, acc] of curatorStats) {
        const total = acc.approvals + acc.rejections;
        if (total < 3) continue; // need enough data
        const slug = curatorSlugMap.get(curatorId);
        if (!slug) continue;
        const approved = acc.approvals / total > 0.5;
        addSignal("curator", slug, approved);
      }
    }
  }

  // ─── EPISODE DENSITY SIGNALS ──────────────────────────────
  // Episodes with multiple approved tracks → boost remaining pending tracks
  console.log(`Computing episode density signals...`);

  const episodeApprovals = new Map<string, number>();
  for (const track of tracks) {
    if (track.status !== "approved" || !track.episode_id) continue;
    episodeApprovals.set(track.episode_id, (episodeApprovals.get(track.episode_id) || 0) + 1);
  }

  for (const [episodeId, count] of episodeApprovals) {
    if (count >= 2) {
      // Multiple approved tracks from same episode → strong positive signal
      addSignal("episode_density", episodeId, true);
    }
  }

  console.log(`Computed ${signals.size} unique signals`);

  // ─── ARTIST NEGATIVE SIGNAL IMPROVEMENT ───────────────────
  // Artists with >3 rejections and <25% approval get extra negative weight
  // We do this by adding extra rejection entries to their signal accumulator
  for (const [key, acc] of signals) {
    if (!key.startsWith("artist::")) continue;
    const total = acc.approvals + acc.rejections;
    const rate = total > 0 ? acc.approvals / total : 0;
    if (acc.rejections > 3 && rate < 0.25) {
      // Add extra rejection weight — effectively doubles the negative signal
      acc.rejections = Math.round(acc.rejections * 1.5);
      signals.set(key, acc);
    }
  }

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
  // Updated weights:
  //   genre: 0.30 (was 0.50)
  //   artist: 0.25 (was 0.35)
  //   seed_affinity: 0.20 (NEW)
  //   curator: 0.15 (NEW)
  //   episode_density: 0.10 (NEW)
  //   album: removed

  console.log(`\n=== Scoring Pending Tracks ===`);

  // Bayesian dampening: weight * samples / (samples + prior)
  // With prior=3: 1 sample → 25%, 3 → 50%, 6 → 67%, 10 → 77%, 20 → 87%
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
      .select("id, artist, metadata, episode_id")
      .eq("status", "pending")
      .range(page * 1000, (page + 1) * 1000 - 1);
    if (!batch || batch.length === 0) break;
    pending.push(...batch);
    if (batch.length < 1000) break;
    page++;
  }

  console.log(`Scoring ${pending.length} pending tracks`);

  // Build episode → curator lookup for pending tracks
  const { data: epCuratorLinks } = await db
    .from("episodes")
    .select("id, curator_id")
    .not("curator_id", "is", null);

  const epToCuratorMap = new Map<string, string>();
  if (epCuratorLinks) {
    for (const ep of epCuratorLinks) {
      if (ep.curator_id) epToCuratorMap.set(ep.id, ep.curator_id);
    }
  }

  // Build curator id → slug map
  const curatorIdToSlug = new Map<string, string>();
  if (curators) {
    for (const c of curators as any[]) {
      curatorIdToSlug.set(c.id, c.slug);
    }
  }

  let scored = 0;
  let scoreErrors = 0;

  // Batch updates: collect scores then update in chunks
  const updates: Array<{ id: string; taste_score: number }> = [];

  for (const track of pending) {
    const meta = (track.metadata || {}) as Record<string, unknown>;
    const components: Array<{ weight: number; typeWeight: number }> = [];

    // Artist signal (0.25)
    const artistKey = `artist::${(track.artist || "").toLowerCase().trim()}`;
    const artistWeight = signalMap.get(artistKey);
    if (artistWeight !== undefined) {
      components.push({ weight: artistWeight, typeWeight: 0.25 });
    }

    // Genre signals — average all matching genres, apply type weight (0.30)
    const genres = Array.isArray(meta.genres) ? meta.genres : [];
    const genreWeights: number[] = [];
    for (const g of genres) {
      if (typeof g !== "string") continue;
      const w = signalMap.get(`genre::${g.toLowerCase().trim()}`);
      if (w !== undefined) genreWeights.push(w);
    }
    if (genreWeights.length > 0) {
      const avgGenre = genreWeights.reduce((a, b) => a + b, 0) / genreWeights.length;
      components.push({ weight: avgGenre, typeWeight: 0.30 });
    }

    // Seed affinity signal (0.20)
    const seedId = (meta.seed_id as string) || null;
    if (seedId) {
      const seedAffinityKey = `seed_affinity::${seedId.toLowerCase()}`;
      const seedAffinityWeight = signalMap.get(seedAffinityKey);
      if (seedAffinityWeight !== undefined) {
        components.push({ weight: seedAffinityWeight, typeWeight: 0.20 });
      }
    }

    // Curator signal (0.15)
    if (track.episode_id) {
      const curatorId = epToCuratorMap.get(track.episode_id);
      if (curatorId) {
        const slug = curatorIdToSlug.get(curatorId);
        if (slug) {
          const curatorKey = `curator::${slug.toLowerCase()}`;
          const curatorWeight = signalMap.get(curatorKey);
          if (curatorWeight !== undefined) {
            components.push({ weight: curatorWeight, typeWeight: 0.15 });
          }
        }
      }
    }

    // Episode density signal (0.10)
    if (track.episode_id) {
      const epDensityKey = `episode_density::${track.episode_id.toLowerCase()}`;
      const epDensityWeight = signalMap.get(epDensityKey);
      if (epDensityWeight !== undefined) {
        components.push({ weight: epDensityWeight, typeWeight: 0.10 });
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

  // ─── AUTO-SKIP STRONGLY NEGATIVE TRACKS ───────────────────
  // Tracks with taste_score < -0.5 AND ≥4 negative signal matches → auto-skip
  console.log(`\n=== Auto-skip Strongly Negative Tracks ===`);

  const stronglyNegative = updates.filter((u) => u.taste_score < -0.5);
  console.log(`Candidates with score < -0.5: ${stronglyNegative.length}`);

  // For each strongly negative track, count how many negative signals match
  const pendingById = new Map(pending.map((t) => [t.id, t]));
  let autoSkipped = 0;
  let autoSkipErrors = 0;

  const skipCandidates: string[] = [];

  for (const u of stronglyNegative) {
    const track = pendingById.get(u.id);
    if (!track) continue;

    const meta = (track.metadata || {}) as Record<string, unknown>;
    let negativeSignalCount = 0;

    // Check artist signal
    const artistKey = `artist::${(track.artist || "").toLowerCase().trim()}`;
    const artistSig = signalMap.get(artistKey);
    if (artistSig !== undefined && artistSig < 0) negativeSignalCount++;

    // Check genre signals
    const genres = Array.isArray(meta.genres) ? meta.genres : [];
    for (const g of genres) {
      if (typeof g !== "string") continue;
      const w = signalMap.get(`genre::${g.toLowerCase().trim()}`);
      if (w !== undefined && w < 0) negativeSignalCount++;
    }

    // Check curator signal
    if (track.episode_id) {
      const curatorId = epToCuratorMap.get(track.episode_id);
      if (curatorId) {
        const slug = curatorIdToSlug.get(curatorId);
        if (slug) {
          const cw = signalMap.get(`curator::${slug.toLowerCase()}`);
          if (cw !== undefined && cw < 0) negativeSignalCount++;
        }
      }
    }

    if (negativeSignalCount >= 3) {
      skipCandidates.push(u.id);
    }
  }

  console.log(`Tracks to auto-skip (score < -0.5, ≥3 negative signals): ${skipCandidates.length}`);

  // Update in batches of 100
  for (let i = 0; i < skipCandidates.length; i += 100) {
    const batch = skipCandidates.slice(i, i + 100);
    const { error: skipErr } = await db
      .from("tracks")
      .update({ status: "skipped", voted_at: new Date().toISOString() })
      .in("id", batch);

    if (skipErr) {
      console.error(`  Auto-skip batch error: ${skipErr.message}`);
      autoSkipErrors += batch.length;
    } else {
      autoSkipped += batch.length;
    }
  }

  console.log(`Auto-skipped: ${autoSkipped}, Errors: ${autoSkipErrors}`);
  console.log("");
}

main().catch((err) => {
  console.error("Signal update failed:", err);
  process.exit(1);
});
