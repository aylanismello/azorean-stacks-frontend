/**
 * The Lot Radio discovery source.
 *
 * Discovery is entirely tracklist-based: crawl-lotradio.ts indexes episode
 * tracklists into our DB, and discover.ts/watcher.ts query the DB for
 * episodes where metadata.tracklist contains the seed artist+title.
 *
 * searchForSeed is intentionally a no-op — the DB tracklist matching is done
 * at the discover/watcher level, not here.
 *
 * getTracklist: Fetch episode page HTML and parse tracklist from the DOM.
 * getArtwork: Parse og:image meta tag from episode page HTML.
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

  async searchForSeed(_artist: string, _title: string): Promise<SourceEpisode[]> {
    // Lot Radio discovery uses DB tracklist matching (done in discover.ts/watcher.ts),
    // not web search. The actual matching happens against pre-crawled episode metadata.
    return [];
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
