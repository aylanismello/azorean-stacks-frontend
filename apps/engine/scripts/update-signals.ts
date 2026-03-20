#!/usr/bin/env bun
import { getSupabase } from "../lib/supabase";

interface SignalAccumulator {
  positive: number;
  negative: number;
  samples: number;
}

async function main() {
  console.log(`\n=== Update Taste Signals ===`);
  console.log(`Time: ${new Date().toISOString()}\n`);

  const db = getSupabase();

  // Parse --user-id CLI arg, e.g.: bun run update-signals --user-id <uuid>
  // If not provided, default to the first user in user_tracks (backward compat for single-user setup).
  let userId: string | null = null;
  const userIdArgIdx = process.argv.indexOf("--user-id");
  if (userIdArgIdx !== -1 && process.argv[userIdArgIdx + 1]) {
    userId = process.argv[userIdArgIdx + 1];
    console.log(`User filter: ${userId}`);
  } else {
    // Default: detect first user from user_tracks for backward compatibility
    const { data: firstUserRow } = await db
      .from("user_tracks")
      .select("user_id")
      .not("user_id", "is", null)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    userId = firstUserRow?.user_id ?? null;
    if (userId) {
      console.log(`No --user-id provided, defaulting to first user: ${userId}`);
    } else {
      console.log("No --user-id provided and no user_tracks found — computing signals from all votes (legacy mode)");
    }
  }

  // Fetch voted tracks. When userId is set, only use votes from that user via user_tracks.
  // This ensures taste signals are per-user and don't bleed across accounts.
  let tracksQuery;
  if (userId) {
    // Join tracks with user_tracks to filter by user's votes
    const { data: userVotes, error: uvError } = await db
      .from("user_tracks")
      .select("track_id, status, super_liked")
      .eq("user_id", userId)
      .in("status", ["approved", "rejected", "skipped"]);

    if (uvError) {
      console.error(`Failed to fetch user votes: ${uvError.message}`);
      process.exit(1);
    }

    if (!userVotes || userVotes.length === 0) {
      console.log("No votes found for this user.");
      return;
    }

    const votedTrackIds = userVotes.map((v: any) => v.track_id);
    const userVoteMap = new Map(userVotes.map((v: any) => [v.track_id, { status: v.status, super_liked: v.super_liked }]));

    const { data: tracksData, error: tracksError } = await db
      .from("tracks")
      .select("id, artist, title, status, metadata, episode_id, seed_track_id")
      .in("id", votedTrackIds);

    if (tracksError) {
      console.error(`Failed to fetch tracks: ${tracksError.message}`);
      process.exit(1);
    }

    // Merge user vote status onto track records so downstream logic sees the user's actual vote
    const tracks = (tracksData || []).map((t: any) => {
      const vote = userVoteMap.get(t.id);
      return { ...t, status: vote?.status ?? t.status, _super_liked: vote?.super_liked ?? false };
    });

    await computeAndUpsertSignals(db, tracks, userId);
    return;
  }

  // Legacy path: no user_id filter — use tracks.status directly
  const { data: tracks, error } = await db
    .from("tracks")
    .select("id, artist, title, status, metadata, episode_id, seed_track_id")
    .in("status", ["approved", "rejected", "skipped"]);

  if (error) {
    console.error(`Failed to fetch tracks: ${error.message}`);
    process.exit(1);
  }

  if (!tracks || tracks.length === 0) {
    console.log("No voted tracks found.");
    return;
  }

  await computeAndUpsertSignals(db, tracks, null);
}

// ─── CORE SIGNAL COMPUTATION ──────────────────────────────────────────────────
// Computes taste signals from the given voted tracks and upserts them into
// taste_signals scoped to the given userId (null = legacy global signals).

async function computeAndUpsertSignals(db: any, tracks: any[], userId: string | null) {
  console.log(`Processing ${tracks.length} voted tracks`);

  // Fetch super-liked track IDs (scoped to user when userId is set)
  let superLikedQuery = db.from("user_tracks").select("track_id").eq("super_liked", true);
  if (userId) superLikedQuery = (superLikedQuery as any).eq("user_id", userId);
  const { data: superLikedRows } = await superLikedQuery;
  const superLikedSet = new Set((superLikedRows || []).map((r: any) => r.track_id as string));

  const signals = new Map<string, SignalAccumulator>();

  function addSignal(type: string, value: string, weight: number) {
    const key = `${type}::${value.toLowerCase().trim()}`;
    const existing = signals.get(key) || { positive: 0, negative: 0, samples: 0 };
    if (weight > 0) {
      existing.positive += weight;
    } else {
      existing.negative += Math.abs(weight);
    }
    existing.samples++;
    signals.set(key, existing);
  }

  function trackWeight(track: any): number {
    // For user-path tracks, _super_liked flag is already merged in
    if (track._super_liked || superLikedSet.has(track.id)) return 3.0;
    if (track.status === "approved") return 1.0;
    if (track.status === "skipped") return -0.3;
    return -1.0; // rejected
  }

  for (const track of tracks) {
    const weight = trackWeight(track);

    // Artist signal (improved: stronger negative for heavy rejecters)
    if (track.artist) {
      addSignal("artist", track.artist, weight);
    }

    // Extract signals from metadata
    const meta = (track.metadata || {}) as Record<string, unknown>;

    if (Array.isArray(meta.genres)) {
      for (const g of meta.genres) {
        if (typeof g === "string") addSignal("genre", g, weight);
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
    // Get per-seed weighted track stats
    const tracksBySeed = new Map<string, { positive: number; negative: number; samples: number }>();

    for (const track of tracks) {
      const meta = (track.metadata || {}) as Record<string, unknown>;
      // Tracks can be linked to seeds via metadata.seed_id or seed_track_id
      const seedId = (meta.seed_id as string) || null;
      if (!seedId) continue;

      const w = trackWeight(track);
      const acc = tracksBySeed.get(seedId) || { positive: 0, negative: 0, samples: 0 };
      if (w > 0) acc.positive += w;
      else acc.negative += Math.abs(w);
      acc.samples++;
      tracksBySeed.set(seedId, acc);
    }

    for (const seed of seeds) {
      const acc = tracksBySeed.get(seed.id);
      if (!acc) continue;
      if (acc.samples < 3) continue; // need enough data

      const totalWeight = acc.positive + acc.negative;
      if (totalWeight === 0) continue;
      const normalizedWeight = (acc.positive - acc.negative) / totalWeight;
      // Only add signal if there's a meaningful skew
      if (normalizedWeight > 0 || normalizedWeight < -0.1) {
        addSignal("seed_affinity", seed.id, normalizedWeight);
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

      // Accumulate weighted stats per curator from voted tracks
      const curatorStats = new Map<string, { positive: number; negative: number; samples: number }>();
      for (const track of tracks) {
        if (!track.episode_id) continue;
        const curatorId = episodeToCurator.get(track.episode_id);
        if (!curatorId) continue;
        const w = trackWeight(track);
        const acc = curatorStats.get(curatorId) || { positive: 0, negative: 0, samples: 0 };
        if (w > 0) acc.positive += w;
        else acc.negative += Math.abs(w);
        acc.samples++;
        curatorStats.set(curatorId, acc);
      }

      // Map curator id → slug for signal value
      const curatorSlugMap = new Map(curators.map((c: any) => [c.id, c.slug]));

      for (const [curatorId, acc] of curatorStats) {
        if (acc.samples < 3) continue; // need enough data
        const slug = curatorSlugMap.get(curatorId);
        if (!slug) continue;
        const totalWeight = acc.positive + acc.negative;
        if (totalWeight === 0) continue;
        const normalizedWeight = (acc.positive - acc.negative) / totalWeight;
        addSignal("curator", slug, normalizedWeight);
      }
    }
  }

  // ─── EPISODE DENSITY SIGNALS ──────────────────────────────
  // Episodes with multiple approved tracks → boost remaining pending tracks
  console.log(`Computing episode density signals...`);

  const episodePositiveWeight = new Map<string, number>();
  for (const track of tracks) {
    if (!track.episode_id) continue;
    const w = trackWeight(track);
    if (w > 0) {
      episodePositiveWeight.set(track.episode_id, (episodePositiveWeight.get(track.episode_id) || 0) + w);
    }
  }

  for (const [episodeId, totalWeight] of episodePositiveWeight) {
    if (totalWeight >= 2) {
      // Multiple approved/super-liked tracks from same episode → strong positive signal
      addSignal("episode_density", episodeId, 1.0);
    }
  }

  // ─── CO-OCCURRENCE SIGNALS ──────────────────────────────────
  // Artists appearing across multiple seed episodes → positive signal
  console.log(`Computing co-occurrence signals...`);

  // Build artist → set of episode IDs from voted tracks
  const artistEpisodes = new Map<string, Set<string>>();
  for (const track of tracks) {
    if (!track.artist || !track.episode_id) continue;
    const key = track.artist.toLowerCase().trim();
    if (!artistEpisodes.has(key)) artistEpisodes.set(key, new Set());
    artistEpisodes.get(key)!.add(track.episode_id);
  }

  for (const [artistKey, epSet] of artistEpisodes) {
    if (epSet.size >= 2) {
      // Normalize: log scale so 2 episodes = moderate, 5+ = strong
      const strength = Math.min(1.0, Math.log2(epSet.size) / 3);
      addSignal("co_occurrence", artistKey, strength);
    }
  }

  console.log(`Computed ${signals.size} unique signals`);

  // ─── ARTIST NEGATIVE SIGNAL IMPROVEMENT ───────────────────
  // Artists with >3 negative weight and <25% positive rate get extra negative weight
  // We do this by boosting the negative accumulator
  for (const [key, acc] of signals) {
    if (!key.startsWith("artist::")) continue;
    const total = acc.positive + acc.negative;
    const rate = total > 0 ? acc.positive / total : 0;
    if (acc.negative > 3 && rate < 0.25) {
      // Add extra negative weight — effectively increases the negative signal
      acc.negative = Math.round(acc.negative * 1.5);
      signals.set(key, acc);
    }
  }

  // Upsert signals
  let upserted = 0;
  let errors = 0;

  for (const [key, acc] of signals) {
    const [signalType, value] = key.split("::");
    const totalWeight = acc.positive + acc.negative;
    const weight = totalWeight > 0 ? (acc.positive - acc.negative) / totalWeight : 0;

    const { error: upsertError } = await db.from("taste_signals").upsert(
      {
        user_id: userId,
        signal_type: signalType,
        value,
        weight: Math.round(weight * 1000) / 1000,
        sample_count: acc.samples,
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

  // Show top positive signals (scoped to this user)
  let topSignalsQuery = db
    .from("taste_signals")
    .select("*")
    .gt("weight", 0)
    .order("weight", { ascending: false })
    .limit(10);
  if (userId) {
    topSignalsQuery = (topSignalsQuery as any).eq("user_id", userId);
  } else {
    topSignalsQuery = (topSignalsQuery as any).is("user_id", null);
  }
  const { data: topSignals } = await topSignalsQuery;

  if (topSignals && topSignals.length > 0) {
    console.log(`\nTop positive signals:`);
    for (const s of topSignals) {
      console.log(
        `  ${s.signal_type}:${s.value} — weight: ${s.weight} (${s.sample_count} samples)`
      );
    }
  }

  // ─── SCORE PENDING TRACKS ─────────────────────────────────
  // Unified weights (rebalanced with co-occurrence):
  //   artist: 0.20
  //   genre: 0.25
  //   seed_affinity: 0.20
  //   curator: 0.15
  //   episode_density: 0.10
  //   co_occurrence: 0.10

  console.log(`\n=== Scoring Pending Tracks ===`);

  // Bayesian dampening: weight * samples / (samples + prior)
  // With prior=3: 1 sample → 25%, 3 → 50%, 6 → 67%, 10 → 77%, 20 → 87%
  const CONFIDENCE_PRIOR = 3;

  // Load signals scoped to this user (or null for legacy global signals)
  let allSignalsQuery = db
    .from("taste_signals")
    .select("signal_type, value, weight, sample_count");
  if (userId) {
    allSignalsQuery = (allSignalsQuery as any).eq("user_id", userId);
  } else {
    allSignalsQuery = (allSignalsQuery as any).is("user_id", null);
  }
  const { data: allSignals } = await allSignalsQuery;

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
      .select("id, artist, metadata, episode_id, seed_track_id")
      .eq("status", "pending")
      .range(page * 1000, (page + 1) * 1000 - 1);
    if (!batch || batch.length === 0) break;
    pending.push(...batch);
    if (batch.length < 1000) break;
    page++;
  }

  console.log(`Scoring ${pending.length} pending tracks`);

  // Build per-episode vote stats for negative penalties
  const episodeVoteStats = new Map<string, { approved: number; rejected: number }>();
  for (const track of tracks) {
    if (!track.episode_id) continue;
    const w = trackWeight(track);
    const acc = episodeVoteStats.get(track.episode_id) || { approved: 0, rejected: 0 };
    if (w > 0) acc.approved++;
    else if (w < -0.5) acc.rejected++; // rejected (not skipped)
    episodeVoteStats.set(track.episode_id, acc);
  }

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
  const updates: Array<{ id: string; taste_score: number; metadata: Record<string, unknown> }> = [];

  for (const track of pending) {
    const meta = (track.metadata || {}) as Record<string, unknown>;
    const components: Array<{ weight: number; typeWeight: number }> = [];

    // Artist signal (0.20)
    const artistKey = `artist::${(track.artist || "").toLowerCase().trim()}`;
    const artistSignal = signalMap.get(artistKey);
    const scoreComponents: Record<string, number> = {};
    if (artistSignal !== undefined) {
      components.push({ weight: artistSignal, typeWeight: 0.20 });
      scoreComponents.artist = Math.round(artistSignal * 1000) / 1000;
    }

    // Genre signals — average all matching genres, apply type weight (0.25)
    const genres = Array.isArray(meta.genres) ? meta.genres : [];
    const genreWeights: number[] = [];
    for (const g of genres) {
      if (typeof g !== "string") continue;
      const w = signalMap.get(`genre::${g.toLowerCase().trim()}`);
      if (w !== undefined) genreWeights.push(w);
    }
    if (genreWeights.length > 0) {
      const avgGenre = genreWeights.reduce((a, b) => a + b, 0) / genreWeights.length;
      components.push({ weight: avgGenre, typeWeight: 0.25 });
      scoreComponents.genre = Math.round(avgGenre * 1000) / 1000;
    }

    // Seed affinity signal (0.20)
    const seedId = (meta.seed_id as string) || null;
    if (seedId) {
      const seedAffinityKey = `seed_affinity::${seedId.toLowerCase()}`;
      const seedAffinityWeight = signalMap.get(seedAffinityKey);
      if (seedAffinityWeight !== undefined) {
        components.push({ weight: seedAffinityWeight, typeWeight: 0.20 });
        scoreComponents.seed = Math.round(seedAffinityWeight * 1000) / 1000;
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
            scoreComponents.curator = Math.round(curatorWeight * 1000) / 1000;
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
        scoreComponents.episode_density = Math.round(epDensityWeight * 1000) / 1000;
      }
    }

    // Co-occurrence signal (0.10)
    const coOccKey = `co_occurrence::${(track.artist || "").toLowerCase().trim()}`;
    const coOccWeight = signalMap.get(coOccKey);
    if (coOccWeight !== undefined) {
      components.push({ weight: coOccWeight, typeWeight: 0.10 });
      scoreComponents.co_occurrence = Math.round(coOccWeight * 1000) / 1000;
    }

    // Composite score: weighted average of components
    let score = 0;
    if (components.length > 0) {
      const totalTypeWeight = components.reduce((s, c) => s + c.typeWeight, 0);
      score = components.reduce((s, c) => s + c.weight * c.typeWeight, 0) / totalTypeWeight;
      score = Math.round(score * 1000) / 1000;
    }

    // ── Negative penalties ──────────────────────────────────────────────
    let penalty = 0;

    // Rejected artist penalty
    const artistNegSignal = signalMap.get(artistKey);
    if (artistNegSignal !== undefined && artistNegSignal < -0.5) {
      penalty += 0.15; // heavily rejected artist
    }

    // Bad episode penalty (>50% rejection rate from episode density data)
    if (track.episode_id) {
      const epStats = episodeVoteStats.get(track.episode_id);
      if (epStats) {
        const epTotal = epStats.approved + epStats.rejected;
        if (epTotal >= 3 && epStats.rejected / epTotal > 0.5) {
          penalty += 0.20; // bad episode
        }
      }
    }

    // Bad curator penalty
    if (track.episode_id) {
      const curatorId = epToCuratorMap.get(track.episode_id);
      if (curatorId) {
        const slug = curatorIdToSlug.get(curatorId);
        if (slug) {
          const curatorSig = signalMap.get(`curator::${slug.toLowerCase()}`);
          if (curatorSig !== undefined && curatorSig < -0.3) {
            penalty += 0.10; // bad curator
          }
        }
      }
    }

    score = Math.round((score - penalty) * 1000) / 1000;
    scoreComponents.penalty = penalty > 0 ? -Math.round(penalty * 1000) / 1000 : 0;

    // Store score components in metadata
    const updatedMeta = { ...(track.metadata || {}), _score_components: scoreComponents };
    updates.push({ id: track.id, taste_score: score, metadata: updatedMeta });
  }

  // Write scores in batches of 100
  for (let i = 0; i < updates.length; i += 100) {
    const batch = updates.slice(i, i + 100);
    const results = await Promise.allSettled(
      batch.map((u) =>
        db.from("tracks").update({ taste_score: u.taste_score, metadata: u.metadata }).eq("id", u.id)
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
