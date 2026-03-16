/**
 * NTS Radio discovery source.
 * Wraps the existing NTS API functions in the DiscoverySource interface.
 */
import type { DiscoverySource, SourceEpisode, SourceTrack } from "../sources";
import { log } from "../pipeline";

const NTS_API = "https://www.nts.live/api/v2";
const NTS_SEARCH_LIMIT = 60;

async function ntsSearch(query: string): Promise<Array<{ path: string; title: string; date: string }>> {
  log("info", `NTS search: "${query}"`);
  const url = `${NTS_API}/search?q=${encodeURIComponent(query)}&version=2&offset=0&limit=${NTS_SEARCH_LIMIT}&types[]=track`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    log("fail", `NTS search HTTP ${res.status} for "${query}"`);
    throw new Error(`NTS search failed: ${res.status}`);
  }
  const data = await res.json() as { results: Array<{ local_date: string; article: { path: string; title: string } }> };
  const seen = new Set<string>();
  const episodes: Array<{ path: string; title: string; date: string }> = [];
  for (const r of data.results || []) {
    const path = r.article?.path;
    if (!path || seen.has(path)) continue;
    seen.add(path);
    episodes.push({ path, title: r.article.title || "", date: r.local_date || "" });
  }
  log("ok", `NTS returned ${data.results?.length ?? 0} results → ${episodes.length} unique episodes`);
  return episodes;
}

async function ntsTracklist(episodePath: string): Promise<Array<{ artist: string; title: string }>> {
  const url = `${NTS_API}${episodePath}/tracklist`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    log("fail", `NTS tracklist fetch error: ${episodePath} — ${err instanceof Error ? err.message : err}`);
    return [];
  }
  if (!res.ok) {
    log("fail", `NTS tracklist HTTP ${res.status}: ${episodePath}`);
    return [];
  }
  let data: any;
  try {
    data = await res.json();
  } catch (err) {
    log("fail", `NTS tracklist JSON parse error: ${episodePath}`);
    return [];
  }
  const tracks = data.results || (data as unknown as Array<{ artist: string; title: string }>);
  if (!Array.isArray(tracks)) return [];
  return tracks.filter((t) => t.artist?.trim() && t.title?.trim());
}

async function ntsEpisodeArtwork(episodePath: string): Promise<string | null> {
  try {
    const url = `${NTS_API}${episodePath}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const data = await res.json() as any;
    return data.media?.picture_large
      || data.media?.picture_medium_large
      || data.media?.picture_medium
      || data.media?.background_large
      || data.media?.background_medium_large
      || null;
  } catch {
    return null;
  }
}

export const ntsSource: DiscoverySource = {
  name: "nts",

  async searchForSeed(artist: string, title: string): Promise<SourceEpisode[]> {
    const query = `${artist} ${title}`;
    const results = await ntsSearch(query);
    return results.map((r) => ({
      url: `https://www.nts.live${r.path}`,
      title: r.title,
      date: r.date ? r.date.split("T")[0] : null,
      // Store path in a way we can recover it for tracklist/artwork lookups
      // We encode the NTS path as a property via the URL itself
    }));
  },

  async getTracklist(episodeUrl: string): Promise<SourceTrack[]> {
    // Extract the path from the full NTS episode URL
    // e.g. https://www.nts.live/shows/... → /shows/...
    const path = episodeUrl.replace("https://www.nts.live", "");
    const tracks = await ntsTracklist(path);
    return tracks.map((t) => ({ artist: t.artist.trim(), title: t.title.trim() }));
  },

  async getArtwork(episodeUrl: string): Promise<string | null> {
    const path = episodeUrl.replace("https://www.nts.live", "");
    return ntsEpisodeArtwork(path);
  },
};
