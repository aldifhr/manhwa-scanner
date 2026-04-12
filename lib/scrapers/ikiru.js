import axios from "axios";
import pLimit from "p-limit";
import * as cheerio from "cheerio";
import { retryAsync, withTimeout } from "../utils.js";
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
  resolveChapterUrl,
  scrapeWithHeaders,
  shouldPrioritizeSecondaryTitle,
  toAbsoluteUrl,
  lazyFilterMap,
  chunked,
} from "./shared.js";
import {
  getCachedOrFetch,
  isValidDate,
  parseDateWithFallback,
  safeParseDate,
} from "../dateUtils.js";
import { IKIRU_CONFIG } from "../config.js";

const logger = getLogger({ scope: "ikiru" });

// FastCron-safe configuration - balanced for reliability and speed
// Timeout values can be overridden via environment variables
const FASTCRON_SAFE_CONFIG = IKIRU_CONFIG;

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
const STATUS_KEYWORDS = [
  { keyword: "ongoing", status: "Ongoing" },
  { keyword: "updating", status: "Ongoing" },
  { keyword: "completed", status: "Completed" },
  { keyword: "complete", status: "Completed" },
  { keyword: "hiatus", status: "Hiatus" },
  { keyword: "dropped", status: "Hiatus" },
];

function normalizeStatusText(raw) {
  const text = normalizeText(raw).toLowerCase();
  if (!text) return null;
  const matched = STATUS_KEYWORDS.find(({ keyword }) => text.includes(keyword));
  return matched?.status || null;
}

const findStatusElement = ($vertical) =>
  $vertical
    .find(
      "p.font-normal.text-xs, .text-sm.text-text.line-clamp-1, .line-clamp-1, .status, .manga-status, .post-status",
    )
    .filter((_, el) => {
      const text = normalizeText($vertical.find(el).text());
      return Boolean(normalizeStatusText(text));
    })
    .first();

const extractStatusFromElement = ($element) => {
  const rawStatus = $element?.text().trim() ?? "";
  return normalizeStatusText(rawStatus) || "Unknown";
};

const extractStatus = ($vertical) => {
  const direct = extractStatusFromElement(findStatusElement($vertical));
  if (direct !== "Unknown") return direct;

  // Fallback: scan compact text chunks inside card for known status keywords.
  const fallbackText = normalizeText(
    $vertical.find("p, span, div").map((_, el) => $vertical.find(el).text()).get().join(" "),
  );
  return normalizeStatusText(fallbackText) || "Unknown";
};

// Helper: Get chapter text from link
const getChapterText = ($link) =>
  normalizeText($link.find("p").first().text()) || normalizeText($link.text());

// Helper: Get updated time from element
const getUpdatedTime = ($element) =>
  $element.find("time[datetime]").first()?.attr("datetime") ||
  $element.find("time").first().text().trim();

const parseUpdatedTime = (rawTime) =>
  safeParseDate(rawTime) || parseLooseRelativeTime(rawTime);

// Helper: Get manga URL from card
const getMangaUrl = ($vertical) =>
  toAbsoluteUrl($vertical.find("a[href*='/manga/']").first().attr("href"));

// Helper: Get cover from card
const getCover = ($vertical) =>
  cleanImageUrl(toAbsoluteUrl($vertical.find("img").first().attr("src")));

// Helper: Get rating from card
const getRating = ($vertical) =>
  normalizeText($vertical.find(".numscore, .score, .rating").first().text()) ||
  "N/A";

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

// Helper: Parse chapter row data (split into smaller functions)
const getChapterUrl = ($link, mangaUrl) =>
  resolveChapterUrl($link.attr("href"), mangaUrl);

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

function parseChapterRow($link, mangaInfo, seen) {
  const chapterText = getChapterText($link);
  const updatedTimeRaw = getUpdatedTime($link);
  const parsedUpdated = parseUpdatedTime(updatedTimeRaw);

  // Guard clauses for invalid data
  if (!chapterText || !parsedUpdated) {
    return { result: null, foundOlderThan24h: false };
  }
  if (!isChapterWithin24h(parsedUpdated)) {
    return { result: null, foundOlderThan24h: true };
  }

  const url = getChapterUrl($link, mangaInfo.mangaUrl);
  if (!url) return { result: null, foundOlderThan24h: false };

  const key = createChapterKey(mangaInfo.title, chapterText);
  if (!checkAndMarkSeen(key, seen)) {
    return { result: null, foundOlderThan24h: false };
  }

  return {
    result: buildChapterResult(mangaInfo, chapterText, url, parsedUpdated),
    foundOlderThan24h: false,
  };
}

// Main parse function - optimized with modern array methods
function parsePage($, seen) {
  const $cards = $("#search-results").children();
  let foundOlderThan24h = false;

  const results = $cards
    .map((_, card) => {
      const mangaInfo = extractMangaInfo($(card));
      if (!isValidMangaInfo(mangaInfo)) return [];

      return mangaInfo.$vertical
        .find("a[href*='/chapter-']")
        .map((_, el) => {
          const parsed = parseChapterRow($(el), mangaInfo, seen);
          if (parsed.foundOlderThan24h) foundOlderThan24h = true;
          return parsed.result;
        })
        .get()
        .filter(Boolean);
    })
    .get()
    .flat();

  return {
    results,
    foundFresh: results.length > 0,
    foundOlderThan24h,
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
const extractRatingFromPage = ($, baseItem) => {
  const baseRating = normalizeText(baseItem?.rating);
  if (baseRating && baseRating.toUpperCase() !== "N/A") return baseRating;

  return (
    normalizeText($(".numscore, .rating-prc .num, .score, .rating").first().text()) ||
    normalizeText($("[itemprop='ratingValue']").first().attr("content")) ||
    normalizeText($(".font-bold.bg-gradient-to-br").first().text()) ||
    "N/A"
  );
};

// Extract status with fallbacks
const extractStatusFromPage = ($, baseItem) => {
  const baseStatus = normalizeStatusText(baseItem?.status);
  if (baseStatus && baseStatus !== "Unknown") return baseStatus;

  const rawStatus = normalizeText(
    $("p.font-normal.text-xs, .tsinfo .imptdt i, .text-sm.text-text.line-clamp-1, .line-clamp-1")
      .first()
      .text(),
  );

  return normalizeStatusText(rawStatus) || "Unknown";
};

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
  const seenElements = new Set();

  $(CHAPTER_ROW_SELECTORS).each((_, el) => {
    if (seenElements.has(el)) return;
    seenElements.add(el);

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
      buildChapterResult(
        {
          title,
          cover,
          mangaUrl: fallbackMangaUrl,
          rating,
          status,
        },
        chapterText,
        chapterUrl,
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
  const chapterText =
    normalizeText($row.find("span").first().text()) ||
    normalizeText($row.find("p").first().text()) ||
    normalizeText($row.find("a[href*='/chapter-']").first().text()) ||
    normalizeText($row.text());
  const rawUpdated = getUpdatedTime($row);

  return { href, chapterText, rawUpdated };
};

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
      buildChapterResult(
        {
          title,
          cover,
          mangaUrl: fallbackMangaUrl,
          rating,
          status,
        },
        chapterText,
        chapterUrl,
        parsedUpdated,
      ),
    );
  });

  return { results, foundOlderThan24h };
}

// ============ MODE 3: MODERN SYNTAX - Arrow Functions & Async/Await ============

// Request configuration builder (DRY pattern)
const createRequestConfig = async (redis, additionalHeaders = {}) => ({
  headers: await baseHeaders(redis, additionalHeaders),
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
  const config = await createRequestConfig(redis, {
    Accept: "text/html, */*",
  });

  for (let page = 1; page <= maxPages; page++) {
    if (isApproachingTimeout(startTime, 3000)) {
      logger.warn(
        `[fetchIkiruRecentChaptersFromAjax] Timeout approaching, stopping at page ${page}`,
      );
      break;
    }

    const endpoint = `${endpointBase}&page=${page}&action=chapter_list`;

    try {
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
const buildSeenSet = (items, excludedMangaKeys = new Set()) =>
  new Set(
    items
      .filter(
        (item) =>
          !excludedMangaKeys.has(
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
  replacementMap,
  limit,
  startTime,
) => {
  await Promise.all(
    batch.map((item) =>
      limit(async () => {
        const expanded = await fetchIkiruRecentChaptersFromMangaPage(
          item.mangaUrl || item.url,
          redis,
          item,
          null,
          startTime,
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
  const replacedMangaKeys = new Set(replacementMap.keys());
  const seenChapterKeys = buildSeenSet(items, replacedMangaKeys);

  for (const item of items) {
    const key = normalizeSourceUrl(item?.mangaUrl || item?.url || "");
    if (replacementMap.has(key)) {
      if (injected.has(key)) continue;
      const dedupedExpanded = replacementMap.get(key).filter((expandedItem) => {
        const chapterKey = `${String(expandedItem?.title ?? "").trim()}-${String(expandedItem?.chapter ?? "").trim()}`;
        if (seenChapterKeys.has(chapterKey)) return false;
        seenChapterKeys.add(chapterKey);
        return true;
      });
      merged.push(...dedupedExpanded);
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

  if (isApproachingTimeout(startTime, 25000)) {
    logger.warn(
      "[expandIkiruUpdatesFromDetailPages] Timeout approaching, skipping expansion",
    );
    return items;
  }

  const filterFn = createCandidateFilter(preferredTitleKeys);
  const { candidates } = collectCandidates(items, filterFn);

  if (!candidates.length) return items;

  const replacementMap = new Map();
  const limit = pLimit(5);

  for (const batch of chunked(candidates, 20)) {
    await processCandidateBatch(batch, redis, replacementMap, limit, startTime);
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

  for (const { fn } of strategies) {
    const date = await fn();
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
  requestHeaders,
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
    const res = await retryAsync(
      () =>
        fetchWithTimeout(
          url,
          {
            headers: requestHeaders,
            timeout: FASTCRON_SAFE_CONFIG.REQUEST_TIMEOUT,
          },
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
// pageResults is the object returned by parsePage: { results, foundFresh, foundOlderThan24h }
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

  // Only stale chapters on first page.
  if (resp.page === 1 && !pageResults?.foundFresh && pageResults?.foundOlderThan24h) {
    logger?.info(
      { page: resp.page },
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
  const seenChapterKeys = new Set();
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

  const latestPageHeaders = await baseHeaders(redis);

  const rawResults = [];
  let emptyPageStreak = 0;
  let stalePageStreak = 0;

  for (const pageData of pageUrls) {
    const resp = await processSinglePage(
      pageData,
      redis,
      latestPageHeaders,
      startTime,
      logger,
    );
    if (!resp.success) {
      ikiruPageError ??= resp.error;
      continue;
    }

    pagesScanned = Math.max(pagesScanned, resp.page);

    const $ = cheerio.load(resp.data);
    const pageResults = parsePage($, seenChapterKeys);

    rawResults.push(...pageResults.results);

    logger?.info(
      { page: resp.page, count: pageResults.results.length },
      "ikiru latest page parsed",
    );

    if (shouldTerminateEarly(resp, pageResults, logger)) break;

    emptyPageStreak =
      pageResults.results.length === 0 ? emptyPageStreak + 1 : 0;
    stalePageStreak =
      pageResults.foundOlderThan24h && !pageResults.foundFresh
        ? stalePageStreak + 1
        : 0;

    if (shouldBreakIkiruLatestScan({ emptyPageStreak, stalePageStreak })) {
      logger?.info(
        { page: resp.page, stalePageStreak, emptyPageStreak },
        "Stopping early due to empty/stale page streak",
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

// ============ SEARCH - Manga Search for Ikiru ============

export async function searchIkiru(query, _options = {}, redis = null) {
  const keyword = String(query ?? "")
    .trim()
    .toLowerCase();
  if (!keyword) return [];

  // Updated search URL format (ikiru changed their search endpoint)
  const searchUrl = `${SITE_URL}advanced-search/?search_term=${encodeURIComponent(keyword)}`;
  const seen = new Set();
  const results = [];

  try {
    // Increase timeout to 20s and add retry for slow search
    const res = await scrapeWithHeaders(searchUrl, redis, { timeout: 20000, retries: 2 });
    logger.info({ searchUrl, status: res.status, dataLength: res.data?.length }, "[searchIkiru] Response received");
    const $ = cheerio.load(res.data);

    const inferTitleFromMangaUrl = (url = "") => {
      const raw = String(url || "");
      const match = raw.match(/\/manga\/([^/?#]+)/i);
      if (!match?.[1]) return "";
      return match[1]
        .replace(/[-_]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .split(" ")
        .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ""))
        .join(" ");
    };

    const sanitizeFoundTitle = (rawTitle = "", mangaUrl = "") => {
      const normalized = normalizeText(rawTitle);
      if (!normalized) return inferTitleFromMangaUrl(mangaUrl);

      // Some HTMX responses include title + synopsis in one anchor text.
      // Keep only a sane title-length segment; fallback to URL slug when too noisy.
      if (normalized.length > 120) {
        const inferred = inferTitleFromMangaUrl(mangaUrl);
        return inferred || normalized.slice(0, 120).trim();
      }

      return normalized;
    };

    const pushResult = (input = {}) => {
      const mangaUrl = toAbsoluteUrl(input.mangaUrl);
      if (!mangaUrl) return;
      // Ignore chapter links when scanning fallback anchors.
      if (/\/chapter[-./]/i.test(mangaUrl) || /\/chapter\//i.test(mangaUrl))
        return;

      const key = mangaUrl.toLowerCase().replace(/\/+$/, "");
      if (seen.has(key)) return;

      const title = sanitizeFoundTitle(input.title, mangaUrl);
      if (!title) return;

      seen.add(key);
      results.push({
        title,
        mangaUrl,
        url: mangaUrl,
        cover: cleanImageUrl(toAbsoluteUrl(input.cover || "")) || null,
        rating: normalizeText(input.rating) || "N/A",
        status: input.status || "Unknown",
        source: "ikiru",
      });
    };

    // Find all manga cards in search results
    const $cards = $(
      ".c-tabs-item, .manga-item, .page-item-detail, #search-results .row .col-6",
    );
    logger.info({ cardCount: $cards.length }, "[searchIkiru] Cards found");

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

      const mangaUrl = $card.find("a[href*='/manga/']").first().attr("href");
      const cover = toAbsoluteUrl(
        $card.find("img").first().attr("src") ||
          $card.find("img").first().attr("data-src"),
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
      if (statusText.includes("ongoing") || statusText.includes("updating")) status = "Ongoing";
      else if (statusText.includes("completed")) status = "Completed";
      else if (statusText.includes("hiatus")) status = "Hiatus";

      pushResult({
        title,
        mangaUrl,
        cover,
        rating,
        status,
      });
    });

    // Fallback parser for newer Ikiru layouts.
    if (results.length === 0) {
      const $anchors = $("a[href*='/manga/']");
      logger.info(
        { anchorCount: $anchors.length },
        "[searchIkiru] Fallback anchor parser",
      );
      $anchors.each((_, a) => {
        const $a = $(a);
        const mangaUrl = $a.attr("href");
        const $scope = $a.closest("article, li, div");
        const title =
          normalizeText($a.text()) ||
          normalizeText(
            $scope
              .find("h1, h2, h3, h4, .font-medium, .entry-title, .post-title")
              .first()
              .text(),
          );
        const cover =
          $scope.find("img").first().attr("src") ||
          $scope.find("img").first().attr("data-src") ||
          "";
        const rating = normalizeText(
          $scope.find(".numscore, .score, .rating").first().text(),
        );
        const statusText = $scope
          .find(".status, .manga-status, .post-status")
          .text()
          .toLowerCase();
        let status = "Unknown";
        if (statusText.includes("ongoing") || statusText.includes("updating"))
          status = "Ongoing";
        else if (statusText.includes("completed")) status = "Completed";
        else if (statusText.includes("hiatus")) status = "Hiatus";

        pushResult({
          title,
          mangaUrl,
          cover,
          rating,
          status,
        });
      });
    }

    // Second fallback: advanced-search page is often HTMX shell.
    // Pull the AJAX endpoint (with nonce) from the page and query it directly.
    if (results.length === 0) {
      const decodeHtmlEntities = (raw = "") =>
        String(raw || "")
          .replace(/&#0*38;|&amp;/gi, "&")
          .trim();

      const ajaxUrlRaw =
        $("input[name='query'][hx-post]").first().attr("hx-post") ||
        $("form[hx-post]").first().attr("hx-post") ||
        "";
      const ajaxUrl = toAbsoluteUrl(decodeHtmlEntities(ajaxUrlRaw));
      if (ajaxUrl) {
        try {
          const dynamicHeaders = await baseHeaders(redis);
          const setCookie = Array.isArray(res?.headers?.["set-cookie"])
            ? res.headers["set-cookie"].map((c) => String(c).split(";")[0]).join("; ")
            : "";
          const payload = new URLSearchParams({ query: keyword }).toString();
          const ajaxRes = await axios.post(ajaxUrl, payload, {
            headers: {
              ...dynamicHeaders,
              "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
              "X-Requested-With": "XMLHttpRequest",
              "HX-Request": "true",
              "HX-Current-URL": searchUrl,
              Origin: SITE_URL.replace(/\/$/, ""),
              Referer: searchUrl,
              ...(setCookie ? { Cookie: setCookie } : {}),
            },
            timeout: 12000,
          });

          const ajaxHtml = String(ajaxRes?.data || "");
          const $$ = cheerio.load(ajaxHtml);
          const $$anchors = $$("a[href*='/manga/']");
          logger.info(
            { ajaxUrl, anchorCount: $$anchors.length },
            "[searchIkiru] AJAX fallback parser",
          );

          $$anchors.each((_, a) => {
            const $a = $$(a);
            const mangaUrl = $a.attr("href");
            const $scope = $a.closest("article, li, div");
            const title =
              normalizeText($a.text()) ||
              normalizeText(
                $scope
                  .find("h1, h2, h3, h4, .font-medium, .entry-title, .post-title")
                  .first()
                  .text(),
              );
            const cover =
              $scope.find("img").first().attr("src") ||
              $scope.find("img").first().attr("data-src") ||
              "";
            const rating = normalizeText(
              $scope.find(".numscore, .score, .rating").first().text(),
            );
            const statusText = $scope
              .find(".status, .manga-status, .post-status")
              .text()
              .toLowerCase();
            let status = "Unknown";
            if (
              statusText.includes("ongoing") ||
              statusText.includes("updating")
            )
              status = "Ongoing";
            else if (statusText.includes("completed")) status = "Completed";
            else if (statusText.includes("hiatus")) status = "Hiatus";

            pushResult({
              title,
              mangaUrl,
              cover,
              rating,
              status,
            });
          });
        } catch (ajaxErr) {
          logger.warn(
            { err: ajaxErr?.message, ajaxUrl },
            "[searchIkiru] AJAX fallback failed",
          );
        }
      }
    }

    return results.slice(0, 50);
  } catch (err) {
    logger.error({
      err: err.message,
      status: err.response?.status,
      code: err.code,
      searchUrl,
      keyword,
    }, "[searchIkiru] Error");
    return [];
  }
}

// Fetch recent chapters (<24h) from manga detail page via AJAX endpoint
// Used when new manga is added to immediately notify of latest chapters
export async function fetchIkiruRecentChaptersFromLatestPage(
  mangaUrl,
  redis = null,
) {
  if (!mangaUrl) return [];

  try {
    // Step 1: Fetch manga page to get hx-get URL or manga_id
    const res = await scrapeWithHeaders(mangaUrl, redis, { timeout: 3000 });
    const $ = cheerio.load(res.data);

    // Extract title
    const title = extractTitleFromPage($, {});

    // Step 2: Get AJAX endpoint from hx-get attribute
    const hxGet = $("#chapter-list").attr("hx-get");

    let chapterHtml = "";

    if (hxGet) {
      // Step 3: Fetch chapter list from AJAX endpoint
      const ajaxRes = await scrapeWithHeaders(hxGet, redis, { timeout: 3000 });
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
    logger.error("[fetchIkiruRecentChaptersFromLatestPage] Error:", err.message);
    return [];
  }
}

/**
 * @deprecated Use fetchIkiruRecentChaptersFromLatestPage instead.
 * Kept temporarily for backward compatibility.
 */
export async function fetchRecentChaptersFromMangaPage(mangaUrl, redis = null) {
  return fetchIkiruRecentChaptersFromLatestPage(mangaUrl, redis);
}
