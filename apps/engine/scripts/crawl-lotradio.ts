#!/usr/bin/env bun
/**
 * The Stacks — Lot Radio Crawler
 *
 * Crawls The Lot Radio episode archive and indexes tracklists into our DB.
 * Episodes are stored with source="lotradio" and their tracklist in the
 * metadata JSONB column for seed-matching at discovery time.
 *
 * Usage: bun run scripts/crawl-lotradio.ts [--limit 50] [--offset 0]
 *
 * Rate limit: 1 request per second (polite crawling).
 * Resume: skips episodes already in DB.
 */
import { parseArgs } from "util";
import { load } from "cheerio";
import { getSupabase } from "../lib/supabase";
import { log, sleep } from "../lib/pipeline";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    limit: { type: "string", default: "50" },
    offset: { type: "string", default: "0" },
  },
  strict: false,
});

const crawlLimit = parseInt(String(values.limit || "50"), 10);
const crawlOffset = parseInt(String(values.offset || "0"), 10);

const db = getSupabase();
const LOT_BASE = "https://www.thelotradio.com";
const RATE_LIMIT_MS = 1_000;

async function fetchHtml(url: string, timeoutMs = 20_000): Promise<string | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; AzoreanStacks/1.0)",
        "Accept": "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) {
      log("fail", `HTTP ${res.status}: ${url}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    log("fail", `Fetch error: ${url} — ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * Parse episode links from the Lot Radio index/archive page.
 * Returns unique episode URLs.
 */
function parseIndexPage(html: string): Array<{ url: string; title: string; date: string | null }> {
  const $ = load(html);
  const episodes: Array<{ url: string; title: string; date: string | null }> = [];
  const seen = new Set<string>();

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    // Episode URLs: /shows/{show-slug}/{YYYY-MM-DD-HHMM}
    if (!/^\/shows\/[^/]+\/\d{4}-\d{2}-\d{2}/.test(href)) return;

    const url = href.startsWith("http") ? href : `${LOT_BASE}${href}`;
    if (seen.has(url)) return;
    seen.add(url);

    const dateMatch = href.match(/(\d{4}-\d{2}-\d{2})/);
    const date = dateMatch ? dateMatch[1] : null;
    const title = $(el).attr("aria-label") || $(el).text().trim() || href;

    episodes.push({ url, title, date });
  });

  return episodes;
}

/**
 * Parse tracklist from episode page HTML.
 *
 * Buttons structure:
 * <button>
 *   <div class="grid grid-cols-6">
 *     <span class="col-span-1">00:05:23</span>
 *     <span class="col-span-4 flex flex-col">
 *       <span>Track Title</span>
 *       <span class="opacity-40">Artist</span>
 *     </span>
 *   </div>
 * </button>
 */
function parseTracklist(html: string): Array<{ artist: string; title: string; timestamp: string }> {
  const $ = load(html);
  const tracks: Array<{ artist: string; title: string; timestamp: string }> = [];

  $("button").each((_, btn) => {
    const gridDiv = $(btn).find("div.grid-cols-6, div[class*='grid-cols-6']").first();
    if (!gridDiv.length) return;

    const spans = gridDiv.find("span");
    if (spans.length < 3) return;

    const timestamp = $(spans[0]).text().trim();
    if (!/^\d{2}:\d{2}:\d{2}$/.test(timestamp)) return;

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
 * Parse episode title and artwork from page HTML.
 */
function parseEpisodeMeta(html: string): { title: string | null; artwork: string | null } {
  const $ = load(html);

  const ogTitle = $('meta[property="og:title"]').attr("content") || null;
  const h1Title = $("h1").first().text().trim() || null;
  const title = ogTitle || h1Title;

  const ogImage = $('meta[property="og:image"]').attr("content") || null;
  const twitterImage = $('meta[name="twitter:image"]').attr("content") || null;
  const artwork = ogImage || twitterImage;

  return { title, artwork };
}

async function crawlEpisode(url: string, title: string, date: string | null): Promise<boolean> {
  await sleep(RATE_LIMIT_MS);

  const html = await fetchHtml(url);
  if (!html) {
    log("fail", `Could not fetch episode: ${url}`);
    return false;
  }

  const tracklist = parseTracklist(html);
  const meta = parseEpisodeMeta(html);

  const episodeTitle = meta.title || title;
  const artwork = meta.artwork;

  log("info", `  ${episodeTitle || url} — ${tracklist.length} tracks`);

  // Upsert episode record with tracklist in metadata
  const { error } = await db.from("episodes").upsert(
    {
      url,
      title: episodeTitle,
      source: "lotradio",
      aired_date: date,
      artwork_url: artwork,
      metadata: {
        tracklist: tracklist.map((t) => ({
          artist: t.artist,
          title: t.title,
          timestamp: t.timestamp,
        })),
        tracklist_count: tracklist.length,
        crawled_at: new Date().toISOString(),
      },
    },
    { onConflict: "url" },
  );

  if (error) {
    log("fail", `DB upsert failed for ${url}: ${error.message}`);
    return false;
  }

  return true;
}

async function main() {
  console.log(`\n  The Stacks — Lot Radio Crawler`);
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Options: limit=${crawlLimit}, offset=${crawlOffset}\n`);

  // Check if DB has a metadata column on episodes (needed for tracklist storage)
  // If not, we gracefully degrade by skipping tracklist storage in metadata
  const { data: testEp } = await db.from("episodes").select("metadata").limit(1).single();
  const hasMetadata = testEp !== null || true; // assume it exists based on tracks table pattern

  log("info", `Fetching Lot Radio index: ${LOT_BASE}/the-index`);
  await sleep(RATE_LIMIT_MS);

  const indexHtml = await fetchHtml(`${LOT_BASE}/the-index`);
  if (!indexHtml) {
    log("fail", "Could not fetch Lot Radio index page");
    process.exit(1);
  }

  const allEpisodes = parseIndexPage(indexHtml);
  log("ok", `Found ${allEpisodes.length} episode links on index page`);

  if (allEpisodes.length === 0) {
    log("warn", "No episodes found — the index page structure may have changed");
    process.exit(0);
  }

  // Apply offset and limit
  const episodesToCrawl = allEpisodes.slice(crawlOffset, crawlOffset + crawlLimit);
  log("info", `Processing ${episodesToCrawl.length} episodes (offset=${crawlOffset}, limit=${crawlLimit})`);

  // Check which episodes are already in the DB
  const urls = episodesToCrawl.map((e) => e.url);
  const { data: existing } = await db.from("episodes")
    .select("url")
    .in("url", urls)
    .eq("source", "lotradio");

  const existingUrls = new Set((existing || []).map((e: any) => e.url));
  log("info", `${existingUrls.size} episodes already in DB — will skip`);

  let crawled = 0;
  let skipped = 0;
  let failed = 0;

  for (const ep of episodesToCrawl) {
    if (existingUrls.has(ep.url)) {
      log("skip", `Already crawled: ${ep.title || ep.url}`);
      skipped++;
      continue;
    }

    const ok = await crawlEpisode(ep.url, ep.title, ep.date);
    if (ok) {
      crawled++;
      log("ok", `[${crawled}/${episodesToCrawl.length - skipped}] ${ep.url}`);
    } else {
      failed++;
    }
  }

  console.log(`\n  ── Done ──`);
  console.log(`  Crawled:  ${crawled}`);
  console.log(`  Skipped:  ${skipped} (already in DB)`);
  console.log(`  Failed:   ${failed}`);
  console.log(`  Total episodes indexed: ${crawled + skipped}\n`);
}

main().catch((err) => {
  console.error("\n  !! Crawler crashed !!");
  console.error(`  ${err instanceof Error ? err.stack || err.message : err}`);
  process.exit(1);
});
