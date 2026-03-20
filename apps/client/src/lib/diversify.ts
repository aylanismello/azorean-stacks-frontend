/**
 * Shared track diversification logic.
 *
 * Rules:
 *  - Max 2 consecutive tracks from the same episode
 *  - Max 2 consecutive tracks from the same artist
 *  - No 3 consecutive tracks with the same primary genre
 *  - Every 5th slot is an exploration wildcard: a medium-scored track
 *    (between 25th and 75th percentile of taste_score)
 */
export function diversifyTracks(tracks: any[]): any[] {
  if (tracks.length === 0) return [];

  // Separate wildcards (medium-scored, 25th–75th percentile)
  const scores = tracks
    .map((t) => t.taste_score ?? 0)
    .sort((a: number, b: number) => a - b);
  const p25 = scores[Math.floor(scores.length * 0.25)];
  const p75 = scores[Math.floor(scores.length * 0.75)];

  const wildcards: any[] = [];
  const mainPool: any[] = [];

  for (const t of tracks) {
    const s = t.taste_score ?? 0;
    if (s >= p25 && s <= p75) {
      wildcards.push(t);
    } else {
      mainPool.push(t);
    }
  }

  const result: any[] = [];
  let wildcardIdx = 0;

  // Track consecutive runs
  let consecEpId: string | null = null;
  let consecEpCount = 0;
  let consecArtist: string | null = null;
  let consecArtistCount = 0;
  let consecGenre: string | null = null;
  let consecGenreCount = 0;

  function updateConsecState(t: any) {
    const epId = t.episode_id || null;
    if (epId !== null && epId === consecEpId) consecEpCount++;
    else { consecEpId = epId; consecEpCount = 1; }

    const artist = (t.artist || "").toLowerCase();
    if (artist && artist === consecArtist) consecArtistCount++;
    else { consecArtist = artist || null; consecArtistCount = 1; }

    const genre = primaryGenre(t);
    if (genre && genre === consecGenre) consecGenreCount++;
    else { consecGenre = genre; consecGenreCount = 1; }
  }

  function violatesConstraints(t: any): boolean {
    const epId = t.episode_id || null;
    if (epId !== null && epId === consecEpId && consecEpCount >= 2) return true;

    const artist = (t.artist || "").toLowerCase();
    if (artist && artist === consecArtist && consecArtistCount >= 2) return true;

    const genre = primaryGenre(t);
    if (genre && genre === consecGenre && consecGenreCount >= 2) return true;

    return false;
  }

  const pool = [...mainPool];

  while (pool.length > 0) {
    // Insert exploration wildcard at every 5th position (indices 4, 9, 14…)
    if (result.length > 0 && (result.length + 1) % 5 === 0 && wildcardIdx < wildcards.length) {
      const w = wildcards[wildcardIdx++];
      result.push(w);
      updateConsecState(w);
      continue;
    }

    // Find first pool track that satisfies all constraints
    let idx = -1;
    for (let i = 0; i < pool.length; i++) {
      if (!violatesConstraints(pool[i])) {
        idx = i;
        break;
      }
    }
    if (idx === -1) idx = 0; // fallback

    const [track] = pool.splice(idx, 1);
    result.push(track);
    updateConsecState(track);
  }

  // Append remaining wildcards at the end
  result.push(...wildcards.slice(wildcardIdx));
  return result;
}

function primaryGenre(t: any): string | null {
  const meta = t.metadata;
  if (!meta) return null;
  const genres = meta.genres;
  if (Array.isArray(genres) && genres.length > 0 && typeof genres[0] === "string") {
    return genres[0].toLowerCase();
  }
  // Also check _score_components or inline genre field
  return null;
}
