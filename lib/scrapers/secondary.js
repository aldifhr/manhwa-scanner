import pLimit from "p-limit";
import * as cheerio from "cheerio";
import { httpGet } from "../httpClient.js";
import { retryAsync, withTimeout } from "../utils.js";
import {
  getCachedOrFetch,
  logWarnError,
  parseDateWithFallback,
} from "../dateUtils.js";
import {
  HTTP_USER_AGENT,
  SECONDARY_CHAPTER_LIST_MAX_PAGES,
  SECONDARY_DETAIL_MAX_MANGA,
  SECONDARY_DETAIL_THROTTLE_MS,
  SECONDARY_DETAIL_WINDOW_HOURS,
  SECONDARY_PUBLIC_BASE,
  SECONDARY_SOURCE_URL,
  normalizeSource,
  normalizeText,
  parseLooseRelativeTime,
  normalizeSourceUrl,
  pickSecondaryDescription,
  scrapeWithHeaders,
  shouldPrioritizeSecondaryEntry,
  sleep,
} from "./shared.js";
import { SECONDARY_CONFIG, SCRAPER_LOOKBACK_HOURS } from "../config.js";

// FastCron-safe configuration
// Balanced mode: 10-12s target - completes most work safely
const FASTCRON_SAFE_CONFIG = SECONDARY_CONFIG;

// Chapter freshness threshold (hours)
const FRESH_CHAPTER_HOURS_DEFAULT = SCRAPER_LOOKBACK_HOURS;
const CATEGORY_ID_MANGA = 1;

// API base URL helper (prevents repeated strip operations)
const API_BASE = (SECONDARY_SOURCE_URL || "").replace(/\/+$/, "");

// Standard HTTP headers for API requests
const JSON_HEADERS = {
  Accept: "application/json",
  "User-Agent": HTTP_USER_AGENT,
};

const BROWSER_HEADERS = {
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
  "User-Agent": HTTP_USER_AGENT,
  Referer: SECONDARY_PUBLIC_BASE,
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
};

// =================== Helper Functions ===================

function getShngmType(source) {
  return normalizeSource(source) === "shinigami_mirror" ? "mirror" : "project";
}

/**
 * Extract rows from various API response formats
 */
function extractRows(payload) {
  if (!payload) return [];
  return payload.data ?? payload.result ?? payload.items ?? [];
}

/**
 * Check if a date is within the last N hours
 */
function isWithinHours(date, hours = FRESH_CHAPTER_HOURS_DEFAULT, now = Date.now()) {
  if (!date) return false;
  return (now - date.getTime()) / 3600000 <= hours;
}

/**
 * Fetch with retry and timeout - common pattern for all requests
 */
async function fetchWithRetry(endpoint, headers, timeout, context = "") {
  return retryAsync(
    async () =>
      withTimeout(
        httpGet(endpoint, { headers, timeout }, { retries: 0, baseDelayMs: 0 }),
        timeout + 1000,
        context,
      ),
    {
      maxAttempts: FASTCRON_SAFE_CONFIG.MAX_RETRIES,
      delay: FASTCRON_SAFE_CONFIG.RETRY_DELAY,
      backoff: 2,
    },
  );
}

// =================== Chapter Fetching ===================

async function fetchChapterPage(apiBase, mangaId, page, pageSize) {
  const endpoint = `${apiBase}/v1/chapter/${mangaId}/list?page=${page}&page_size=${pageSize}&sort_by=chapter_number&sort_order=desc`;

  const res = await fetchWithRetry(
    endpoint,
    JSON_HEADERS,
    FASTCRON_SAFE_CONFIG.REQUEST_TIMEOUT,
    `Secondary chapter list timeout for ${mangaId} page ${page}`,
  );

  return extractRows(res.data);
}

function transformChapterRows(rows, now = Date.now(), lookbackHours = FRESH_CHAPTER_HOURS_DEFAULT) {
  return rows
    .map((row) => {
      const dateRaw = row?.release_date ?? row?.created_at ?? row?.updated_at;
      const parsedTime = parseDateWithFallback(dateRaw);
      if (!parsedTime) return null;
      if (!isWithinHours(parsedTime, lookbackHours, now)) return null;

      return {
        chapter_id: row?.chapter_id,
        chapter_number: row?.chapter_number,
        created_at: parsedTime.toISOString(),
      };
    })
    .filter(Boolean);
}

function mapChapterCandidate(chapter, fallbackRow = null, now = Date.now(), lookbackHours = FRESH_CHAPTER_HOURS_DEFAULT) {
  const chapterId =
    chapter?.chapter_id ??
    chapter?.id ??
    fallbackRow?.latest_chapter_id ??
    null;
  const chapterNumber =
    chapter?.chapter_number ??
    chapter?.number ??
    fallbackRow?.latest_chapter_number ??
    null;
  const dateRaw =
    chapter?.release_date ??
    chapter?.created_at ??
    chapter?.updated_at ??
    fallbackRow?.latest_chapter_time ??
    fallbackRow?.updated_at ??
    null;

  const parsedTime = parseDateWithFallback(dateRaw);
  if (!chapterId || chapterNumber === null || !parsedTime) return null;
  if (!isWithinHours(parsedTime, lookbackHours, now)) return null;

  return {
    chapter_id: chapterId,
    chapter_number: chapterNumber,
    created_at: parsedTime.toISOString(),
  };
}

export function extractDetailChaptersFromMangaDetail(payload, now = Date.now(), lookbackHours = FRESH_CHAPTER_HOURS_DEFAULT) {
  const root = payload?.data ?? payload?.result ?? payload ?? {};
  const detail = root?.data ?? root;

  const chapterArrayCandidates = [
    detail?.chapters,
    detail?.latest_chapters,
    detail?.chapter_list,
    detail?.chapterList,
  ].find((arr) => Array.isArray(arr));

  if (Array.isArray(chapterArrayCandidates) && chapterArrayCandidates.length) {
    return chapterArrayCandidates
      .map((chapter) => mapChapterCandidate(chapter, detail, now, lookbackHours))
      .filter(Boolean);
  }

  const single = mapChapterCandidate(detail, detail, now, lookbackHours);
  return single ? [single] : [];
}

async function fetchSecondaryRecentChapters(apiBase, mangaId, redis = null, lookbackHours = FRESH_CHAPTER_HOURS_DEFAULT) {
  const cacheKey = `shinigami:chapters:${mangaId}`;
  const cacheTtl = 300;

  return getCachedOrFetch(
    redis,
    cacheKey,
    async () => {
      const pageSize = 24;
      const collected = [];
      const now = Date.now();

      for (
        let page = 1;
        page <= Math.max(1, SECONDARY_CHAPTER_LIST_MAX_PAGES);
        page++
      ) {
        const rows = await fetchChapterPage(apiBase, mangaId, page, pageSize);
        if (!rows.length) break;

        const freshChapters = transformChapterRows(rows, now, lookbackHours);
        collected.push(...freshChapters);

        if (!freshChapters.length || rows.length < pageSize) break;
      }

      return collected;
    },
    cacheTtl,
    "fetchSecondaryRecentChapters",
  );
}

export async function fetchSecondaryRecentChaptersFromMangaDetail(apiBase, mangaId, lookbackHours = FRESH_CHAPTER_HOURS_DEFAULT) {
  const endpoint = `${apiBase}/v1/manga/detail/${mangaId}`;
  const res = await fetchWithRetry(
    endpoint,
    JSON_HEADERS,
    FASTCRON_SAFE_CONFIG.REQUEST_TIMEOUT,
    `Secondary manga detail timeout for ${mangaId}`,
  );
  return extractDetailChaptersFromMangaDetail(res?.data, Date.now(), lookbackHours);
}

export async function fetchSecondaryMangaDetail(apiBase, mangaId) {
  const endpoint = `${apiBase}/v1/manga/detail/${mangaId}`;
  const res = await fetchWithRetry(
    endpoint,
    JSON_HEADERS,
    FASTCRON_SAFE_CONFIG.REQUEST_TIMEOUT,
    `Secondary manga detail timeout for ${mangaId}`,
  );
  const payload = res?.data?.data ?? res?.data ?? {};
  return payload?.data ?? payload;
}

// =================== Update Scraping - Split into focused functions ===================

function createInitialMetrics() {
  return {
    detailAttempts: 0,
    detailSuccesses: 0,
    detailFallbacks: 0,
    detail429: 0,
    detailSkippedNonPriority: 0,
  };
}

function shouldFetchDetail(
  row,
  prioritizeDetail,
  detailCount,
  detailCircuitOpen,
  now = Date.now(),
) {
  if (!prioritizeDetail) return false;
  if (detailCircuitOpen) return false;
  if (detailCount >= SECONDARY_DETAIL_MAX_MANGA) return false;

  const latestRaw = row?.latest_chapter_time ?? row?.updated_at;
  const latestParsed = parseDateWithFallback(latestRaw);
  if (!latestParsed) return false;

  const diffHours = (now - latestParsed.getTime()) / 3600000;
  return diffHours <= SECONDARY_DETAIL_WINDOW_HOURS;
}

function claimDetailSlot(detailState) {
  if (detailState.circuitOpen) return false;
  if (detailState.count >= SECONDARY_DETAIL_MAX_MANGA) return false;
  detailState.count += 1;
  return true;
}

function releaseDetailSlot(detailState) {
  detailState.count = Math.max(0, detailState.count - 1);
}

async function fetchDetailChapters(
  apiBase,
  mangaId,
  redis,
  metrics,
  detailState,
  logger,
  normalized,
  lookbackHours = FRESH_CHAPTER_HOURS_DEFAULT,
) {
  metrics.detailAttempts += 1;

  try {
    if (SECONDARY_DETAIL_THROTTLE_MS > 0) {
      await sleep(Math.floor(SECONDARY_DETAIL_THROTTLE_MS / 2));
    }

    let chapters = [];
    try {
      // Prefer manga detail endpoint first because it is more stable in production.
      chapters = await fetchSecondaryRecentChaptersFromMangaDetail(
        apiBase,
        mangaId,
        lookbackHours,
      );
    } catch (detailErr) {
      logger?.warn(
        { source: normalized, mangaId, err: detailErr.message },
        "secondary manga detail endpoint failed, trying chapter list endpoint",
      );
      chapters = [];
    }

    if (!chapters?.length) {
      chapters = await fetchSecondaryRecentChapters(apiBase, mangaId, redis, lookbackHours);
    }

    // detailState.count is consumed by claimDetailSlot as per-run detail budget.
    if (chapters?.length) {
      metrics.detailSuccesses += 1;
      return chapters;
    }
    throw new Error("No fresh chapters from chapter-list and manga-detail endpoints");
  } catch (err) {
    if (err?.response?.status === 429) {
      detailState.circuitOpen = true;
      metrics.detail429 += 1;
      logger?.warn(
        { source: normalized },
        "secondary detail 429; disabling detail mode",
      );
    } else {
      logger?.warn(
        { source: normalized, mangaId, err: err.message },
        "secondary chapter list fallback",
      );
    }
    metrics.detailFallbacks += 1;
    return null;
  }
}

function getFallbackChapters(row, now = Date.now(), lookbackHours = FRESH_CHAPTER_HOURS_DEFAULT) {
  const chapters = row?.chapters;
  if (Array.isArray(chapters) && chapters.length) {
    return chapters.filter((chapter) => {
      const chapterRaw = chapter?.created_at ?? row?.updated_at;
      const parsed = parseDateWithFallback(chapterRaw);
      return parsed && isWithinHours(parsed, lookbackHours, now);
    });
  }

  const fallback = [
    {
      chapter_id: row?.latest_chapter_id,
      chapter_number: row?.latest_chapter_number,
      created_at: row?.latest_chapter_time ?? row?.updated_at,
    },
  ];
  return fallback.filter((chapter) => {
    const parsed = parseDateWithFallback(chapter?.created_at);
    return parsed && isWithinHours(parsed, lookbackHours, now);
  });
}

function formatChapterText(chapterNumber) {
  const text = String(chapterNumber ?? "").trim();
  if (!text) return "";
  return /chapter/i.test(text) ? text : `Chapter ${text}`;
}

function transformChapterResults(
  row,
  chapterRows,
  seen,
  source,
  mangaUrl,
  now = Date.now(),
  lookbackHours = FRESH_CHAPTER_HOURS_DEFAULT,
) {
  const title = String(row?.title ?? "").trim();
  const cover = row?.cover_image_url ?? row?.cover_portrait_url ?? null;

  return chapterRows
    .map((chapterRow) => {
      if (!chapterRow?.chapter_id) return null;

      const chapter = formatChapterText(chapterRow?.chapter_number);
      if (!chapter) return null;

      const chapterRaw = chapterRow?.created_at ?? row?.updated_at;
      const parsedTime = parseDateWithFallback(chapterRaw);
      if (!parsedTime || !isWithinHours(parsedTime, lookbackHours, now)) return null;

      const chapterUrl = `${SECONDARY_PUBLIC_BASE}/chapter/${chapterRow.chapter_id}`;
      const key = chapterUrl.toLowerCase().trim();
      if (seen.has(key)) return null;
      seen.add(key);

      return {
        title,
        chapter,
        url: chapterUrl,
        cover,
        mangaUrl,
        rating: row?.user_rate ? String(row.user_rate) : "N/A",
        status: row?.status === 1 ? "Ongoing" : "Unknown",
        updatedTime: parsedTime.toISOString(),
        description: pickSecondaryDescription(row),
        source,
      };
    })
    .filter(Boolean);
}

function parseSecondaryHtmlTime(raw) {
  const text = normalizeText(raw || "");
  if (!text) return null;
  return parseDateWithFallback(text) || parseLooseRelativeTime(text);
}

function extractFallbackChapterTimeText($, $anchor, $container) {
  const directTime =
    normalizeText($container.find("time").first().attr("datetime")) ||
    normalizeText($container.find("time").first().text()) ||
    normalizeText(
      $container.find("[class*='time'],[class*='date']").first().text(),
    );
  if (directTime) return directTime;

  // SHNGM detail page commonly stores relative time in generic <p> text
  // like "1 jam lalu", "11 jam lalu", "7 hari lalu", "1 bln lalu".
  const paragraphTexts = $container
    .find("p, span, div")
    .map((_, el) => normalizeText($(el).text()))
    .get()
    .filter(Boolean);

  const relativePattern =
    /\b(\d+)\s*(detik|menit|jam|hari|minggu|bulan|bln|month|months|hour|hours|day|days)\b/i;
  const matchedRelative = paragraphTexts.find((txt) => relativePattern.test(txt));
  if (matchedRelative) return matchedRelative;

  // Last fallback: inspect nearby siblings in case chapter card structure differs.
  const siblingTexts = $anchor
    .siblings()
    .map((_, el) => normalizeText($(el).text()))
    .get()
    .filter(Boolean);
  return siblingTexts.find((txt) => relativePattern.test(txt)) || "";
}

async function fetchFallbackChaptersFromSeriesHtml(
  seriesUrl,
  redis,
  now = Date.now(),
  logger = null,
  source = null,
  lookbackHours = FRESH_CHAPTER_HOURS_DEFAULT,
) {
  if (!seriesUrl) return [];
  try {
    const res = await scrapeWithHeaders(seriesUrl, redis, {
      timeout: FASTCRON_SAFE_CONFIG.REQUEST_TIMEOUT,
      retries: 1,
    });
    const html = String(res?.data || "");
    if (!html) return [];

    const $ = cheerio.load(html);
    const rows = [];
    const seen = new Set();

    $("a[href*='/chapter/']").each((_, el) => {
      const $a = $(el);
      const href = $a.attr("href") || "";
      const chapterIdMatch = href.match(/\/chapter\/([^/?#]+)/i);
      const chapterId = chapterIdMatch?.[1] || null;
      if (!chapterId || seen.has(chapterId)) return;
      seen.add(chapterId);

      const chapterText =
        normalizeText($a.text()) ||
        normalizeText($a.closest("li,div,article").find("[class*='chapter']").first().text());
      if (!chapterText) return;

      const $container = $a.closest("li,div,article");
      const timeText = extractFallbackChapterTimeText($, $a, $container);
      const parsedTime = parseSecondaryHtmlTime(timeText);
      if (!parsedTime || !isWithinHours(parsedTime, lookbackHours, now)) return;

      rows.push({
        chapter_id: chapterId,
        chapter_number: chapterText,
        created_at: parsedTime.toISOString(),
      });
    });

    return rows;
  } catch (err) {
    logger?.warn?.(
      {
        source,
        seriesUrl,
        err: err?.message || String(err),
      },
      "secondary html fallback failed",
    );
    return [];
  }
}

function parseSeriesIdFromUrl(url) {
  const normalized = normalizeSourceUrl(url || "");
  if (!normalized) return null;
  const match = normalized.match(/\/series\/([^/?#]+)/i);
  return match?.[1] || null;
}

function buildDirectUrlFallbackRows(
  preferredMatcher,
  existingMangaIds = new Set(),
) {
  const urls = preferredMatcher?.urlKeys instanceof Set
    ? Array.from(preferredMatcher.urlKeys)
    : [];
  const urlTitleMap = preferredMatcher?.urlTitleMap instanceof Map
    ? preferredMatcher.urlTitleMap
    : new Map();

  const rows = [];
  for (const rawUrl of urls) {
    const normalizedUrl = normalizeSourceUrl(rawUrl);
    const mangaId = parseSeriesIdFromUrl(normalizedUrl);
    if (!mangaId) continue;
    if (existingMangaIds.has(String(mangaId))) continue;

    rows.push({
      manga_id: mangaId,
      title: urlTitleMap.get(normalizedUrl) || "Unknown Title",
      __directFallback: true,
      direct_series_url: normalizedUrl,
      cover_image_url: null,
      cover_portrait_url: null,
      user_rate: null,
      status: null,
      // Mark as recently updated so processRow can enter detail-fetch path
      // and call chapter list API directly for whitelist URL fallback entries.
      updated_at: new Date().toISOString(),
      latest_chapter_time: new Date().toISOString(),
    });
  }

  return rows;
}

async function selectRotatingDirectFallbackRows(
  rows,
  limit,
  redis,
  source,
) {
  if (!Array.isArray(rows) || rows.length === 0 || limit <= 0) return [];
  if (rows.length <= limit) return rows;

  // Rotate checked rows across runs so all whitelist URLs get a chance
  // even when API feed is down and we rely on direct fallback.
  if (!redis || typeof redis.get !== "function" || typeof redis.set !== "function") {
    return rows.slice(0, limit);
  }

  const cursorKey = `secondary:direct_fallback_cursor:${source}`;
  let start = 0;
  try {
    const raw = await redis.get(cursorKey);
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) {
      start = parsed % rows.length;
    }
  } catch {
    start = 0;
  }

  const selected = [];
  for (let i = 0; i < limit; i++) {
    selected.push(rows[(start + i) % rows.length]);
  }

  const nextStart = (start + selected.length) % rows.length;
  try {
    await redis.set(cursorKey, String(nextStart), { ex: 60 * 60 * 24 * 30 });
  } catch {
    // ignore cursor persistence errors; fallback selection still works
  }

  return selected;
}

async function processRow(
  row,
  apiBase,
  redis,
  metrics,
  detailState,
  seen,
  preferredMatcher,
  logger,
  normalized,
  lookbackHours = FRESH_CHAPTER_HOURS_DEFAULT,
) {
  const title = String(row?.title ?? "").trim();
  if (!title || !row?.manga_id) return [];
  const mangaUrl =
    normalizeSourceUrl(row?.direct_series_url || "") ||
    `${SECONDARY_PUBLIC_BASE}/series/${row.manga_id}`;

  // Single timestamp for the entire function
  const now = Date.now();

  const prioritizeDetail = shouldPrioritizeSecondaryEntry(
    { title, mangaUrl },
    preferredMatcher,
  );

  if (!prioritizeDetail) {
    metrics.detailSkippedNonPriority += 1;
    return [];
  }

  // For direct fallback rows derived from whitelist URLs, bypass API calls and
  // scrape the series HTML directly. This avoids failing hard when API endpoints
  // are intermittently unavailable in production.
  if (row?.__directFallback) {
    let resolvedRow = row;
    let directRows = [];
    try {
      // Prefer API chapter list for direct fallback entries. The public series page
      // can be JS-rendered and may not contain chapter anchors in raw HTML.
      directRows = await fetchSecondaryRecentChapters(API_BASE, row.manga_id, redis, lookupHours);
    } catch (err) {
      logger?.warn?.(
        {
          source: normalized,
          mangaId: row?.manga_id,
          err: err?.message || String(err),
        },
        "secondary direct fallback chapter list failed",
      );
      directRows = [];
    }

    if (!Array.isArray(directRows) || !directRows.length) {
      directRows = await fetchFallbackChaptersFromSeriesHtml(
        mangaUrl,
        redis,
        now,
        logger,
        lookupHours,
      );
    }

    if (!Array.isArray(directRows) || !directRows.length) return [];

    // If fallback row lacks metadata/title, hydrate it from manga detail endpoint
    // so Discord embeds are not sent as "Unknown Title/Status/Rating".
    if (
      !String(resolvedRow?.title || "").trim() ||
      /^unknown title$/i.test(String(resolvedRow?.title || "").trim()) ||
      resolvedRow?.status === null ||
      resolvedRow?.status === undefined ||
      resolvedRow?.user_rate === null ||
      resolvedRow?.user_rate === undefined
    ) {
      try {
        const detail = await fetchSecondaryMangaDetail(apiBase, row.manga_id);
        if (detail && typeof detail === "object") {
          resolvedRow = {
            ...resolvedRow,
            title: detail?.title || resolvedRow?.title,
            status: detail?.status ?? resolvedRow?.status,
            user_rate: detail?.user_rate ?? resolvedRow?.user_rate,
            cover_image_url:
              detail?.cover_image_url || resolvedRow?.cover_image_url,
            cover_portrait_url:
              detail?.cover_portrait_url || resolvedRow?.cover_portrait_url,
            description:
              detail?.description || resolvedRow?.description || null,
          };
        }
      } catch (err) {
        logger?.warn?.(
          {
            source: normalized,
            mangaId: row?.manga_id,
            err: err?.message || String(err),
          },
          "secondary direct fallback metadata hydrate failed",
        );
      }
    }

    return transformChapterResults(
      resolvedRow,
      directRows,
      seen,
      normalized,
      mangaUrl,
      now,
      lookupHours,
    );
  }

  // Circuit breaker check - use fallback immediately if circuit is open
  if (detailState.circuitOpen) {
    const chapterRows = getFallbackChapters(row, now, lookupHours);
    return transformChapterResults(
      row,
      chapterRows,
      seen,
      normalized,
      mangaUrl,
      now,
      lookupHours,
    );
  }

  // Check if we should fetch detailed chapters (BEFORE incrementing count)
  const shouldUseDetail = shouldFetchDetail(
    row,
    prioritizeDetail,
    detailState.count,
    detailState.circuitOpen,
    now,
  );

  let chapterRows = null;
  let hasDetailSlot = false;

  if (shouldUseDetail) {
    hasDetailSlot = claimDetailSlot(detailState);
    if (hasDetailSlot) {
      chapterRows = await fetchDetailChapters(
        apiBase,
        row.manga_id,
        redis,
        metrics,
        detailState,
        logger,
        normalized,
      );

      if (!chapterRows && !detailState.circuitOpen) {
        // Free slot when detail fetch fails for non-429 path.
        releaseDetailSlot(detailState);
      }
    }
  }

  if (!chapterRows) {
    chapterRows = getFallbackChapters(row, now, lookupHours);
  }

  // Final fallback: scrape series page HTML directly for fresh chapter rows.
  if ((!Array.isArray(chapterRows) || chapterRows.length === 0) && mangaUrl) {
    chapterRows = await fetchFallbackChaptersFromSeriesHtml(
      mangaUrl,
      redis,
      now,
      logger,
      lookupHours,
    );
  }

  if (!Array.isArray(chapterRows) || !chapterRows.length) {
    return [];
  }

  return transformChapterResults(
    row,
    chapterRows,
    seen,
    normalized,
    mangaUrl,
    now,
    lookupHours,
  );
}

async function fetchUpdateList(apiBase, normalized) {
  const endpoint = `${apiBase}/v1/manga/list?type=${getShngmType(normalized)}&page=1&page_size=40&is_update=true&sort=latest&sort_order=desc`;

  const res = await fetchWithRetry(
    endpoint,
    BROWSER_HEADERS,
    FASTCRON_SAFE_CONFIG.REQUEST_TIMEOUT,
    `Secondary update list timeout for ${normalized}`,
  );

  return extractRows(res.data);
}

export async function scrapeSecondarySourceUpdates(
  source = "shinigami_project",
  { throwOnError = false, preferredMatcher = null, redis = null, options = {} } = {},
  logger = null,
) {
  const lookbackHours = options.force || options.fullRefresh ? 168 : FRESH_CHAPTER_HOURS_DEFAULT;
  if (!API_BASE) {
    return { results: [], metrics: createInitialMetrics() };
  }

  try {
    const normalized = normalizeSource(source);
    let rows = [];
    try {
      rows = await fetchUpdateList(API_BASE, normalized);
    } catch (feedErr) {
      logger?.warn?.(
        { source: normalized, err: feedErr?.message || String(feedErr) },
        "secondary update feed failed, continuing with direct fallback",
      );
      rows = [];
    }

    const metrics = createInitialMetrics();
    const seen = new Set();
    const detailState = { count: 0, circuitOpen: false };
    const limit = pLimit(3);
    const existingMangaIds = new Set(
      rows.map((row) => String(row?.manga_id || "")).filter(Boolean),
    );

    const itemTasks = rows.map((row) =>
      limit(() =>
        processRow(
          row,
          API_BASE,
          redis,
          metrics,
          detailState,
          seen,
          preferredMatcher,
          logger,
          normalized,
          lookbackHours,
        ),
      ),
    );

    const results = (await Promise.all(itemTasks)).flat();
    const processedTitleKeys = new Set();
    results.forEach(item => {
      const tk = normalizeTitleKey(item.title);
      if (tk) processedTitleKeys.add(tk);
    });

    // Fallback 1: Direct URL Fallback
    const directFallbackRowsAll = buildDirectUrlFallbackRows(
      preferredMatcher,
      existingMangaIds,
    );
    const directFallbackRows = await selectRotatingDirectFallbackRows(
      directFallbackRowsAll,
      FASTCRON_SAFE_CONFIG.DIRECT_FALLBACK_MAX_URLS,
      redis,
      normalized,
    );
    logger?.info?.(
      {
        source: normalized,
        updateRows: rows.length,
        directFallbackRowsTotal: directFallbackRowsAll.length,
        directFallbackRowsCount: directFallbackRows.length,
      },
      "secondary fallback planning",
    );

    if (directFallbackRows.length > 0) {
      const fallbackResultsNested = await Promise.all(
        directFallbackRows.map((row) =>
          limit(() =>
            processRow(
              row,
              API_BASE,
              redis,
              metrics,
              detailState,
              seen,
              preferredMatcher,
              logger,
              normalized,
              lookbackHours,
            ),
          ),
        ),
      );
      const fallbackResults = fallbackResultsNested.flat();
      results.push(...fallbackResults);
      fallbackResults.forEach(item => {
        const tk = normalizeTitleKey(item.title);
        if (tk) processedTitleKeys.add(tk);
      });
    }

    // Fallback 2: Title-based Expansion (Deep Scan)
    const missingTitleKeys = Array.from(preferredMatcher?.titleKeys || [])
      .filter(tk => !processedTitleKeys.has(tk));

    const expansionLimit = options.fullRefresh ? 15 : 5;
    const expansionTitles = missingTitleKeys.slice(0, expansionLimit);

    if (expansionTitles.length > 0 && !options.skipExpansion) {
      logger?.info?.({ source: normalized, expansionCount: expansionTitles.length }, "starting secondary expansion");
      const expansionTasks = expansionTitles.map(titleKey => limit(async () => {
        try {
          const searchResults = await searchShngm(titleKey, source);
          if (!searchResults.length) return [];

          const bestMatch = searchResults[0];
          const mangaId = parseSeriesIdFromUrl(bestMatch.mangaUrl);
          if (!mangaId || existingMangaIds.has(String(mangaId))) return [];

          return await processRow(
            {
              manga_id: mangaId,
              title: bestMatch.title,
              __expansion: true,
              updated_at: new Date().toISOString(),
            },
            API_BASE,
            redis,
            metrics,
            detailState,
            seen,
            preferredMatcher,
            logger,
            normalized,
            lookbackHours,
          );
        } catch (err) {
          logger?.warn({ titleKey, err: err.message }, "secondary expansion failed for title");
          return [];
        }
      }));

      const expansionResults = (await Promise.all(expansionTasks)).flat();
      results.push(...expansionResults);
    }

    logger?.info?.(
      {
        source: normalized,
        totalResults: results.length,
        metrics,
      },
      "secondary scrape summary",
    );

    return { results, metrics };
  } catch (err) {
    logger?.warn({ source, err: err.message }, "secondary scrape failed");
    if (throwOnError) throw err;
    return { results: [], metrics: createInitialMetrics() };
  }
}

// =================== Search ===================

function matchesSearch(title, keyword) {
  const normTitle = title.toLowerCase();
  return normTitle.includes(keyword) || keyword.includes(normTitle);
}

function transformSearchResult(row, normalized) {
  const title = String(row?.title ?? "").trim();
  if (!title || !row?.manga_id) return null;

  const mangaUrl = `${SECONDARY_PUBLIC_BASE}/series/${row.manga_id}`;
  const dateRaw = row?.latest_chapter_time ?? row?.updated_at;
  const parsedDate = parseDateWithFallback(dateRaw);

  return {
    title,
    mangaUrl,
    updatedTime: parsedDate?.toISOString() ?? null,
    description: pickSecondaryDescription(row),
    source: normalized,
  };
}

async function searchPage(apiBase, type, page, keyword, normalized) {
  const endpoint = `${apiBase}/v1/manga/list?type=${type}&page=${page}&page_size=40&sort=latest&sort_order=desc`;

  try {
    const res = await fetchWithRetry(
      endpoint,
      JSON_HEADERS,
      FASTCRON_SAFE_CONFIG.REQUEST_TIMEOUT,
      `Search SHNGM timeout page ${page}`,
    );

    const rows = extractRows(res.data);
    if (!rows.length) return { ok: true, items: [], hasRows: false };

    const items = rows
      .map((row) => {
        const title = String(row?.title ?? "").trim();
        if (!title || !matchesSearch(title, keyword)) return null;
        return transformSearchResult(row, normalized);
      })
      .filter(Boolean);
    return { ok: true, items, hasRows: true };
  } catch {
    return { ok: false, items: [], hasRows: false };
  }
}

export async function searchShngm(query, source = "shinigami_project") {
  const keyword = String(query ?? "")
    .trim()
    .toLowerCase();
  if (!keyword) return [];

  const normalized = normalizeSource(source);
  const type = getShngmType(normalized);
  const seen = new Set();
  let consecutiveErrors = 0;

  const allResults = [];

  // Sequential fetching is necessary because we don't know total pages upfront
  // We stop when we get empty results or error
  for (let page = 1; page <= 4; page++) {
    const pageResults = await searchPage(
      API_BASE,
      type,
      page,
      keyword,
      normalized,
    );

    if (!pageResults.ok) {
      consecutiveErrors += 1;
      if (consecutiveErrors >= 2) break;
      continue;
    }
    consecutiveErrors = 0;
    // Stop only when the source page truly has no rows.
    // Do not stop when this page has no keyword matches, because
    // matches may exist on later pages.
    if (!pageResults.hasRows) break;

    const uniqueResults = pageResults.items.filter((r) => {
      const key = r.mangaUrl.toLowerCase().replace(/\/+$/, "");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    allResults.push(...uniqueResults);
  }

  return allResults.slice(0, 50);
}

// =================== Random Manga ===================

function isValidCategory(row) {
  const catId = Number(row?.category_id);
  return catId !== CATEGORY_ID_MANGA;
}

function transformRandomResult(row, normalized) {
  const title = String(row?.title ?? "").trim();
  if (!title || !row?.manga_id) return null;

  return {
    title,
    mangaUrl: `${SECONDARY_PUBLIC_BASE}/series/${row.manga_id}`,
    cover: row?.cover_image_url ?? row?.cover_portrait_url ?? null,
    rating: row?.user_rate ? String(row.user_rate) : "N/A",
    status: row?.status === 1 ? "Ongoing" : "Unknown",
    source: normalized,
  };
}

async function fetchRandomPage(apiBase, type, page, filterQuery) {
  const endpoint = `${apiBase}/v1/manga/list?type=${type}&page=${page}&page_size=40&sort=latest&sort_order=desc${filterQuery}`;

  const res = await fetchWithRetry(
    endpoint,
    JSON_HEADERS,
    FASTCRON_SAFE_CONFIG.REQUEST_TIMEOUT,
    `Random SHNGM page ${page} timeout`,
  );

  const rows = extractRows(res.data).filter(isValidCategory);
  return rows;
}

export async function fetchRandomShinigamiManga(
  source = "shinigami_project",
  { randomFn = Math.random } = {},
) {
  if (!API_BASE) return null;

  const normalized = normalizeSource(source);
  const type = getShngmType(normalized);
  const filterQuery = "&category_id=2,3";

  try {
    // Fetch page 1 to get metadata
    const initialEndpoint = `${API_BASE}/v1/manga/list?type=${type}&page=1&page_size=40&sort=latest&sort_order=desc${filterQuery}`;
    const initialRes = await fetchWithRetry(
      initialEndpoint,
      JSON_HEADERS,
      FASTCRON_SAFE_CONFIG.REQUEST_TIMEOUT,
      "Random SHNGM initial fetch timeout",
    );

    const meta = initialRes.data?.meta ?? {};
    const totalPages = Math.max(1, meta.total_page ?? 4);
    const randPage = Math.floor(randomFn() * totalPages) + 1;

    let rows;
    if (randPage === 1) {
      rows = extractRows(initialRes.data).filter(isValidCategory);
    } else {
      rows = await fetchRandomPage(API_BASE, type, randPage, filterQuery);
    }

    if (!rows?.length) return null;

    const randomIndex = Math.floor(randomFn() * rows.length);
    return transformRandomResult(rows[randomIndex], normalized);
  } catch (err) {
    logWarnError("fetchRandomShinigamiManga", err);
    return null;
  }
}
