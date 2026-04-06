import axios from "axios";
import pLimit from "p-limit";
import * as cheerio from "cheerio";
import { batchAsync, memoizeFn, retryAsync, withTimeout } from "../utils.js";
import {
  AJAX_PATH,
  IKIRU_CHAPTER_LIST_MAX_PAGES,
  IKIRU_EMPTY_PAGE_BREAK_STREAK,
  IKIRU_LATEST_MAX_PAGES,
  LATEST_URL,
  SITE_URL,
  baseHeaders,
  cleanImageUrl,
  normalizeSource,
  normalizeSourceUrl,
  normalizeText,
  resolveChapterUrl,
  scrapeWithHeaders,
  shouldPrioritizeSecondaryTitle,
  toAbsoluteUrl,
  withRetry,
} from "./shared.js";
import {
  getCachedOrFetch,
  isValidDate,
  logWarnError,
  parseDateWithFallback,
  safeParseDate,
} from "../dateUtils.js";

// FastCron-safe configuration to prevent 30s timeouts
const FASTCRON_SAFE_CONFIG = {
  REQUEST_TIMEOUT: 8000, // 8s per request
  MAX_RETRIES: 2, // 2 retry max
  RETRY_DELAY: 1000, // 1s delay
  BATCH_SIZE: 5, // 5 concurrent
  TOTAL_TIMEOUT: 25000, // Force exit at 25s
  MAX_CHAPTERS_PER_RUN: 15, // Limit chapters per run
};

// Track start time for early exit logic (passed as parameter, not global)
let scrapeStartTime = Date.now();

// Helper: Extract manga info from card element
function extractMangaInfo($card) {
  const $vertical = $card.children("div").first();
  if (!$vertical.length) return null;

  const title = $vertical.find("h1").first().text().trim();
  if (!title) return null;

  const mangaUrl = toAbsoluteUrl(
    $vertical.find("a[href*='/manga/']").first().attr("href"),
  );
  const cover = cleanImageUrl(
    toAbsoluteUrl($vertical.find("img").first().attr("src")),
  );
  const rating = $vertical.find(".numscore").text().trim() || "N/A";

  const status = extractStatus($vertical);

  return { title, mangaUrl, cover, rating, status, $vertical };
}

// Helper: Extract status from manga card
const VALID_STATUSES = ["Ongoing", "Completed", "Hiatus"];
function extractStatus($vertical) {
  return (
    $vertical
      .find("p.font-normal.text-xs")
      .filter((_, el) => VALID_STATUSES.includes($(el).text().trim()))
      .first()
      .text()
      .trim() || "Unknown"
  );
}

// Helper: Check if chapter is fresh (within 24h)
function isChapterFresh(parsedUpdated, now) {
  const diffHours = (now - parsedUpdated.getTime()) / 3600000;
  return diffHours <= 24;
}

// Helper: Parse chapter row data
function parseChapterRow($link, mangaInfo, seen, now) {
  const chapterText = $link.find("p").text().trim();
  const updatedTime = $link.find("time[datetime]").first()?.attr("datetime");
  let parsedUpdated = safeParseDate(updatedTime);

  if (!parsedUpdated) {
    const fallbackText = $link.find("time").first().text().trim();
    parsedUpdated = parseRelativeTimeText(fallbackText);
  }

  const rawUrl = $link.attr("href");
  if (!chapterText || !parsedUpdated || !rawUrl) return null;

  if (!isChapterFresh(parsedUpdated, now)) return null;

  const key = `${mangaInfo.title}-${chapterText}`;
  if (seen.has(key)) return null;
  seen.add(key);

  return {
    title: mangaInfo.title,
    chapter: chapterText,
    url: toAbsoluteUrl(rawUrl),
    cover: mangaInfo.cover,
    mangaUrl: mangaInfo.mangaUrl,
    rating: mangaInfo.rating,
    status: mangaInfo.status,
    updatedTime: parsedUpdated?.toISOString() ?? null,
    source: "ikiru",
  };
}

// Main parse function - now clean and focused
function parsePage($, seen) {
  const results = [];
  const now = Date.now(); // Calculate once
  let foundFresh = false;

  const $cards = $("#search-results").children();

  for (const card of $cards) {
    const mangaInfo = extractMangaInfo($(card));
    if (!mangaInfo) continue;

    const $chapterLinks = mangaInfo.$vertical.find("a[href*='/chapter-']");
    if (!$chapterLinks.length) continue;

    for (const el of $chapterLinks) {
      const chapter = parseChapterRow($(el), mangaInfo, seen, now);
      if (chapter) {
        results.push(chapter);
        foundFresh = true;
      }
    }
  }

  return { results, foundFresh };
}

// Memoized version of collectIkiruRecentChaptersFromMangaPage for repeated calls
const memoizedCollectFromMangaPage = memoizeFn(
  collectIkiruRecentChaptersFromMangaPage,
  ($, mangaUrl, baseItem, seen) => `${mangaUrl}-${baseItem?.title || ""}`,
);

export function collectIkiruRecentChaptersFromMangaPage(
  $,
  mangaUrl,
  baseItem = {},
  seen = null,
) {
  const results = [];
  const title =
    normalizeText(baseItem?.title) ||
    normalizeText($("h1").first().text()) ||
    normalizeText($(".entry-title, .post-title, .series-title").first().text());
  const cover =
    baseItem?.cover ??
    cleanImageUrl(
      toAbsoluteUrl(
        $(".summary_image img, .thumb img, img.wp-post-image")
          .first()
          .attr("src"),
      ),
    );
  const rating =
    (baseItem?.rating ??
      normalizeText($(".numscore, .rating-prc .num").first().text())) ||
    "N/A";
  const status =
    (baseItem?.status ??
      normalizeText(
        $("p.font-normal.text-xs, .tsinfo .imptdt i")
          .filter((_, el) =>
            ["Ongoing", "Completed", "Hiatus"].includes($(el).text().trim()),
          )
          .first()
          .text(),
      )) ||
    "Unknown";
  const fallbackMangaUrl = toAbsoluteUrl(mangaUrl);
  const seenKeys = seen instanceof Set ? seen : new Set();

  $(
    "li:has(a[href*='/chapter-']), .eplister li, .clstyle li, .chapters li",
  ).each((_, el) => {
    const $row = $(el);
    const href = $row.find("a[href*='/chapter-']").first().attr("href");
    const chapterUrl = resolveChapterUrl(href, fallbackMangaUrl);
    const chapterText =
      normalizeText($row.find("a[href*='/chapter-'] p").first().text()) ||
      normalizeText($row.find("a[href*='/chapter-']").first().text());
    const rawUpdated =
      $row.find("time[datetime]").first().attr("datetime") ||
      $row.find("time").first().text().trim() ||
      $row
        .find(".text-gray-500, .text-xs, .date, .chapter-date, .chapterdate")
        .first()
        .text()
        .trim() ||
      null;
    const parsedUpdated =
      safeParseDate(rawUpdated) ||
      parseLooseRelativeTime(rawUpdated) ||
      parseRelativeTimeText(rawUpdated);

    if (!chapterUrl || !chapterText || !parsedUpdated) return;
    if ((Date.now() - parsedUpdated.getTime()) / 3600000 > 24) return;

    const key = `${title}-${chapterText}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);

    results.push({
      title,
      chapter: chapterText,
      url: chapterUrl,
      cover,
      mangaUrl: fallbackMangaUrl,
      rating,
      status,
      updatedTime: parsedUpdated.toISOString(),
      source: "ikiru",
    });
  });

  return results;
}

function extractIkiruMangaId($) {
  const rawHxGet =
    $("#chapter-list").attr("hx-get") ||
    $("[hx-get*='action=chapter_list']").first().attr("hx-get") ||
    "";
  const match = String(rawHxGet).match(/manga_id=(\d+)/i);
  return match ? match[1] : null;
}

export function collectIkiruRecentChaptersFromAjaxHtml(
  html,
  mangaUrl,
  baseItem = {},
  seen = null,
) {
  const $ = cheerio.load(html);
  const results = [];
  const title = normalizeText(baseItem?.title);
  const cover = baseItem?.cover ?? null;
  const rating = baseItem?.rating || "N/A";
  const status = baseItem?.status || "Unknown";
  const fallbackMangaUrl = toAbsoluteUrl(mangaUrl);
  const seenKeys = seen instanceof Set ? seen : new Set();
  let foundOlderThan24h = false;

  $(
    "#chapter-list > div[data-chapter-number], #chapter-list .flex[data-chapter-number]",
  ).each((_, el) => {
    const $row = $(el);
    const href = $row.find("a[href*='/chapter-']").first().attr("href");
    const chapterUrl = resolveChapterUrl(href, fallbackMangaUrl);
    const chapterText = normalizeText($row.find("span").first().text());
    const rawUpdated =
      $row.find("time[datetime]").first().attr("datetime") ||
      $row.find("time").first().text().trim() ||
      null;
    const parsedUpdated =
      safeParseDate(rawUpdated) ||
      parseLooseRelativeTime(rawUpdated) ||
      parseRelativeTimeText(rawUpdated);

    if (!chapterUrl || !chapterText || !parsedUpdated) return;

    const diffHours = (Date.now() - parsedUpdated.getTime()) / 3600000;
    if (diffHours > 24) {
      foundOlderThan24h = true;
      return;
    }

    const key = `${title}-${chapterText}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);

    results.push({
      title,
      chapter: chapterText,
      url: chapterUrl,
      cover,
      mangaUrl: fallbackMangaUrl,
      rating,
      status,
      updatedTime: parsedUpdated.toISOString(),
      source: "ikiru",
    });
  });

  return { results, foundOlderThan24h };
}

async function fetchIkiruRecentChaptersFromAjax(
  mangaId,
  mangaUrl,
  redis,
  baseItem = {},
  seen = null,
) {
  if (!mangaId) return [];

  const collected = [];
  const maxPages = Math.max(1, IKIRU_CHAPTER_LIST_MAX_PAGES);

  // Early exit check before starting
  if (
    Date.now() - scrapeStartTime >
    FASTCRON_SAFE_CONFIG.TOTAL_TIMEOUT - 5000
  ) {
    console.warn(
      `[fetchIkiruRecentChaptersFromAjax] Approaching timeout, skipping ${mangaUrl}`,
    );
    return collected;
  }

  for (let page = 1; page <= maxPages; page++) {
    // Check elapsed time before each page request
    if (
      Date.now() - scrapeStartTime >
      FASTCRON_SAFE_CONFIG.TOTAL_TIMEOUT - 3000
    ) {
      console.warn(
        `[fetchIkiruRecentChaptersFromAjax] Timeout approaching, stopping at page ${page}`,
      );
      break;
    }

    const endpoint = `${SITE_URL}${AJAX_PATH}?manga_id=${encodeURIComponent(mangaId)}&page=${page}&action=chapter_list`;
    try {
      // Use withTimeout and retryAsync for FastCron safety
      const res = await retryAsync(
        async () => {
          const headers = await baseHeaders(redis, {
            Accept: "text/html, */*",
          });
          return withTimeout(
            axios.get(endpoint, {
              headers,
              timeout: FASTCRON_SAFE_CONFIG.REQUEST_TIMEOUT,
            }),
            FASTCRON_SAFE_CONFIG.REQUEST_TIMEOUT + 1000,
            `Ajax request timeout for ${mangaUrl} page ${page}`,
          );
        },
        {
          maxAttempts: FASTCRON_SAFE_CONFIG.MAX_RETRIES,
          delay: FASTCRON_SAFE_CONFIG.RETRY_DELAY,
          backoff: 2,
        },
      );

      const { results, foundOlderThan24h } =
        collectIkiruRecentChaptersFromAjaxHtml(
          res.data,
          mangaUrl,
          baseItem,
          seen,
        );
      if (results.length) collected.push(...results);
      if (!results.length || foundOlderThan24h) break;
    } catch (err) {
      console.warn(
        `[fetchIkiruRecentChaptersFromAjax] Failed for ${mangaUrl}:`,
        err.message,
      );
      break;
    }
  }

  return collected.slice(0, FASTCRON_SAFE_CONFIG.MAX_CHAPTERS_PER_RUN);
}

async function fetchIkiruRecentChaptersFromMangaPage(
  mangaUrl,
  redis,
  baseItem = {},
  seen = null,
) {
  if (!mangaUrl) return [];

  // Check elapsed time before starting
  if (
    Date.now() - scrapeStartTime >
    FASTCRON_SAFE_CONFIG.TOTAL_TIMEOUT - 5000
  ) {
    console.warn(
      `[fetchIkiruRecentChaptersFromMangaPage] Timeout approaching, skipping ${mangaUrl}`,
    );
    return [];
  }

  try {
    // Use withTimeout and retryAsync for FastCron safety
    const headers = await baseHeaders(redis);
    const res = await retryAsync(
      async () =>
        withTimeout(
          axios.get(mangaUrl, {
            headers,
            timeout: FASTCRON_SAFE_CONFIG.REQUEST_TIMEOUT,
          }),
          FASTCRON_SAFE_CONFIG.REQUEST_TIMEOUT + 1000,
          `Manga page request timeout for ${mangaUrl}`,
        ),
      {
        maxAttempts: FASTCRON_SAFE_CONFIG.MAX_RETRIES,
        delay: FASTCRON_SAFE_CONFIG.RETRY_DELAY,
        backoff: 2,
      },
    );

    const $ = cheerio.load(res.data);
    const mangaId = extractIkiruMangaId($);

    // Early exit check before AJAX call
    if (
      Date.now() - scrapeStartTime >
      FASTCRON_SAFE_CONFIG.TOTAL_TIMEOUT - 8000
    ) {
      console.warn(
        `[fetchIkiruRecentChaptersFromMangaPage] Timeout approaching, skipping AJAX for ${mangaUrl}`,
      );
      return collectIkiruRecentChaptersFromMangaPage(
        $,
        mangaUrl,
        baseItem,
        seen,
      );
    }

    const ajaxResults = await fetchIkiruRecentChaptersFromAjax(
      mangaId,
      mangaUrl,
      redis,
      baseItem,
      seen,
    );
    if (ajaxResults.length) return ajaxResults;
    return collectIkiruRecentChaptersFromMangaPage($, mangaUrl, baseItem, seen);
  } catch (err) {
    console.warn(
      `[fetchIkiruRecentChaptersFromMangaPage] Failed for ${mangaUrl}:`,
      err.message,
    );
    return [];
  }
}

export async function expandIkiruUpdatesFromDetailPages(
  items = [],
  redis = null,
  preferredTitleKeys = null,
) {
  if (!(preferredTitleKeys instanceof Set) || preferredTitleKeys.size === 0) {
    return items;
  }

  // Check elapsed time before starting expansion
  if (
    Date.now() - scrapeStartTime >
    FASTCRON_SAFE_CONFIG.TOTAL_TIMEOUT - 10000
  ) {
    console.warn(
      "[expandIkiruUpdatesFromDetailPages] Timeout approaching, skipping expansion",
    );
    return items;
  }

  // Use generator for memory-efficient candidate selection
  const candidates = [];
  const candidateKeys = new Set();
  const candidateGenerator = lazyFilterMap(
    items,
    (item) => {
      if (normalizeSource(item?.source) !== "ikiru") return false;
      if (!shouldPrioritizeSecondaryTitle(item?.title, preferredTitleKeys))
        return false;
      const candidateKey = normalizeSourceUrl(
        item?.mangaUrl || item?.url || "",
      );
      if (!candidateKey || candidateKeys.has(candidateKey)) return false;
      candidateKeys.add(candidateKey);
      return true;
    },
    (item) => item,
  );

  // Collect candidates (limited memory footprint)
  for (const candidate of candidateGenerator) {
    candidates.push(candidate);
    if (candidates.length >= 1000) break; // Hard limit to prevent memory explosion
  }

  if (!candidates.length) return items;

  const candidateKeySet = new Set(
    candidates.map((item) =>
      normalizeSourceUrl(item?.mangaUrl || item?.url || ""),
    ),
  );
  const seen = new Set(
    items
      .filter(
        (item) =>
          !candidateKeySet.has(
            normalizeSourceUrl(item?.mangaUrl || item?.url || ""),
          ),
      )
      .map(
        (item) =>
          `${String(item?.title || "").trim()}-${String(item?.chapter || "").trim()}`,
      ),
  );
  const replacementMap = new Map();

  const limit = pLimit(5);

  // Process candidates in batches to control memory usage
  for (const batch of chunked(candidates, 20)) {
    await Promise.all(
      batch.map((item) =>
        limit(async () => {
          const expanded = await fetchIkiruRecentChaptersFromMangaPage(
            item.mangaUrl || item.url,
            redis,
            item,
            seen,
          );
          if (expanded.length) {
            replacementMap.set(
              normalizeSourceUrl(item.mangaUrl || item.url || ""),
              expanded,
            );
          }
        }),
      ),
    );
    // Allow event loop to process other tasks between batches
    await new Promise((resolve) => setImmediate(resolve));
  }

  if (!replacementMap.size) return items;

  const merged = [];
  const injected = new Set();
  for (const item of items) {
    const key = normalizeSourceUrl(item?.mangaUrl || item?.url || "");
    if (replacementMap.has(key)) {
      if (injected.has(key)) continue;
      merged.push(...replacementMap.get(key));
      injected.add(key);
      continue;
    }
    merged.push(item);
  }

  return merged;
}

// Helper: Extract date from meta tags
function extractDateFromMetaTags($) {
  const rawModified =
    $("time[itemprop='dateModified']").attr("datetime") ||
    $("meta[property='article:modified_time']").attr("content") ||
    $("meta[property='og:updated_time']").attr("content") ||
    null;
  return parseDateWithFallback(rawModified);
}

// Helper: Extract dates from chapter list rows
function extractDatesFromChapterRows($) {
  const dates = [];
  const selectors =
    "li:has(a[href*='/chapter-']), .eplister li, .clstyle li, .chapters li";

  $(selectors).each((_, el) => {
    const $row = $(el);
    const raw =
      $row.find("time[datetime]").first().attr("datetime") ||
      $row.find("time").first().text().trim() ||
      $row
        .find(".text-gray-500, .text-xs, .date, .chapter-date, .chapterdate")
        .first()
        .text()
        .trim() ||
      null;

    const parsed = parseDateWithFallback(raw);
    if (isValidDate(parsed)) dates.push(parsed);
  });

  return dates;
}

// Helper: Extract date from "Last Updates" label
function extractDateFromLastUpdatesLabel($) {
  let lastUpdatesRaw = null;

  $("h4, p, span").each((_, el) => {
    if (lastUpdatesRaw) return false; // Break early
    const label = $(el).text().trim().toLowerCase();
    if (!label.includes("last updates")) return;
    const row = $(el).closest("div");
    lastUpdatesRaw =
      row.find("p").last().text().trim() ||
      row.siblings("div").first().find("p").first().text().trim();
  });

  return lastUpdatesRaw ? parseDateWithFallback(lastUpdatesRaw) : null;
}

// Helper: Fetch and extract date from latest chapter page
async function extractDateFromLatestChapter(mangaUrl, $, redis) {
  const latestChapterLink = $("a[href*='/chapter-']").first().attr("href");
  if (!latestChapterLink) return null;

  try {
    const chapterUrl = resolveChapterUrl(latestChapterLink, mangaUrl);
    const headers = await baseHeaders(redis);

    const chapterRes = await retryAsync(
      async () =>
        withTimeout(
          axios.get(chapterUrl, {
            headers,
            timeout: FASTCRON_SAFE_CONFIG.REQUEST_TIMEOUT,
          }),
          FASTCRON_SAFE_CONFIG.REQUEST_TIMEOUT + 1000,
          `Chapter detail timeout for ${chapterUrl}`,
        ),
      {
        maxAttempts: FASTCRON_SAFE_CONFIG.MAX_RETRIES,
        delay: FASTCRON_SAFE_CONFIG.RETRY_DELAY,
        backoff: 2,
      },
    );

    const $$ = cheerio.load(chapterRes.data);
    const chapterRaw =
      $$("time[datetime]").first().attr("datetime") ||
      $$("time").first().text().trim() ||
      null;

    return parseDateWithFallback(chapterRaw);
  } catch {
    return null;
  }
}

export async function fetchLatestMangaUpdateTime(mangaUrl, redis = null) {
  if (!mangaUrl) return null;

  const cacheKey = `lastupd:${mangaUrl}`;
  const cached = await getCachedOrFetch(
    redis,
    cacheKey,
    async () => fetchLatestUpdateFromSource(mangaUrl, redis),
    300,
    "fetchLatestMangaUpdateTime",
  );

  return cached;
}

// Main fetch logic - extracted for caching
async function fetchLatestUpdateFromSource(mangaUrl, redis) {
  const res = await scrapeWithHeaders(mangaUrl, redis, { timeout: 6000 });
  const $ = cheerio.load(res.data);

  // Strategy 1: Meta tags (most accurate)
  const metaDate = extractDateFromMetaTags($);
  if (isValidDate(metaDate)) return metaDate;

  // Strategy 2: Chapter list rows
  const chapterDates = extractDatesFromChapterRows($);
  const latestChapterDate = chapterDates.sort(
    (a, b) => b.getTime() - a.getTime(),
  )[0];
  if (isValidDate(latestChapterDate)) return latestChapterDate;

  // Strategy 3: Last Updates label
  const labelDate = extractDateFromLastUpdatesLabel($);
  if (isValidDate(labelDate)) return labelDate;

  // Strategy 4: Latest chapter page (deep dive)
  const chapterDate = await extractDateFromLatestChapter(mangaUrl, $, redis);
  if (isValidDate(chapterDate)) return chapterDate;

  return null;
}

export function shouldBreakIkiruLatestScan({
  emptyPageStreak = 0,
  stalePageStreak = 0,
} = {}) {
  if (emptyPageStreak >= IKIRU_EMPTY_PAGE_BREAK_STREAK) return true;
  if (stalePageStreak >= 2) return true;
  return false;
}

export async function scrapeIkiruUpdatesWithMeta(
  redis = null,
  preferredIkiruTitleKeys = new Set(),
  logger = null,
  { skipExpansion = false } = {},
) {
  // Reset start time at the beginning of each scrape
  scrapeStartTime = Date.now();

  const sourceState = {
    status: "pending",
    count: 0,
    error: null,
    metrics: null,
  };
  let ikiruPageError = null;
  const seen = new Set();
  let pagesScanned = 0;

  // Build page URLs in chunks to avoid large array allocation
  const maxPages = Math.max(1, IKIRU_LATEST_MAX_PAGES);
  const pageUrls = [];
  for (let i = 0; i < maxPages; i++) {
    const page = i + 1;
    pageUrls.push({
      page,
      url: page === 1 ? LATEST_URL : `${LATEST_URL}?the_page=${page}`,
    });
  }

  // Check total timeout before starting fetches
  if (
    Date.now() - scrapeStartTime >
    FASTCRON_SAFE_CONFIG.TOTAL_TIMEOUT - 5000
  ) {
    logger?.warn(
      "Approaching timeout before starting page fetches, returning empty",
    );
    return {
      results: [],
      state: {
        ...sourceState,
        status: "timeout",
        error: "Approaching total timeout",
      },
    };
  }

  // Use batchAsync instead of pLimit for better timeout control and FastCron safety
  const fetchPage = async ({ page, url }) => {
    // Check elapsed time before each page fetch
    if (
      Date.now() - scrapeStartTime >
      FASTCRON_SAFE_CONFIG.TOTAL_TIMEOUT - 3000
    ) {
      logger?.warn({ page }, "Timeout approaching, skipping page fetch");
      return { page, success: false, error: new Error("Timeout approaching") };
    }

    try {
      // Use withTimeout and retryAsync for FastCron safety
      const headers = await baseHeaders(redis);
      const res = await retryAsync(
        async () =>
          withTimeout(
            axios.get(url, {
              headers,
              timeout: FASTCRON_SAFE_CONFIG.REQUEST_TIMEOUT,
            }),
            FASTCRON_SAFE_CONFIG.REQUEST_TIMEOUT + 1000,
            `Page fetch timeout for page ${page}`,
          ),
        {
          maxAttempts: FASTCRON_SAFE_CONFIG.MAX_RETRIES,
          delay: FASTCRON_SAFE_CONFIG.RETRY_DELAY,
          backoff: 2,
        },
      );
      return { page, success: true, data: res.data };
    } catch (err) {
      if (logger)
        logger.warn(
          { page, err: err.message },
          "ikiru latest page fetch failed",
        );
      return { page, success: false, error: err };
    }
  };

  // Process page fetches in batches with concurrency control
  const pageResponses = await batchAsync(
    pageUrls,
    fetchPage,
    FASTCRON_SAFE_CONFIG.BATCH_SIZE,
  );

  // Process responses in page order so `seen` dedup is deterministic
  const rawResults = [];
  let emptyPageStreak = 0;
  let stalePageStreak = 0;
  for (const resp of pageResponses) {
    if (!resp.success) {
      if (!ikiruPageError) ikiruPageError = resp.error;
      continue;
    }
    pagesScanned = Math.max(pagesScanned, resp.page);
    const $ = cheerio.load(resp.data);
    const { results, foundOlderThan24h, foundFreshWithin24h } = parsePage(
      $,
      seen,
    );
    rawResults.push(...results);
    if (logger)
      logger.info(
        { page: resp.page, count: results.length },
        "ikiru latest page parsed",
      );

    // Early termination: if page 1 has no fresh chapters, stop immediately
    if (resp.page === 1 && results.length === 0) {
      logger?.info(
        { page: resp.page },
        "No chapters on first page, stopping early",
      );
      break;
    }

    // Early termination: if all chapters on page 1 are older than 24h, stop
    if (
      resp.page === 1 &&
      results.length > 0 &&
      !foundFreshWithin24h &&
      foundOlderThan24h
    ) {
      logger?.info(
        { page: resp.page, count: results.length },
        "Only stale chapters on first page, stopping early",
      );
      break;
    }

    // Maintain streak metrics for observability
    emptyPageStreak = results.length === 0 ? emptyPageStreak + 1 : 0;
    stalePageStreak =
      !foundFreshWithin24h && foundOlderThan24h ? stalePageStreak + 1 : 0;

    // Early termination: if 2 consecutive pages have no fresh content, stop
    if (stalePageStreak >= 2) {
      logger?.info(
        { page: resp.page, stalePageStreak },
        "2 consecutive pages without fresh content, stopping early",
      );
      break;
    }
  }

  const ikiruResults = rawResults;

  // Check timeout before expansion
  let expandedResults = ikiruResults;
  if (
    !skipExpansion &&
    Date.now() - scrapeStartTime < FASTCRON_SAFE_CONFIG.TOTAL_TIMEOUT - 8000
  ) {
    expandedResults = await expandIkiruUpdatesFromDetailPages(
      ikiruResults,
      redis,
      preferredIkiruTitleKeys,
    );
  } else if (!skipExpansion) {
    logger?.warn("Skipping expansion due to timeout approaching");
  }
  sourceState.status =
    ikiruPageError && expandedResults.length === 0 ? "error" : "ok";
  sourceState.count = expandedResults.length;
  sourceState.error =
    ikiruPageError && expandedResults.length === 0
      ? ikiruPageError.message
      : null;
  sourceState.metrics = {
    pagesScanned,
    stalePageStreak,
    emptyPageStreak,
    maxPages: Math.max(1, IKIRU_LATEST_MAX_PAGES),
    preferredTitles: preferredIkiruTitleKeys.size,
    expandedCount: skipExpansion
      ? 0
      : Math.max(0, expandedResults.length - ikiruResults.length),
    expansionSkipped: !!skipExpansion,
  };

  return { results: expandedResults, state: sourceState };
}

export async function fetchRandomIkiruManga(redis = null) {
  try {
    const fetchPath =
      "advanced-search/?the_type%5B%5D=manhwa&the_type%5B%5D=manhua&order=desc&orderby=popular";
    const initialUrl = `${SITE_URL}/${fetchPath}&the_page=1`;

    // Use withTimeout and retryAsync for FastCron safety
    const headers = await baseHeaders(redis);
    const initialRes = await retryAsync(
      async () =>
        withTimeout(
          axios.get(initialUrl, {
            headers,
            timeout: FASTCRON_SAFE_CONFIG.REQUEST_TIMEOUT,
          }),
          FASTCRON_SAFE_CONFIG.REQUEST_TIMEOUT + 1000,
          "Random manga initial fetch timeout",
        ),
      {
        maxAttempts: FASTCRON_SAFE_CONFIG.MAX_RETRIES,
        delay: FASTCRON_SAFE_CONFIG.RETRY_DELAY,
        backoff: 2,
      },
    );
    const $initial = cheerio.load(initialRes.data);

    let maxPage = 1;

    // Search for pagination numbers and 'last' links
    $initial(
      ".pagination a, .page-numbers, a.page-numbers, .pagination-next",
    ).each((_, el) => {
      const $el = $initial(el);
      const text = $el.text().trim();
      const num = Number.parseInt(text, 10);
      if (Number.isFinite(num)) {
        maxPage = Math.max(maxPage, num);
      }

      const href = $el.attr("href");
      if (href) {
        const m =
          href.match(/the_page=(\d+)/) ||
          href.match(/page=(\d+)/) ||
          href.match(/\/page\/(\d+)/);
        if (m) {
          const p = Number.parseInt(m[1], 10);
          if (Number.isFinite(p)) maxPage = Math.max(maxPage, p);
        }
      }
    });

    if (maxPage <= 1) maxPage = 50;

    const randPage = Math.floor(Math.random() * maxPage) + 1;
    let $ = $initial;

    if (randPage > 1) {
      const url = `${SITE_URL}/${fetchPath}&the_page=${randPage}`;
      try {
        // Use withTimeout and retryAsync for FastCron safety
        const headers = await baseHeaders(redis);
        const res = await retryAsync(
          async () =>
            withTimeout(
              axios.get(url, {
                headers,
                timeout: FASTCRON_SAFE_CONFIG.REQUEST_TIMEOUT,
              }),
              FASTCRON_SAFE_CONFIG.REQUEST_TIMEOUT + 1000,
              `Random manga page fetch timeout for page ${randPage}`,
            ),
          {
            maxAttempts: FASTCRON_SAFE_CONFIG.MAX_RETRIES,
            delay: FASTCRON_SAFE_CONFIG.RETRY_DELAY,
            backoff: 2,
          },
        );
        if (res.data) $ = cheerio.load(res.data);
      } catch {
        console.warn(
          `[fetchRandomIkiruManga] Failed to fetch page ${randPage}, falling back to page 1`,
        );
        $ = $initial;
      }
    }

    let attempts = 0;
    while (attempts < 3) {
      const results = [];
      const containerSelector = "#search-results";

      $(containerSelector)
        .children()
        .each((_, card) => {
          const $card = $(card);
          const $vertical = $card.children("div").first();
          if (!$vertical.length) return;

          const title = $vertical.find("h1").first().text().trim();
          if (!title) return;

          // Strict type check: Some sites might include Manga in advanced search if categories overlap
          const typeText = $vertical
            .find(".type, .manga-type, [class*='type'], .font-bold.text-xs")
            .text()
            .trim()
            .toLowerCase();
          const isManga =
            typeText.includes("manga") &&
            !typeText.includes("manhwa") &&
            !typeText.includes("manhua");
          if (isManga) return;

          const mangaUrl = toAbsoluteUrl(
            $vertical.find("a[href*='/manga/']").first().attr("href"),
          );
          const cover = cleanImageUrl(
            toAbsoluteUrl($vertical.find("img").first().attr("src")),
          );
          const rating = $vertical.find(".numscore").text().trim() || "N/A";
          const status =
            $vertical
              .find("p.font-normal.text-xs")
              .filter((_, el) =>
                ["Ongoing", "Completed", "Hiatus"].includes(
                  $(el).text().trim(),
                ),
              )
              .first()
              .text()
              .trim() || "Unknown";

          results.push({ title, mangaUrl, cover, rating, status });
        });

      if (results.length > 0) {
        const randomIndex = Math.floor(Math.random() * results.length);
        return results[randomIndex];
      }

      // No results on this page, try another random page
      attempts += 1;
      if (attempts < 3) {
        const nextRandPage = Math.floor(Math.random() * maxPage) + 1;
        const url = `${SITE_URL}/${fetchPath}&the_page=${nextRandPage}`;
        try {
          // Use withTimeout and retryAsync for FastCron safety
          const headers = await baseHeaders(redis);
          const res = await retryAsync(
            async () =>
              withTimeout(
                axios.get(url, {
                  headers,
                  timeout: FASTCRON_SAFE_CONFIG.REQUEST_TIMEOUT,
                }),
                FASTCRON_SAFE_CONFIG.REQUEST_TIMEOUT + 1000,
                `Random manga retry fetch timeout for page ${nextRandPage}`,
              ),
            {
              maxAttempts: FASTCRON_SAFE_CONFIG.MAX_RETRIES,
              delay: FASTCRON_SAFE_CONFIG.RETRY_DELAY,
              backoff: 2,
            },
          );
          if (res.data) $ = cheerio.load(res.data);
          else break;
        } catch {
          break;
        }
      }
    }

    // Last resort: Just try the very first page if all else fails
    if ($ !== $initial) {
      const firstResults = [];
      $initial("#search-results")
        .children()
        .each((_, card) => {
          const $card = $(card);
          const $vertical = $card.children("div").first();
          if ($vertical.length) {
            const title = $vertical.find("h1").first().text().trim();
            if (title) {
              firstResults.push({
                title,
                mangaUrl: toAbsoluteUrl(
                  $vertical.find("a[href*='/manga/']").first().attr("href"),
                ),
                cover: cleanImageUrl(
                  toAbsoluteUrl($vertical.find("img").first().attr("src")),
                ),
                rating: $vertical.find(".numscore").text().trim() || "N/A",
                status:
                  $vertical
                    .find("p.font-normal.text-xs")
                    .filter((_, el) =>
                      ["Ongoing", "Completed", "Hiatus"].includes(
                        $(el).text().trim(),
                      ),
                    )
                    .first()
                    .text()
                    .trim() || "Unknown",
              });
            }
          }
        });
      if (firstResults.length > 0)
        return firstResults[Math.floor(Math.random() * firstResults.length)];
    }

    return null;
  } catch (err) {
    console.warn("[fetchRandomIkiruManga] Error:", err.message);
    return null;
  }
}

export async function fetchDescription(mangaUrl, redis = null) {
  if (!mangaUrl) return null;

  const cacheKey = `desc:${mangaUrl}`;
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return cached;
    } catch (err) {
      console.warn("[fetchDescription] Redis get failed:", err.message);
    }
  }

  try {
    // Use withTimeout and retryAsync for FastCron safety
    const headers = await baseHeaders(redis);
    const res = await retryAsync(
      async () =>
        withTimeout(
          axios.get(mangaUrl, {
            headers,
            timeout: FASTCRON_SAFE_CONFIG.REQUEST_TIMEOUT,
          }),
          FASTCRON_SAFE_CONFIG.REQUEST_TIMEOUT + 1000,
          `Fetch description timeout for ${mangaUrl}`,
        ),
      {
        maxAttempts: FASTCRON_SAFE_CONFIG.MAX_RETRIES,
        delay: FASTCRON_SAFE_CONFIG.RETRY_DELAY,
        backoff: 2,
      },
    );
    const $ = cheerio.load(res.data);
    let desc =
      $('meta[name="description"]').attr("content") ||
      $(".description, .summary, [class*='description']").first().text().trim();
    desc = desc?.length > 300 ? `${desc.substring(0, 297)}...` : desc;

    if (redis && desc) {
      await redis
        .set(cacheKey, desc, { ex: 1800 })
        .catch((err) =>
          console.warn("[fetchDescription] Redis set failed:", err.message),
        );
    }
    return desc || null;
  } catch (err) {
    console.warn(`[fetchDescription] Failed for ${mangaUrl}:`, err.message);
    return null;
  }
}

export async function scrapePopular() {
  try {
    // Use withTimeout and retryAsync for FastCron safety
    const headers = await baseHeaders(null);
    const res = await retryAsync(
      async () =>
        withTimeout(
          axios.get(SITE_URL, {
            headers,
            timeout: FASTCRON_SAFE_CONFIG.REQUEST_TIMEOUT,
          }),
          FASTCRON_SAFE_CONFIG.REQUEST_TIMEOUT + 1000,
          "Scrape popular timeout",
        ),
      {
        maxAttempts: FASTCRON_SAFE_CONFIG.MAX_RETRIES,
        delay: FASTCRON_SAFE_CONFIG.RETRY_DELAY,
        backoff: 2,
      },
    );
    const $ = cheerio.load(res.data);
    const results = [];
    const seen = new Set();

    $(
      ".swiper-slide a[href*='/manga/'], [class*='slide'] a[href*='/manga/']",
    ).each((_, el) => {
      const $el = $(el);
      const title = $el.attr("title") || $el.find("h4").text().trim();
      const link = $el.attr("href");
      const cover = $el.find("img").first().attr("src");
      if (!title || !link || seen.has(title)) return;
      seen.add(title);
      results.push({
        title,
        url: toAbsoluteUrl(link),
        cover: cleanImageUrl(toAbsoluteUrl(cover)),
        rating: $el.find(".rating, .details p").text().trim() || "N/A",
      });
    });

    return results.slice(0, 10);
  } catch (err) {
    console.error("[scrapePopular] Failed:", err.message);
    return [];
  }
}

export async function scrapeMangaCover(mangaUrl, redis = null) {
  try {
    // Use withTimeout and retryAsync for FastCron safety
    const headers = await baseHeaders(redis);
    const res = await retryAsync(
      async () =>
        withTimeout(
          axios.get(mangaUrl, {
            headers,
            timeout: FASTCRON_SAFE_CONFIG.REQUEST_TIMEOUT,
          }),
          FASTCRON_SAFE_CONFIG.REQUEST_TIMEOUT + 1000,
          `Scrape cover timeout for ${mangaUrl}`,
        ),
      {
        maxAttempts: FASTCRON_SAFE_CONFIG.MAX_RETRIES,
        delay: FASTCRON_SAFE_CONFIG.RETRY_DELAY,
        backoff: 2,
      },
    );
    const $ = cheerio.load(res.data);
    const rawCover = $(".summary_image img, .thumb img, img.wp-post-image")
      .first()
      .attr("src");
    return cleanImageUrl(toAbsoluteUrl(rawCover)) || null;
  } catch (err) {
    console.warn(`[scrapeMangaCover] Failed for ${mangaUrl}:`, err.message);
    return null;
  }
}

function parseAdvancedSearchHTML(html) {
  if (!html || html.includes("No results found")) return [];

  const $ = cheerio.load(html);
  const results = [];
  const seenSlugs = new Set();

  $(".flex.rounded-lg.overflow-hidden").each((_, el) => {
    const $el = $(el);
    const $imgLink = $el.find("a[href*='/manga/']").first();
    const url = $imgLink.attr("href");
    if (!url) return;

    const slugMatch = /\/manga\/([^/]+)\/?$/.exec(url);
    const slug = slugMatch ? slugMatch[1] : null;
    if (!slug || seenSlugs.has(slug)) return;
    seenSlugs.add(slug);

    const rawTitle =
      $imgLink.find("img").attr("alt") || slug.replace(/-/g, " ");
    const title = rawTitle.replace(/&#(\d+);/g, (_, n) =>
      String.fromCharCode(n),
    );
    const cover = cleanImageUrl($imgLink.find("img").attr("src") || null);
    const chapter =
      $el.find("a[href*='/chapter-'] p").first().text().trim() || null;
    const rawUpdated =
      $el.find("time[datetime]").first().attr("datetime") ||
      $el.find("time").first().text().trim() ||
      $el
        .find(
          "a[href*='/chapter-'] .text-gray-500, a[href*='/chapter-'] .text-xs",
        )
        .first()
        .text()
        .trim() ||
      null;
    const updatedTime =
      (
        safeParseDate(rawUpdated) || parseLooseRelativeTime(rawUpdated)
      )?.toISOString() || null;
    const rating = $el.find(".numscore").first().text().trim() || null;

    results.push({
      title,
      url: toAbsoluteUrl(url),
      mangaUrl: toAbsoluteUrl(url),
      slug,
      cover,
      chapter,
      rating,
      updatedTime,
      source: "ikiru",
    });
  });

  return results;
}

const NONCE_PATTERNS = [
  /search_nonce["'\s:=]+([a-f0-9]{10})/,
  /nonce=([a-f0-9]{10})/,
  /["']nonce["']\s*:\s*["']([a-f0-9]{10})["']/,
];
const NONCE_TTL_MS = 5 * 60 * 1000;
const ALLOWED_SEARCH_OPTS = ["genre", "status", "type", "order"];
let nonceCache = { value: null, expiresAt: 0 };

// Memoized version of fetchNonce to avoid redundant requests (with 5-min TTL)
const memoizedFetchNonce = memoizeFn(fetchNonce, () => "nonce");

export async function fetchNonce() {
  if (nonceCache.value && nonceCache.expiresAt > Date.now()) {
    return nonceCache.value;
  }

  const urls = [`${SITE_URL}advanced-search/`, `${SITE_URL}manga/`, SITE_URL];

  for (const url of urls) {
    try {
      // Use withTimeout and retryAsync for FastCron safety
      const headers = await baseHeaders(null, { Accept: "text/html" });
      const res = await retryAsync(
        async () =>
          withTimeout(
            axios.get(url, {
              headers,
              timeout: FASTCRON_SAFE_CONFIG.REQUEST_TIMEOUT,
            }),
            FASTCRON_SAFE_CONFIG.REQUEST_TIMEOUT + 1000,
            `Fetch nonce timeout for ${url}`,
          ),
        {
          maxAttempts: 1, // Only 1 retry for nonce to avoid slowing down search
          delay: FASTCRON_SAFE_CONFIG.RETRY_DELAY,
          backoff: 2,
        },
      );
      for (const pattern of NONCE_PATTERNS) {
        const match = res.data.match(pattern);
        if (match) {
          nonceCache = {
            value: match[1],
            expiresAt: Date.now() + NONCE_TTL_MS,
          };
          return nonceCache.value;
        }
      }
    } catch {
      // ignore
    }
  }

  throw new Error("Nonce not found in any URL");
}

export async function searchIkiru(keyword, opts = {}, redis = null) {
  const safeOpts = Object.fromEntries(
    Object.entries(opts).filter(([k]) => ALLOWED_SEARCH_OPTS.includes(k)),
  );
  const cacheKey = `cache:search:${keyword}:${JSON.stringify(safeOpts)}`;

  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (Array.isArray(cached)) {
        return cached;
      }
    } catch (err) {
      console.warn("[searchIkiru] Redis get failed:", err.message);
    }
  }

  try {
    const nonce = await fetchNonce();
    const params = new URLSearchParams({
      action: "advanced_search",
      search_nonce: nonce,
      query: keyword,
      ...safeOpts,
    });

    const headers = await baseHeaders(redis, {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: `${SITE_URL}advanced-search/`,
      "X-Requested-With": "XMLHttpRequest",
    });

    // Use withTimeout and retryAsync for FastCron safety
    const res = await retryAsync(
      async () =>
        withTimeout(
          axios.post(`${SITE_URL}${AJAX_PATH}`, params, {
            headers,
            timeout: FASTCRON_SAFE_CONFIG.REQUEST_TIMEOUT,
          }),
          FASTCRON_SAFE_CONFIG.REQUEST_TIMEOUT + 2000,
          `Search Ikiru timeout for ${keyword}`,
        ),
      {
        maxAttempts: FASTCRON_SAFE_CONFIG.MAX_RETRIES,
        delay: FASTCRON_SAFE_CONFIG.RETRY_DELAY,
        backoff: 2,
      },
    );

    const results = parseAdvancedSearchHTML(
      typeof res.data === "string" ? res.data : JSON.stringify(res.data),
    );

    if (redis && results.length > 0) {
      await redis
        .set(cacheKey, results, { ex: 600 })
        .catch((err) =>
          console.warn("[searchIkiru] Redis set failed:", err.message),
        );
    }

    return results;
  } catch (err) {
    console.error(`[searchIkiru] Search failed for "${keyword}":`, err.message);
    return [];
  }
}
