/**
 * The Lot Radio discovery source.
 *
 * Two-phase approach:
 * 1. searchForSeed: Search by artist name at thelotradio.com/search to find
 *    episodes where the seed artist was the DJ/host.
 * 2. getTracklist: Fetch episode page HTML and parse tracklist from the DOM.
 * 3. getArtwork: Parse og:image meta tag from episode page HTML.
 *
 * For tracklist-based matching (finding episodes that PLAYED a seed track),
 * a separate crawl-lotradio.ts script indexes tracklists into our DB. At
 * discovery time, discover.ts queries the DB for those matches.
 *
 * Episode URL pattern: https://www.thelotradio.com/shows/{show-slug}/{YYYY-MM-DD-HHMM}
 */
import { load } from "cheerio";
import type { DiscoverySource, SourceEpisode, SourceTrack } from "../sources";
import { log } from "../pipeline";

const LOT_BASE = "https://www.thelotradio.com";

async function fetchHtml(url: string, timeoutMs = 15_000): Promise<string | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; AzoreanStacks/1.0)",
        "Accept": "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) {
      log("fail", `Lot Radio fetch HTTP ${res.status}: ${url}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    log("fail", `Lot Radio fetch error: ${url} — ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * Parse episode links from a Lot Radio search results page.
 * The search endpoint returns HTML with episode cards/links.
 */
function parseSearchResults(html: string): SourceEpisode[] {
  const $ = load(html);
  const episodes: SourceEpisode[] = [];
  const seen = new Set<string>();

  // Look for links matching the episode URL pattern
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    // Episode URLs: /shows/{show-slug}/{YYYY-MM-DD-HHMM}
    if (!/^\/shows\/[^/]+\/\d{4}-\d{2}-\d{2}/.test(href)) return;

    const url = href.startsWith("http") ? href : `${LOT_BASE}${href}`;
    if (seen.has(url)) return;
    seen.add(url);

    // Try to extract date from URL: YYYY-MM-DD
    const dateMatch = href.match(/(\d{4}-\d{2}-\d{2})/);
    const date = dateMatch ? dateMatch[1] : null;

    // Try to get a title from nearby text or aria-label
    const title = $(el).attr("aria-label") || $(el).text().trim() || href;

    episodes.push({ url, title, date });
  });

  return episodes;
}

/**
 * Parse tracklist from a Lot Radio episode page.
 *
 * Tracklists are in buttons with structure:
 * <button>
 *   <div class="grid grid-cols-6">
 *     <span class="col-span-1">00:05:23</span>   <!-- timestamp -->
 *     <span class="col-span-4 flex flex-col">
 *       <span>Track Title</span>                  <!-- title -->
 *       <span class="opacity-40">Artist</span>    <!-- artist -->
 *     </span>
 *   </div>
 * </button>
 */
function parseTracklist(html: string): SourceTrack[] {
  const $ = load(html);
  const tracks: SourceTrack[] = [];

  // Find tracklist buttons — they contain the grid structure
  $("button").each((_, btn) => {
    const gridDiv = $(btn).find("div.grid-cols-6, div[class*='grid-cols-6']").first();
    if (!gridDiv.length) return;

    const spans = gridDiv.find("span");
    if (spans.length < 3) return;

    // First span: timestamp (col-span-1)
    const timestamp = $(spans[0]).text().trim();
    if (!/^\d{2}:\d{2}:\d{2}$/.test(timestamp)) return; // must look like a timestamp

    // Find the col-span-4 container
    const contentSpan = gridDiv.find("span.col-span-4, span[class*='col-span-4']").first();
    if (!contentSpan.length) return;

    const childSpans = contentSpan.find("span");
    if (childSpans.length < 2) return;

    const titleText = $(childSpans[0]).text().trim();
    const artistText = $(childSpans[1]).text().trim();

    if (!titleText || !artistText) return;

    tracks.push({ artist: artistText, title: titleText, timestamp });
  });

  return tracks;
}

/**
 * Parse og:image or episode thumbnail from page HTML.
 */
function parseArtwork(html: string): string | null {
  const $ = load(html);

  // og:image meta tag
  const ogImage = $('meta[property="og:image"]').attr("content");
  if (ogImage) return ogImage;

  // twitter:image as fallback
  const twitterImage = $('meta[name="twitter:image"]').attr("content");
  if (twitterImage) return twitterImage;

  return null;
}

export const lotRadioSource: DiscoverySource = {
  name: "lotradio",

  async searchForSeed(artist: string, title: string): Promise<SourceEpisode[]> {
    // Search by artist name — finds episodes where the artist was the DJ/host
    const searchUrl = `${LOT_BASE}/search?q=${encodeURIComponent(artist)}&within=sessions`;
    log("info", `Lot Radio search: "${artist}" → ${searchUrl}`);

    const html = await fetchHtml(searchUrl);
    if (!html) return [];

    const episodes = parseSearchResults(html);
    log("ok", `Lot Radio search returned ${episodes.length} episodes for "${artist}"`);
    return episodes;
  },

  async getTracklist(episodeUrl: string): Promise<SourceTrack[]> {
    const html = await fetchHtml(episodeUrl);
    if (!html) return [];

    const tracks = parseTracklist(html);
    log("info", `Lot Radio tracklist: ${tracks.length} tracks from ${episodeUrl}`);
    return tracks;
  },

  async getArtwork(episodeUrl: string): Promise<string | null> {
    const html = await fetchHtml(episodeUrl);
    if (!html) return null;
    return parseArtwork(html);
  },
};
