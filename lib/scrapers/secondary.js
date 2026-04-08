import pLimit from "p-limit";
import { httpGet } from "../httpClient.js";
import { chunk, filter, orderBy, uniqBy, retryAsync, withTimeout } from "../utils.js";
import { logWarnError, parseDateWithFallback } from "../dateUtils.js";
import {
  HTTP_USER_AGENT,
  SECONDARY_CHAPTER_LIST_MAX_PAGES,
  SECONDARY_DETAIL_MAX_MANGA,
  SECONDARY_DETAIL_THROTTLE_MS,
  SECONDARY_DETAIL_WINDOW_HOURS,
  SECONDARY_PUBLIC_BASE,
  SECONDARY_SOURCE_URL,
  normalizeSource,
  pickSecondaryDescription,
  shouldPrioritizeSecondaryEntry,
  sleep,
} from "./shared.js";

// FastCron-safe configuration
// Balanced mode: 10-12s target - completes most work safely
const FASTCRON_SAFE_CONFIG = {
  REQUEST_TIMEOUT: 6000, // 6s timeout - allow more time for chapter list API
  MAX_RETRIES: 2, // 2 retries for reliability
  RETRY_DELAY: 500, // 500ms between retries
  BATCH_SIZE: 10, // High parallelism
  TOTAL_TIMEOUT: 12000, // 12s limit - balanced speed vs completeness
  MAX_CHAPTERS_PER_RUN: 8, // Get more chapters per run
};

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
function isWithinHours(date, hours, now = Date.now()) {
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

/**
 * Get cached data or fetch fresh
 */
async function getCachedOrFetch(redis, cacheKey, fetchFn, ttl = 300) {
  if (!redis) return fetchFn();

  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      const parsed = typeof cached === "string" ? JSON.parse(cached) : cached;
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {
    // Cache miss or error, continue fetching
  }

  const fresh = await fetchFn();

  if (fresh?.length > 0) {
    try {
      await redis.set(cacheKey, JSON.stringify(fresh), { ex: ttl });
    } catch {
      // Cache save error, ignore
    }
  }

  return fresh;
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

function transformChapterRows(rows, now = Date.now()) {
  return rows
    .map((row) => {
      const dateRaw = row?.release_date ?? row?.created_at ?? row?.updated_at;
      const parsedTime = parseDateWithFallback(dateRaw);
      if (!parsedTime) return null;
      if (!isWithinHours(parsedTime, FRESH_CHAPTER_HOURS, now)) return null;

      return {
        chapter_id: row?.chapter_id,
        chapter_number: row?.chapter_number,
        created_at: parsedTime.toISOString(),
      };
    })
    .filter(Boolean);
}

async function fetchSecondaryRecentChapters(apiBase, mangaId, redis = null) {
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

        const freshChapters = transformChapterRows(rows, now);
        collected.push(...freshChapters);

        if (!freshChapters.length || rows.length < pageSize) break;
      }

      return collected;
    },
    cacheTtl,
  );
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

const FRESH_CHAPTER_HOURS = 24;

async function fetchDetailChapters(
  apiBase,
  mangaId,
  redis,
  metrics,
  detailState,
  logger,
  normalized,
) {
  metrics.detailAttempts += 1;

  try {
    if (SECONDARY_DETAIL_THROTTLE_MS > 0) {
      await sleep(Math.floor(SECONDARY_DETAIL_THROTTLE_MS / 2));
    }

    const chapters = await fetchSecondaryRecentChapters(
      apiBase,
      mangaId,
      redis,
    );
    detailState.count += 1;
    metrics.detailSuccesses += 1;
    return chapters;
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

function getFallbackChapters(row) {
  const chapters = row?.chapters;
  if (Array.isArray(chapters) && chapters.length) {
    return chapters;
  }

  return [
    {
      chapter_id: row?.latest_chapter_id,
      chapter_number: row?.latest_chapter_number,
      created_at: row?.latest_chapter_time ?? row?.updated_at,
    },
  ];
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
  now = Date.now(),
) {
  const title = String(row?.title ?? "").trim();
  const mangaUrl = `${SECONDARY_PUBLIC_BASE}/series/${row.manga_id}`;
  const cover = row?.cover_image_url ?? row?.cover_portrait_url ?? null;

  return chapterRows
    .map((chapterRow) => {
      if (!chapterRow?.chapter_id) return null;

      const chapter = formatChapterText(chapterRow?.chapter_number);
      if (!chapter) return null;

      const chapterRaw = chapterRow?.created_at ?? row?.updated_at;
      const parsedTime = parseDateWithFallback(chapterRaw);
      if (!parsedTime || !isWithinHours(parsedTime, FRESH_CHAPTER_HOURS, now)) return null;

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
) {
  const title = String(row?.title ?? "").trim();
  if (!title || !row?.manga_id) return [];

  const prioritizeDetail = shouldPrioritizeSecondaryEntry(
    { title, mangaUrl: SECONDARY_PUBLIC_BASE + "/series/" + row.manga_id },
    preferredMatcher,
  );

  if (!prioritizeDetail) {
    metrics.detailSkippedNonPriority += 1;
    return [];
  }

  // Race condition fix: Check and increment count atomically before fetching
  if (detailState.circuitOpen) {
    const chapterRows = getFallbackChapters(row);
    return transformChapterResults(row, chapterRows, seen, normalized, Date.now());
  }

  const now = Date.now();
  const shouldUseDetail = shouldFetchDetail(
    row,
    prioritizeDetail,
    detailState.count,
    false, // circuit is already checked above
    now,
  );

  let chapterRows = null;

  if (shouldUseDetail) {
    // Increment count BEFORE fetching to prevent race condition
    detailState.count += 1;
    chapterRows = await fetchDetailChapters(
      apiBase,
      row.manga_id,
      redis,
      metrics,
      detailState,
      logger,
      normalized,
    );
  }

  if (!chapterRows) {
    chapterRows = getFallbackChapters(row);
  }

  if (!Array.isArray(chapterRows) || !chapterRows.length) {
    return [];
  }

  return transformChapterResults(row, chapterRows, seen, normalized, now);
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
  { throwOnError = false, preferredMatcher = null, redis = null } = {},
  logger = null,
) {
  if (!SECONDARY_SOURCE_URL) {
    return { results: [], metrics: createInitialMetrics() };
  }

  try {
    const apiBase = SECONDARY_SOURCE_URL.replace(/\/+$/, "");
    const normalized = normalizeSource(source);
    const rows = await fetchUpdateList(apiBase, normalized);

    const metrics = createInitialMetrics();
    const seen = new Set();
    const detailState = { count: 0, circuitOpen: false };
    const limit = pLimit(3);
    const now = Date.now();

    const itemTasks = rows.map((row) =>
      limit(() =>
        processRow(
          row,
          apiBase,
          redis,
          metrics,
          detailState,
          seen,
          preferredMatcher,
          logger,
          normalized,
        ),
      ),
    );

    const results = (await Promise.all(itemTasks)).flat();

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
    if (!rows.length) return [];

    return rows
      .map((row) => {
        const title = String(row?.title ?? "").trim();
        if (!title || !matchesSearch(title, keyword)) return null;
        return transformSearchResult(row, normalized);
      })
      .filter(Boolean);
  } catch {
    return null; // Signal to stop pagination
  }
}

export async function searchShngm(query, source = "shinigami_project") {
  const keyword = String(query ?? "")
    .trim()
    .toLowerCase();
  if (!keyword) return [];

  const normalized = normalizeSource(source);
  const type = getShngmType(normalized);
  const apiBase = SECONDARY_SOURCE_URL.replace(/\/+$/, "");
  const seen = new Set();

  const allResults = [];

  for (let page = 1; page <= 4; page++) {
    const pageResults = await searchPage(
      apiBase,
      type,
      page,
      keyword,
      normalized,
    );

    if (pageResults === null) break; // Error occurred
    if (!pageResults.length) break; // No more results

    const uniqueResults = pageResults.filter((r) => {
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
  return catId !== 1; // Exclude Manga (ID 1)
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

export async function fetchRandomShinigamiManga(source = "shinigami_project") {
  if (!SECONDARY_SOURCE_URL) return null;

  const normalized = normalizeSource(source);
  const type = getShngmType(normalized);
  const apiBase = SECONDARY_SOURCE_URL.replace(/\/+$/, "");
  const filterQuery = "&category_id=2,3";

  try {
    // Fetch page 1 to get metadata
    const initialEndpoint = `${apiBase}/v1/manga/list?type=${type}&page=1&page_size=40&sort=latest&sort_order=desc${filterQuery}`;
    const initialRes = await fetchWithRetry(
      initialEndpoint,
      JSON_HEADERS,
      FASTCRON_SAFE_CONFIG.REQUEST_TIMEOUT,
      "Random SHNGM initial fetch timeout",
    );

    const meta = initialRes.data?.meta ?? {};
    const totalPages = Math.max(1, meta.total_page ?? 4);
    const randPage = Math.floor(Math.random() * totalPages) + 1;

    let rows;
    if (randPage === 1) {
      rows = extractRows(initialRes.data).filter(isValidCategory);
    } else {
      rows = await fetchRandomPage(apiBase, type, randPage, filterQuery);
    }

    if (!rows?.length) return null;

    const randomIndex = Math.floor(Math.random() * rows.length);
    return transformRandomResult(rows[randomIndex], normalized);
  } catch (err) {
    logWarnError("fetchRandomShinigamiManga", err);
    return null;
  }
}
