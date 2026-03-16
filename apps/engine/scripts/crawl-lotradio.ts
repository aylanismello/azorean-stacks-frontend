#!/usr/bin/env bun
/**
 * The Stacks — Lot Radio Crawler
 *
 * Crawls The Lot Radio episode archive and indexes tracklists into our DB.
 * Episodes are stored with source="lotradio" and their tracklist in the
 * metadata JSONB column for seed-matching at discovery time.
 *
 * Uses the Lot Radio Next.js server action API to enumerate episodes
 * (the index page is fully client-side rendered — static HTML has no links).
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

// Next.js server action ID for the index pagination endpoint.
// This is derived from the action function hash and may change on redeployment.
// If crawling returns 0 results, inspect network requests on /the-index to find the new ID.
const INDEX_ACTION_ID = "c0525175425bb70fffcabc46ac6f1ed53392c63452";
const INDEX_RSC_TREE = "%5B%22%22%2C%7B%22children%22%3A%5B%22(website)%22%2C%7B%22children%22%3A%5B%22the-index%22%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%2Cnull%2Cnull%5D%7D%2Cnull%2Cnull%5D%7D%2Cnull%2Cnull%5D%7D%2Cnull%2Cnull%2Ctrue%5D";

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
 * Fetch a page of episodes from the Lot Radio index via the Next.js server action.
 * The site is fully client-side rendered — the server action is the only way to
 * enumerate episodes without a headless browser.
 *
 * Returns { items, total } where items are episode objects with url/title/date.
 */
async function fetchIndexPage(skip: number, limit: number, since: string): Promise<{
  items: Array<{ url: string; title: string; date: string | null; artwork: string | null }>;
  total: number;
} | null> {
  try {
    const body = JSON.stringify([{
      limit,
      skip,
      order: "date:desc",
      filters: "$undefined",
      staffChoice: "$undefined",
      since,
    }]);

    const res = await fetch(`${LOT_BASE}/the-index`, {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; AzoreanStacks/1.0)",
        "Accept": "text/x-component",
        "Content-Type": "text/plain;charset=UTF-8",
        "next-action": INDEX_ACTION_ID,
        "next-router-state-tree": INDEX_RSC_TREE,
      },
      body,
    });

    if (!res.ok) {
      log("fail", `Index API HTTP ${res.status} (skip=${skip})`);
      return null;
    }

    const text = await res.text();
    // RSC format: each line is `{index}:{json}` — line "1:" has the payload
    const dataLine = text.split("\n").find((l) => l.startsWith("1:"));
    if (!dataLine) {
      log("fail", `Index API: no data line in response (skip=${skip})`);
      return null;
    }

    const payload = JSON.parse(dataLine.slice(2)) as {
      total: number;
      items: Array<{
        title: string;
        slug: string;
        date: string;
        show: { slug: string } | null;
        image: { url: string } | null;
      }>;
    };

    const items = payload.items.map((item) => {
      const showSlug = item.show?.slug ?? "special-guests";
      const url = `${LOT_BASE}/shows/${showSlug}/${item.slug}`;
      const dateMatch = item.slug.match(/^(\d{4}-\d{2}-\d{2})/);
      return {
        url,
        title: item.title,
        date: dateMatch ? dateMatch[1] : null,
        artwork: item.image?.url ?? null,
      };
    });

    return { items, total: payload.total };
  } catch (err) {
    log("fail", `Index API error (skip=${skip}): ${err instanceof Error ? err.message : err}`);
    return null;
  }
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

async function crawlEpisode(url: string, title: string, date: string | null, prefetchedArtwork?: string | null): Promise<boolean> {
  const html = await fetchHtml(url);
  if (!html) {
    log("fail", `Could not fetch episode: ${url}`);
    return false;
  }

  const tracklist = parseTracklist(html);
  const meta = parseEpisodeMeta(html);

  const episodeTitle = meta.title || title;
  const artwork = prefetchedArtwork ?? meta.artwork;

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

  const since = new Date().toISOString();

  // Fetch the first page to get total count and first batch of episodes
  log("info", `Fetching Lot Radio index via server action (offset=${crawlOffset})`);
  await sleep(RATE_LIMIT_MS);

  const firstPage = await fetchIndexPage(crawlOffset, Math.min(crawlLimit, 16), since);
  if (!firstPage) {
    log("fail", "Could not fetch Lot Radio index — action ID may have changed");
    log("info", "To find the new action ID: open /the-index in browser devtools → Network → filter POST → copy next-action header");
    process.exit(1);
  }

  log("ok", `Total episodes available: ${firstPage.total}`);

  // Collect all episodes up to crawlLimit (in pages of 100)
  const allEpisodes = [...firstPage.items];
  const pageSize = 100;
  let skip = crawlOffset + firstPage.items.length;

  while (allEpisodes.length < crawlLimit && skip < firstPage.total) {
    const remaining = crawlLimit - allEpisodes.length;
    const page = await fetchIndexPage(skip, Math.min(remaining, pageSize), since);
    if (!page || page.items.length === 0) break;
    allEpisodes.push(...page.items);
    skip += page.items.length;
    log("info", `  Fetched ${allEpisodes.length}/${Math.min(crawlLimit, firstPage.total)} episode URLs...`);
  }

  log("info", `Fetched ${allEpisodes.length} episode URLs from index`);

  // Check which episodes are already in the DB
  const urls = allEpisodes.map((e) => e.url);
  const { data: existing } = await db.from("episodes")
    .select("url")
    .in("url", urls)
    .eq("source", "lotradio");

  const existingUrls = new Set((existing || []).map((e: any) => e.url));
  log("info", `${existingUrls.size} episodes already in DB — will skip`);

  let crawled = 0;
  let skipped = 0;
  let failed = 0;

  // Filter out already-crawled episodes
  const toCrawl = allEpisodes.filter((ep) => {
    if (existingUrls.has(ep.url)) {
      skipped++;
      return false;
    }
    return true;
  });

  log("info", `Crawling ${toCrawl.length} new episodes with concurrency=10`);

  // Process in concurrent batches of 10
  const CRAWL_CONCURRENCY = 10;
  for (let i = 0; i < toCrawl.length; i += CRAWL_CONCURRENCY) {
    const batch = toCrawl.slice(i, i + CRAWL_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (ep) => {
        const ok = await crawlEpisode(ep.url, ep.title, ep.date, ep.artwork);
        if (ok) {
          crawled++;
          log("ok", `[${crawled}/${toCrawl.length}] ${ep.title || ep.url}`);
        } else {
          failed++;
        }
        return ok;
      }),
    );
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
