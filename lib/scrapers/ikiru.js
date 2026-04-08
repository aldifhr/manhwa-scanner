import axios from "axios";
import pLimit from "p-limit";
import * as cheerio from "cheerio";
import { batchAsync, retryAsync, withTimeout } from "../utils.js";
import { getLogger } from "../logger.js";
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
  parseLooseRelativeTime,
  parseRelativeTimeText,
  resolveChapterUrl,
  scrapeWithHeaders,
  shouldPrioritizeSecondaryTitle,
  toAbsoluteUrl,
  withRetry,
  lazyFilterMap,
  chunked,
} from "./shared.js";
import {
  getCachedOrFetch,
  isValidDate,
  logWarnError,
  parseDateWithFallback,
  safeParseDate,
} from "../dateUtils.js";

const logger = getLogger({ scope: "ikiru" });

// FastCron-safe configuration - balanced for reliability and speed
// Timeout values can be overridden via environment variables
const FASTCRON_SAFE_CONFIG = {
  REQUEST_TIMEOUT: Math.max(4000, Number(process.env.IKIRU_REQUEST_TIMEOUT_MS) || 6000), // 6s default
  MAX_RETRIES: Math.min(2, Math.max(1, Number(process.env.IKIRU_MAX_RETRIES) || 1)), // 1 retry default
  RETRY_DELAY: 300, // Faster retry
  BATCH_SIZE: 15, // Increased parallelism with Keep-Alive
  TOTAL_TIMEOUT: Math.max(8000, Number(process.env.IKIRU_TOTAL_TIMEOUT_MS) || 12000), // 12s default
  MAX_CHAPTERS_PER_RUN: Math.min(8, Math.max(3, Number(process.env.IKIRU_MAX_CHAPTERS) || 5)),
};

// ============ MODE 1: CLEAN CODE - Split Functions & Early Returns ============

// Guard clause helpers - now accepts startTime as parameter to avoid global state
const isApproachingTimeout = (startTime, buffer = 5000) =>
  Date.now() - startTime > FASTCRON_SAFE_CONFIG.TOTAL_TIMEOUT - buffer;

const isValidMangaInfo = (info) => info?.title && info?.$vertical?.length;

const isChapterWithin24h = (parsedUpdated) => {
  if (!parsedUpdated) return false;
  const diffHours = (Date.now() - parsedUpdated.getTime()) / 3600000;
  return diffHours <= 24;
};

// Helper: Extract status from manga card
const VALID_STATUSES = new Set(["Ongoing", "Completed", "Hiatus"]);

const findStatusElement = ($vertical) =>
  $vertical
    .find("p.font-normal.text-xs")
    .filter(
      (_, el) =>
        el && el.textContent && VALID_STATUSES.has(el.textContent.trim()),
    )
    .first();

const extractStatusFromElement = ($element) =>
  $element?.text().trim() ?? "Unknown";

const extractStatus = ($vertical) =>
  extractStatusFromElement(findStatusElement($vertical));

// Helper: Get chapter text from link
const getChapterText = ($link) =>
  normalizeText($link.find("p").first().text()) || normalizeText($link.text());

// Helper: Get updated time from element
const getUpdatedTime = ($element) =>
  $element.find("time[datetime]").first()?.attr("datetime") ||
  $element.find("time").first().text().trim();

const parseUpdatedTime = (rawTime) =>
  safeParseDate(rawTime) ||
  parseLooseRelativeTime(rawTime) ||
  parseRelativeTimeText(rawTime);

// Helper: Get manga URL from card
const getMangaUrl = ($vertical) =>
  toAbsoluteUrl($vertical.find("a[href*='/manga/']").first().attr("href"));

// Helper: Get cover from card
const getCover = ($vertical) =>
  cleanImageUrl(toAbsoluteUrl($vertical.find("img").first().attr("src")));

// Helper: Get rating from card
const getRating = ($vertical) =>
  $vertical.find(".numscore").first().text().trim() || "N/A";

// Helper: Extract manga info from card element (refactored to <30 lines)
function extractMangaInfo($card) {
  const $vertical = $card.children("div").first();
  if (!$vertical.length) return null;

  const title = normalizeText($vertical.find("h1").first().text());
  if (!title) return null;

  return {
    title,
    mangaUrl: getMangaUrl($vertical),
    cover: getCover($vertical),
    rating: getRating($vertical),
    status: extractStatus($vertical),
    $vertical,
  };
}

// Helper: Check if chapter is fresh
function isChapterFresh(parsedUpdated) {
  const diffHours = (Date.now() - parsedUpdated.getTime()) / 3600000;
  return diffHours <= 24;
}

// Helper: Parse chapter row data (split into smaller functions)
const getChapterUrl = ($link, mangaUrl) => toAbsoluteUrl($link.attr("href"));

const createChapterKey = (title, chapterText) => `${title}-${chapterText}`;

const checkAndMarkSeen = (key, seen) => {
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
};

const buildChapterResult = (mangaInfo, chapterText, url, parsedUpdated) => ({
  title: mangaInfo.title,
  chapter: chapterText,
  url,
  cover: mangaInfo.cover,
  mangaUrl: mangaInfo.mangaUrl,
  rating: mangaInfo.rating,
  status: mangaInfo.status,
  updatedTime: parsedUpdated?.toISOString() ?? null,
  source: "ikiru",
});

function parseChapterRow($link, mangaInfo, seen, now) {
  const chapterText = getChapterText($link);
  const updatedTimeRaw = getUpdatedTime($link);
  const parsedUpdated = parseUpdatedTime(updatedTimeRaw);

  // Guard clauses for invalid data
  if (!chapterText || !parsedUpdated) return null;
  if (!isChapterFresh(parsedUpdated)) return null;

  const url = getChapterUrl($link, mangaInfo.mangaUrl);
  if (!url) return null;

  const key = createChapterKey(mangaInfo.title, chapterText);
  if (!checkAndMarkSeen(key, seen)) return null;

  return buildChapterResult(mangaInfo, chapterText, url, parsedUpdated);
}

// Main parse function - optimized with modern array methods
function parsePage($, seen) {
  const now = Date.now();
  const $cards = $("#search-results").children();

  const results = $cards
    .map((_, card) => {
      const mangaInfo = extractMangaInfo($(card));
      if (!isValidMangaInfo(mangaInfo)) return [];

      return mangaInfo.$vertical
        .find("a[href*='/chapter-']")
        .map((_, el) => parseChapterRow($(el), mangaInfo, seen, now))
        .get()
        .filter(Boolean);
    })
    .get()
    .flat();

  return {
    results,
    foundFresh: results.length > 0,
    foundOlderThan24h: results.length === 0,
    foundFreshWithin24h: results.length > 0,
  };
}

// ============ MODE 2: OPTIMIZED LOGIC - Maps/Sets & Memoization ============

// DO NOT memoize cheerio objects - they prevent garbage collection and cause memory leaks
// Only memoize extracted data, not the cheerio instance
// Removed: memoizedCollectFromMangaPage - this was storing cheerio objects in memory

// Extract title with fallbacks
const extractTitleFromPage = ($, baseItem) =>
  normalizeText(baseItem?.title) ||
  normalizeText($("h1").first().text()) ||
  normalizeText($(".entry-title, .post-title, .series-title").first().text());

// Extract cover with fallbacks
const extractCoverFromPage = ($, baseItem) =>
  baseItem?.cover ??
  cleanImageUrl(
    toAbsoluteUrl(
      $(".summary_image img, .thumb img, img.wp-post-image")
        .first()
        .attr("src"),
    ),
  );

// Extract rating with fallbacks
const extractRatingFromPage = ($, baseItem) =>
  baseItem?.rating ??
  (normalizeText($(".numscore, .rating-prc .num").first().text()) || "N/A");

// Extract status with fallbacks
const extractStatusFromPage = ($, baseItem) =>
  baseItem?.status ??
  (normalizeText(
    $("p.font-normal.text-xs, .tsinfo .imptdt i")
      .filter(
        (_, el) =>
          el && el.textContent && VALID_STATUSES.has(el.textContent.trim()),
      )
      .first()
      .text(),
  ) ||
    "Unknown");

// Chapter selectors (DRY pattern) - Updated for new ikiru layout
const CHAPTER_ROW_SELECTORS = [
  "li:has(a[href*='/chapter-'])",
  ".eplister li",
  ".clstyle li",
  ".chapters li",
  "div[data-chapter-number]", // New ikiru layout
  "#chapter-list > div", // Alternative container
  "#tabpanel-chapters div[data-chapter-number]", // Tab panel chapters
].join(", ");

// Extract chapter data from row (handles both old and new ikiru layouts)
const extractChapterDataFromRow = ($row) => {
  const link = $row.find("a[href*='/chapter-']").first();
  const href = link.attr("href");

  // Chapter text - try multiple selectors
  const chapterText =
    normalizeText($row.find("a[href*='/chapter-'] span").first().text()) || // New layout
    normalizeText($row.find("a[href*='/chapter-'] p").first().text()) ||
    normalizeText(link.text()) ||
    normalizeText($row.find("[class*='chapter']").first().text());

  // Updated time - try time element first (new layout), then fallbacks
  const timeEl = $row.find("time").first();
  let rawUpdated = timeEl.attr("datetime") || timeEl.text();

  if (!rawUpdated) {
    rawUpdated =
      getUpdatedTime($row) ||
      $row
        .find(".text-gray-500, .text-xs, .date, .chapter-date, .chapterdate")
        .first()
        .text()
        .trim();
  }

  return { href, chapterText, rawUpdated };
};

// Build chapter result object
const buildMangaPageChapterResult = (
  title,
  chapterText,
  chapterUrl,
  cover,
  fallbackMangaUrl,
  rating,
  status,
  parsedUpdated,
) => ({
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

export function collectIkiruRecentChaptersFromMangaPage(
  $,
  mangaUrl,
  baseItem = {},
  seen = null,
) {
  const results = [];

  const title = extractTitleFromPage($, baseItem);
  const cover = extractCoverFromPage($, baseItem);
  const rating = extractRatingFromPage($, baseItem);
  const status = extractStatusFromPage($, baseItem);
  const fallbackMangaUrl = toAbsoluteUrl(mangaUrl);
  const seenKeys = seen instanceof Set ? seen : new Set();

  $(CHAPTER_ROW_SELECTORS).each((_, el) => {
    const $row = $(el);
    const { href, chapterText, rawUpdated } = extractChapterDataFromRow($row);

    const chapterUrl = resolveChapterUrl(href, fallbackMangaUrl);
    const parsedUpdated = parseUpdatedTime(rawUpdated);

    // Guard clauses
    if (!chapterUrl || !chapterText || !parsedUpdated) return;
    if (!isChapterWithin24h(parsedUpdated)) return;

    const key = createChapterKey(title, chapterText);
    if (!checkAndMarkSeen(key, seenKeys)) return;

    results.push(
      buildMangaPageChapterResult(
        title,
        chapterText,
        chapterUrl,
        cover,
        fallbackMangaUrl,
        rating,
        status,
        parsedUpdated,
      ),
    );
  });

  return results;
}

// Extract manga ID from page
const extractIkiruMangaId = ($) => {
  const rawHxGet =
    $("#chapter-list").attr("hx-get") ||
    $("[hx-get*='action=chapter_list']").first().attr("hx-get") ||
    "";
  const match = String(rawHxGet).match(/manga_id=(\d+)/i);
  return match?.[1] ?? null;
};

// AJAX chapter selectors
const AJAX_CHAPTER_SELECTORS =
  "#chapter-list > div[data-chapter-number], #chapter-list .flex[data-chapter-number]";

// Extract chapter data from AJAX row
const extractAjaxChapterData = ($row) => {
  const href = $row.find("a[href*='/chapter-']").first().attr("href");
  const chapterText = normalizeText($row.find("span").first().text());
  const rawUpdated = getUpdatedTime($row);

  return { href, chapterText, rawUpdated };
};

// Build AJAX chapter result
const buildAjaxChapterResult = (
  title,
  chapterText,
  chapterUrl,
  cover,
  fallbackMangaUrl,
  rating,
  status,
  parsedUpdated,
) => ({
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

export function collectIkiruRecentChaptersFromAjaxHtml(
  html,
  mangaUrl,
  baseItem = {},
  seen = null,
) {
  const $ = cheerio.load(html);
  const results = [];

  const { title, cover, rating, status } = baseItem;
  const fallbackMangaUrl = toAbsoluteUrl(mangaUrl);
  const seenKeys = seen instanceof Set ? seen : new Set();
  let foundOlderThan24h = false;

  $(AJAX_CHAPTER_SELECTORS).each((_, el) => {
    const $row = $(el);
    const { href, chapterText, rawUpdated } = extractAjaxChapterData($row);

    const chapterUrl = resolveChapterUrl(href, fallbackMangaUrl);
    const parsedUpdated = parseUpdatedTime(rawUpdated);

    if (!chapterUrl || !chapterText || !parsedUpdated) return;

    if (!isChapterWithin24h(parsedUpdated)) {
      foundOlderThan24h = true;
      return;
    }

    const key = createChapterKey(title, chapterText);
    if (!checkAndMarkSeen(key, seenKeys)) return;

    results.push(
      buildAjaxChapterResult(
        title,
        chapterText,
        chapterUrl,
        cover,
        fallbackMangaUrl,
        rating,
        status,
        parsedUpdated,
      ),
    );
  });

  return { results, foundOlderThan24h };
}

// ============ MODE 3: MODERN SYNTAX - Arrow Functions & Async/Await ============

// Request configuration builder (DRY pattern)
const createRequestConfig = (redis, additionalHeaders = {}) => ({
  headers: baseHeaders(redis, additionalHeaders),
  timeout: FASTCRON_SAFE_CONFIG.REQUEST_TIMEOUT,
});

// Retry configuration (DRY pattern)
const retryConfig = {
  maxAttempts: FASTCRON_SAFE_CONFIG.MAX_RETRIES,
  delay: FASTCRON_SAFE_CONFIG.RETRY_DELAY,
  backoff: 2,
};

// Safe fetch with timeout
const fetchWithTimeout = async (url, config, timeoutMsg) =>
  withTimeout(
    axios.get(url, config),
    FASTCRON_SAFE_CONFIG.REQUEST_TIMEOUT + 1000,
    timeoutMsg,
  );

const postWithTimeout = async (url, data, config, timeoutMsg) =>
  withTimeout(
    axios.post(url, data, config),
    FASTCRON_SAFE_CONFIG.REQUEST_TIMEOUT + 2000,
    timeoutMsg,
  );

// Fetch chapter list via AJAX
export async function fetchIkiruRecentChaptersFromAjax(
  mangaId,
  mangaUrl,
  redis,
  baseItem = {},
  seen = null,
  startTime = Date.now(),
) {
  if (!mangaId) return [];

  const collected = [];
  const maxPages = Math.max(1, IKIRU_CHAPTER_LIST_MAX_PAGES);

  if (isApproachingTimeout(startTime, 5000)) {
    logger.warn(
      `[fetchIkiruRecentChaptersFromAjax] Approaching timeout, skipping ${mangaUrl}`,
    );
    return collected;
  }

  const endpointBase = `${SITE_URL}${AJAX_PATH}?manga_id=${encodeURIComponent(mangaId)}`;

  for (let page = 1; page <= maxPages; page++) {
    if (isApproachingTimeout(startTime, 3000)) {
      logger.warn(
        `[fetchIkiruRecentChaptersFromAjax] Timeout approaching, stopping at page ${page}`,
      );
      break;
    }

    const endpoint = `${endpointBase}&page=${page}&action=chapter_list`;

    try {
      const config = {
        ...(await createRequestConfig(redis, { Accept: "text/html, */*" })),
        timeout: FASTCRON_SAFE_CONFIG.REQUEST_TIMEOUT,
      };

      const res = await retryAsync(
        () =>
          fetchWithTimeout(
            endpoint,
            config,
            `Ajax request timeout for ${mangaUrl} page ${page}`,
          ),
        retryConfig,
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
      logger.warn(
        `[fetchIkiruRecentChaptersFromAjax] Failed for ${mangaUrl}:`,
        err.message,
      );
      break;
    }
  }

  return collected.slice(0, FASTCRON_SAFE_CONFIG.MAX_CHAPTERS_PER_RUN);
}

// Fetch chapters from manga detail page
export async function fetchIkiruRecentChaptersFromMangaPage(
  mangaUrl,
  redis,
  baseItem = {},
  seen = null,
  startTime = Date.now(),
) {
  if (!mangaUrl) return [];

  if (isApproachingTimeout(startTime, 5000)) {
    logger.warn(
      `[fetchIkiruRecentChaptersFromMangaPage] Timeout approaching, skipping ${mangaUrl}`,
    );
    return [];
  }

  try {
    const headers = await baseHeaders(redis);
    const res = await retryAsync(
      () =>
        fetchWithTimeout(
          mangaUrl,
          { headers, timeout: FASTCRON_SAFE_CONFIG.REQUEST_TIMEOUT },
          `Manga page request timeout for ${mangaUrl}`,
        ),
      retryConfig,
    );

    const $ = cheerio.load(res.data);
    const mangaId = extractIkiruMangaId($);

    if (isApproachingTimeout(startTime, 8000)) {
      logger.warn(
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
      startTime,
    );

    return ajaxResults.length
      ? ajaxResults
      : collectIkiruRecentChaptersFromMangaPage($, mangaUrl, baseItem, seen);
  } catch (err) {
    logger.warn(
      `[fetchIkiruRecentChaptersFromMangaPage] Failed for ${mangaUrl}:`,
      err.message,
    );
    return [];
  }
}

// ============ EXPANSION LOGIC - Optimized with Generators & Maps ============

// Create candidate filter predicate
const createCandidateFilter = (preferredTitleKeys) => (item) => {
  if (normalizeSource(item?.source) !== "ikiru") return false;
  if (!shouldPrioritizeSecondaryTitle(item?.title, preferredTitleKeys))
    return false;
  return true;
};

// Collect candidates with deduplication
const collectCandidates = (items, filterFn, limit = 1000) => {
  const candidates = [];
  const candidateKeys = new Set();

  const generator = lazyFilterMap(
    items,
    (item) => {
      if (!filterFn(item)) return false;
      const candidateKey = normalizeSourceUrl(
        item?.mangaUrl || item?.url || "",
      );
      if (!candidateKey || candidateKeys.has(candidateKey)) return false;
      candidateKeys.add(candidateKey);
      return true;
    },
    (item) => item,
  );

  for (const candidate of generator) {
    candidates.push(candidate);
    if (candidates.length >= limit) break;
  }

  return { candidates, candidateKeys };
};

// Build seen set from existing items
const buildSeenSet = (items, candidateKeySet) =>
  new Set(
    items
      .filter(
        (item) =>
          !candidateKeySet.has(
            normalizeSourceUrl(item?.mangaUrl || item?.url || ""),
          ),
      )
      .map(
        (item) =>
          `${String(item?.title ?? "").trim()}-${String(item?.chapter ?? "").trim()}`,
      ),
  );

// Process candidate batch
const processCandidateBatch = async (
  batch,
  redis,
  seen,
  replacementMap,
  limit,
) => {
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
};

// Merge expanded results with original items
const mergeExpandedResults = (items, replacementMap) => {
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
};

export async function expandIkiruUpdatesFromDetailPages(
  items = [],
  redis = null,
  preferredTitleKeys = null,
  startTime = Date.now(),
) {
  if (!(preferredTitleKeys instanceof Set) || preferredTitleKeys.size === 0) {
    return items;
  }

  if (isApproachingTimeout(startTime, 10000)) {
    logger.warn(
      "[expandIkiruUpdatesFromDetailPages] Timeout approaching, skipping expansion",
    );
    return items;
  }

  const filterFn = createCandidateFilter(preferredTitleKeys);
  const { candidates } = collectCandidates(items, filterFn);

  if (!candidates.length) return items;

  const candidateKeySet = new Set(
    candidates.map((item) =>
      normalizeSourceUrl(item?.mangaUrl || item?.url || ""),
    ),
  );

  const seen = buildSeenSet(items, candidateKeySet);
  const replacementMap = new Map();
  const limit = pLimit(5);

  for (const batch of chunked(candidates, 20)) {
    await processCandidateBatch(batch, redis, seen, replacementMap, limit);
    await new Promise((resolve) => setImmediate(resolve));
  }

  return replacementMap.size
    ? mergeExpandedResults(items, replacementMap)
    : items;
}

// ============ DATE EXTRACTION - Modular & Reusable ============

// Meta tag date extraction
const META_DATE_SELECTORS = [
  "time[itemprop='dateModified']",
  "meta[property='article:modified_time']",
  "meta[property='og:updated_time']",
];

const extractDateFromMetaTags = ($) => {
  const rawModified = META_DATE_SELECTORS.map(
    (selector) =>
      $(selector).first().attr("datetime") ||
      $(selector).first().attr("content"),
  ).find(Boolean);

  return parseDateWithFallback(rawModified);
};

// Chapter row date extraction
const CHAPTER_DATE_SELECTORS = [
  "time[datetime]",
  "time",
  ".text-gray-500",
  ".text-xs",
  ".date",
  ".chapter-date",
  ".chapterdate",
];

const extractDateFromChapterRow = ($row) => {
  const raw = CHAPTER_DATE_SELECTORS.map(
    (selector) =>
      $row.find(selector).first()?.attr("datetime") ||
      $row.find(selector).first().text().trim(),
  ).find(Boolean);

  return parseDateWithFallback(raw);
};

const extractDatesFromChapterRows = ($) => {
  const selectors =
    "li:has(a[href*='/chapter-']), .eplister li, .clstyle li, .chapters li";

  return $(selectors)
    .map((_, el) => extractDateFromChapterRow($(el)))
    .get()
    .filter(isValidDate);
};

// Last updates label extraction
const LAST_UPDATES_TEXT = "last updates";

const extractDateFromLastUpdatesLabel = ($) => {
  const $element = $("h4, p, span")
    .filter((_, el) =>
      $(el).text().trim().toLowerCase().includes(LAST_UPDATES_TEXT),
    )
    .first();

  if (!$element.length) return null;

  const row = $element.closest("div");
  const lastUpdatesRaw =
    row.find("p").last().text().trim() ||
    row.siblings("div").first().find("p").first().text().trim();

  return lastUpdatesRaw ? parseDateWithFallback(lastUpdatesRaw) : null;
};

// Latest chapter date extraction
const extractDateFromChapterPage = ($$) => {
  const chapterRaw =
    $$("time[datetime]").first().attr("datetime") ||
    $$("time").first().text().trim();

  return parseDateWithFallback(chapterRaw);
};

export async function extractDateFromLatestChapter(mangaUrl, $, redis) {
  const latestChapterLink = $("a[href*='/chapter-']").first().attr("href");
  if (!latestChapterLink) return null;

  try {
    const chapterUrl = resolveChapterUrl(latestChapterLink, mangaUrl);
    const headers = await baseHeaders(redis);

    const chapterRes = await retryAsync(
      () =>
        fetchWithTimeout(
          chapterUrl,
          { headers, timeout: FASTCRON_SAFE_CONFIG.REQUEST_TIMEOUT },
          `Chapter detail timeout for ${chapterUrl}`,
        ),
      retryConfig,
    );

    const $$ = cheerio.load(chapterRes.data);
    return extractDateFromChapterPage($$);
  } catch {
    return null;
  }
}

// Fetch latest update time with caching
export async function fetchLatestMangaUpdateTime(mangaUrl, redis = null) {
  if (!mangaUrl) return null;

  const cacheKey = `lastupd:${mangaUrl}`;
  return getCachedOrFetch(
    redis,
    cacheKey,
    () => fetchLatestUpdateFromSource(mangaUrl, redis),
    300,
    "fetchLatestMangaUpdateTime",
  );
}

// Date extraction strategies in priority order
const createDateExtractionStrategies = ($, mangaUrl, redis) => [
  { name: "metaTags", fn: () => extractDateFromMetaTags($) },
  {
    name: "chapterRows",
    fn: () => {
      const dates = extractDatesFromChapterRows($);
      return dates.sort((a, b) => b.getTime() - a.getTime())[0];
    },
  },
  { name: "lastUpdatesLabel", fn: () => extractDateFromLastUpdatesLabel($) },
  {
    name: "latestChapter",
    fn: () => extractDateFromLatestChapter(mangaUrl, $, redis),
  },
];

async function fetchLatestUpdateFromSource(mangaUrl, redis) {
  const res = await scrapeWithHeaders(mangaUrl, redis, { timeout: 6000 });
  const $ = cheerio.load(res.data);

  const strategies = createDateExtractionStrategies($, mangaUrl, redis);

  for (const { name, fn } of strategies) {
    const date = name === "latestChapter" ? await fn() : fn();
    if (isValidDate(date)) return date;
  }

  return null;
}

// ============ SCRAPING LOGIC - Clean & Optimized ============

export const shouldBreakIkiruLatestScan = ({
  emptyPageStreak = 0,
  stalePageStreak = 0,
} = {}) =>
  emptyPageStreak >= IKIRU_EMPTY_PAGE_BREAK_STREAK || stalePageStreak >= 2;

// Build page URL list
const buildPageUrls = (maxPages, baseUrl) =>
  Array.from({ length: maxPages }, (_, i) => ({
    page: i + 1,
    url: i === 0 ? baseUrl : `${baseUrl}?the_page=${i + 1}`,
  }));

// Process single page with caching
const processSinglePage = async (
  { page, url },
  redis,
  seen,
  startTime,
  logger,
) => {
  if (isApproachingTimeout(startTime, 3000)) {
    logger?.warn({ page }, "Timeout approaching, skipping page fetch");
    return { page, success: false, error: new Error("Timeout approaching") };
  }

  // Cache key: Fixed key per page, TTL is managed by Redis expiration (not in key name)
  // This prevents cache key explosion (7200+ keys/day issue)
  const cacheKey = `ikiru:latest:page:${page}`;

  // Try cache first
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        logger?.info({ page }, "ikiru latest page cache hit");
        return { page, success: true, data: cached, cached: true };
      }
    } catch (err) {
      logger?.warn({ page, error: err.message }, "Cache read failed");
    }
  }

  try {
    const headers = await baseHeaders(redis);
    const res = await retryAsync(
      () =>
        fetchWithTimeout(
          url,
          { headers, timeout: FASTCRON_SAFE_CONFIG.REQUEST_TIMEOUT },
          `Page fetch timeout for page ${page}`,
        ),
      retryConfig,
    );

    // Cache the response with 60s TTL (fixed key, not time-based)
    // This prevents cache key explosion while still providing freshness
    if (redis) {
      redis.set(cacheKey, res.data, { ex: 60 }).catch((err) => {
        logger?.warn({ page, error: err.message }, "Cache write failed");
      });
    }

    return { page, success: true, data: res.data, cached: false };
  } catch (err) {
    logger?.warn({ page, err: err.message }, "ikiru latest page fetch failed");
    return { page, success: false, error: err };
  }
};

// Check early termination conditions
// pageResults is the full object returned by parsePage: { results, foundFresh, foundOlderThan24h, foundFreshWithin24h }
const shouldTerminateEarly = (resp, pageResults, logger) => {
  const results = pageResults?.results || [];

  // No chapters on first page
  if (resp.page === 1 && results.length === 0) {
    logger?.info(
      { page: resp.page },
      "No chapters on first page, stopping early",
    );
    return true;
  }

  // Only stale chapters on first page
  if (
    resp.page === 1 &&
    results.length > 0 &&
    !pageResults?.foundFreshWithin24h &&
    pageResults?.foundOlderThan24h
  ) {
    logger?.info(
      { page: resp.page, count: results.length },
      "Only stale chapters on first page, stopping early",
    );
    return true;
  }

  return false;
};

// Build metrics object
const buildMetrics = (
  pagesScanned,
  stalePageStreak,
  emptyPageStreak,
  skipExpansion,
  ikiruResults,
  expandedResults,
  preferredIkiruTitleKeys,
) => ({
  pagesScanned,
  stalePageStreak,
  emptyPageStreak,
  maxPages: Math.max(1, IKIRU_LATEST_MAX_PAGES),
  preferredTitles: preferredIkiruTitleKeys?.size ?? 0,
  expandedCount: skipExpansion
    ? 0
    : Math.max(0, expandedResults.length - ikiruResults.length),
  expansionSkipped: !!skipExpansion,
});

// Build final state
const buildFinalState = (
  ikiruPageError,
  expandedResults,
  sourceState,
  metrics,
) => ({
  ...sourceState,
  status: ikiruPageError && expandedResults.length === 0 ? "error" : "ok",
  count: expandedResults.length,
  error:
    ikiruPageError && expandedResults.length === 0
      ? ikiruPageError.message
      : null,
  metrics,
});

export async function scrapeIkiruUpdatesWithMeta(
  redis = null,
  preferredIkiruTitleKeys = new Set(),
  logger = null,
  { skipExpansion = false } = {},
) {
  const startTime = Date.now();

  const sourceState = {
    status: "pending",
    count: 0,
    error: null,
    metrics: null,
  };

  let ikiruPageError = null;
  const seen = new Set();
  let pagesScanned = 0;

  const maxPages = Math.max(1, IKIRU_LATEST_MAX_PAGES);
  const pageUrls = buildPageUrls(maxPages, LATEST_URL);

  if (isApproachingTimeout(startTime, 5000)) {
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

  const pageResponses = await batchAsync(
    pageUrls,
    (pageData) =>
      processSinglePage(pageData, redis, seen, startTime, logger),
    FASTCRON_SAFE_CONFIG.BATCH_SIZE,
  );

  const rawResults = [];
  let emptyPageStreak = 0;
  let stalePageStreak = 0;

  for (const resp of pageResponses) {
    if (!resp.success) {
      ikiruPageError ??= resp.error;
      continue;
    }

    pagesScanned = Math.max(pagesScanned, resp.page);

    const $ = cheerio.load(resp.data);
    const pageResults = parsePage($, seen);

    rawResults.push(...pageResults.results);

    logger?.info(
      { page: resp.page, count: pageResults.results.length },
      "ikiru latest page parsed",
    );

    if (shouldTerminateEarly(resp, pageResults, logger)) break;

    emptyPageStreak =
      pageResults.results.length === 0 ? emptyPageStreak + 1 : 0;
    stalePageStreak =
      !pageResults.foundFreshWithin24h && pageResults.foundOlderThan24h
        ? stalePageStreak + 1
        : 0;

    if (stalePageStreak >= 2) {
      logger?.info(
        { page: resp.page, stalePageStreak },
        "2 consecutive pages without fresh content, stopping early",
      );
      break;
    }
  }

  const ikiruResults = rawResults;

  // Expansion phase
  let expandedResults = ikiruResults;
  if (!skipExpansion && !isApproachingTimeout(startTime, 8000)) {
    expandedResults = await expandIkiruUpdatesFromDetailPages(
      ikiruResults,
      redis,
      preferredIkiruTitleKeys,
      startTime,
    );
  } else if (!skipExpansion) {
    logger?.warn("Skipping expansion due to timeout approaching");
  }

  const metrics = buildMetrics(
    pagesScanned,
    stalePageStreak,
    emptyPageStreak,
    skipExpansion,
    ikiruResults,
    expandedResults,
    preferredIkiruTitleKeys,
  );
  const finalState = buildFinalState(
    ikiruPageError,
    expandedResults,
    sourceState,
    metrics,
  );

  return { results: expandedResults, state: finalState };
}

// ============ RANDOM MANGA - Clean & Modern ============

// ============ SEARCH - Manga Search for Ikiru ============

export async function searchIkiru(query, options = {}, redis = null) {
  const keyword = String(query ?? "")
    .trim()
    .toLowerCase();
  if (!keyword) return [];

  const searchUrl = `${SITE_URL}?s=${encodeURIComponent(keyword)}&post_type=wp-manga`;
  const seen = new Set();
  const results = [];

  try {
    const res = await scrapeWithHeaders(searchUrl, redis, { timeout: 10000 });
    const $ = cheerio.load(res.data);

    // Find all manga cards in search results
    const $cards = $(
      ".c-tabs-item, .manga-item, .page-item-detail, #search-results .row .col-6",
    );

    $cards.each((_, card) => {
      const $card = $(card);

      // Extract title
      const title = normalizeText(
        $card
          .find(".post-title h3, .post-title h4, .entry-title, h3 a, h4 a")
          .first()
          .text(),
      );
      if (!title) return;

      // Extract manga URL
      const mangaUrl = toAbsoluteUrl(
        $card.find("a[href*='/manga/']").first().attr("href"),
      );
      if (!mangaUrl) return;

      // Check for duplicates
      const key = mangaUrl.toLowerCase().replace(/\/+$/, "");
      if (seen.has(key)) return;
      seen.add(key);

      // Extract cover image
      const cover = cleanImageUrl(
        toAbsoluteUrl(
          $card.find("img").first().attr("src") ||
            $card.find("img").first().attr("data-src"),
        ),
      );

      // Extract rating if available
      const rating =
        normalizeText(
          $card.find(".score, .rating, .numscore").first().text(),
        ) || "N/A";

      // Extract status if available
      const statusText = $card
        .find(".manga-status, .status, .post-status")
        .text()
        .toLowerCase();
      let status = "Unknown";
      if (statusText.includes("ongoing")) status = "Ongoing";
      else if (statusText.includes("completed")) status = "Completed";
      else if (statusText.includes("hiatus")) status = "Hiatus";

      results.push({
        title,
        mangaUrl,
        url: mangaUrl,
        cover,
        rating,
        status,
        source: "ikiru",
      });
    });

    return results.slice(0, 50);
  } catch (err) {
    logger.error("[searchIkiru] Error:", err.message);
    return [];
  }
}

// Fetch recent chapters (<24h) from manga detail page via AJAX endpoint
// Used when new manga is added to immediately notify of latest chapters
export async function fetchRecentChaptersFromMangaPage(mangaUrl, redis = null) {
  if (!mangaUrl) return [];

  try {
    // Step 1: Fetch manga page to get hx-get URL or manga_id
    const res = await scrapeWithHeaders(mangaUrl, redis, { timeout: 6000 });
    const $ = cheerio.load(res.data);

    // Extract title
    const title = extractTitleFromPage($, {});

    // Step 2: Get AJAX endpoint from hx-get attribute
    const hxGet = $("#chapter-list").attr("hx-get");

    let chapterHtml = "";

    if (hxGet) {
      // Step 3: Fetch chapter list from AJAX endpoint
      const ajaxRes = await scrapeWithHeaders(hxGet, redis, { timeout: 6000 });
      chapterHtml = ajaxRes.data;
    } else {
      // Fallback: use the page HTML directly (old layout)
      chapterHtml = res.data;
    }

    // Step 4: Parse chapters from HTML
    const $chapters = cheerio.load(chapterHtml);
    const baseItem = { title };
    const chapters = collectIkiruRecentChaptersFromMangaPage($chapters, mangaUrl, baseItem, new Set());

    return chapters;
  } catch (err) {
    logger.error("[fetchRecentChaptersFromMangaPage] Error:", err.message);
    return [];
  }
}
