import { getLogger } from "../../logger.js";
import { 
  SecondaryMangaRow, 
  ScraperMetrics, 
  RedisClient 
} from "../../types.js";
import { 
  DetailState, 
  SecondaryChapterRow 
} from "./types.js";
import { 
  parseDateWithFallback, 
  isWithinLastHours,
  getCachedOrFetch 
} from "../../dateUtils.js";
import { 
  SCRAPER_LOOKBACK_HOURS 
} from "../../config.js";
import { 
  sleep 
} from "../../utils.js";
import { 
  globalAdaptiveLimiter, 
  globalScrapeCacheManager 
} from "../optimizer.js";
import { 
  fetchSecondaryFullMangaInfo, 
  fetchChapterPage,
  API_BASE 
} from "./api.js";
import { 
  normalizeSourceUrl,
  SECONDARY_PUBLIC_BASE,
  shouldPrioritizeSecondaryEntry,
  HTTP_USER_AGENT,
  SECONDARY_DETAIL_MAX_MANGA,
  SECONDARY_DETAIL_WINDOW_HOURS,
  SECONDARY_DETAIL_THROTTLE_MS,
  SECONDARY_CHAPTER_LIST_MAX_PAGES
} from "../shared.js";
import { transformChapterRows } from "./parser.js";
import { PreferredSecondaryMatcher } from "../orchestrator.js";

const logger = getLogger({ scope: "secondary:logic" });

export function shouldFetchDetail(
  row: SecondaryMangaRow, 
  prioritizeDetail: boolean, 
  detailCount: number, 
  detailCircuitOpen: boolean, 
  now = Date.now()
) {
  if (!prioritizeDetail || detailCircuitOpen || detailCount >= SECONDARY_DETAIL_MAX_MANGA) return false;
  const latestRaw = row?.latest_chapter_time ?? row?.updated_at;
  const latestParsed = parseDateWithFallback(latestRaw);
  if (!latestParsed) return false;
  return (now - latestParsed.getTime()) / 3600000 <= SECONDARY_DETAIL_WINDOW_HOURS;
}

export function claimDetailSlot(detailState: DetailState) {
  if (detailState.circuitOpen || detailState.count >= SECONDARY_DETAIL_MAX_MANGA) return false;
  detailState.count += 1;
  return true;
}

export function releaseDetailSlot(detailState: DetailState) {
  detailState.count = Math.max(0, detailState.count - 1);
}

export async function fetchSecondaryRecentChapters(
  apiBase: string, 
  mangaId: string | number, 
  redis: RedisClient | null = null, 
  lookbackHours = SCRAPER_LOOKBACK_HOURS, 
  deadline = 0
) {
  const cacheKey = `shinigami:chapters:${mangaId}`;
  const cacheTtl = 300;

  return getCachedOrFetch(
    redis,
    cacheKey,
    async () => {
      const pageSize = 24;
      const collected: { chapter_id: string | number; chapter_number: string | number; created_at: string }[] = [];
      const now = Date.now();

      for (let page = 1; page <= Math.max(1, SECONDARY_CHAPTER_LIST_MAX_PAGES); page++) {
        const rows = await fetchChapterPage(apiBase, mangaId, page, pageSize, deadline);
        if (!rows.length) break;

        const freshChapters = transformChapterRows(rows as any, now, lookbackHours);
        collected.push(...freshChapters);

        if (!freshChapters.length || (rows.length > 0 && rows.length < pageSize)) break;
      }

      return collected;
    },
    cacheTtl,
    "fetchSecondaryRecentChapters",
  );
}

export async function fetchDetailChapters(
  apiBase: string,
  mangaId: string | number,
  redis: RedisClient | null,
  metrics: ScraperMetrics,
  detailState: DetailState,
  normalized: string,
  lookbackHours = SCRAPER_LOOKBACK_HOURS,
  deadline = 0,
) {
  metrics.detailAttempts = (metrics.detailAttempts || 0) + 1;
  const startTime = Date.now();
  try {
    if (SECONDARY_DETAIL_THROTTLE_MS > 0) await sleep(Math.floor(SECONDARY_DETAIL_THROTTLE_MS / 2));

    let chapters: any[] | null = [];
    
    // OPTIMIZATION: For Shinigami/Secondary, always prioritize the list endpoint directly
    // since the detail endpoint often omits chapters or is throttled separately.
    try {
      chapters = await fetchSecondaryRecentChapters(apiBase, mangaId, redis, lookbackHours, deadline);
      if (chapters?.length) {
        metrics.detailSuccesses = (metrics.detailSuccesses || 0) + 1;
        const duration = Date.now() - startTime;
        metrics.responseTime = (metrics.responseTime || 0) + duration;
        globalAdaptiveLimiter.recordSuccess(duration);
        return chapters;
      }
    } catch (listErr: unknown) {
      const message = listErr instanceof Error ? listErr.message : String(listErr);
      logger.warn({ source: normalized, mangaId, err: message }, "secondary list endpoint failed; trying detail as last resort");
    }

    // Fallback to detail only if list fails or returns nothing
    try {
      const fullInfo = await fetchSecondaryFullMangaInfo(apiBase, mangaId, deadline);
      chapters = fullInfo.chapters;
    } catch (detailErr: unknown) {
      const message = detailErr instanceof Error ? detailErr.message : String(detailErr);
      logger.warn({ source: normalized, mangaId, err: message }, "secondary manga detail endpoint also failed");
      chapters = [];
    }

    if (chapters?.length) {
      metrics.detailSuccesses = (metrics.detailSuccesses || 0) + 1;
      const duration = Date.now() - startTime;
      metrics.responseTime = (metrics.responseTime || 0) + duration;
      globalAdaptiveLimiter.recordSuccess(duration);
      return chapters;
    }
    
    throw new Error("No fresh chapters from list or detail");
  } catch (err: unknown) {
    globalAdaptiveLimiter.recordError();
    const axiosError = err as { response?: { status?: number } };
    if (axiosError?.response?.status === 429) {
      detailState.circuitOpen = true;
      metrics.detail429 = (metrics.detail429 || 0) + 1;
    }
    metrics.detailFallbacks = (metrics.detailFallbacks || 0) + 1;
    return null;
  }
}

export function getFallbackChapters(row: SecondaryMangaRow, now = Date.now(), lookbackHours = SCRAPER_LOOKBACK_HOURS) {
  const chapters = (row as { chapters?: SecondaryChapterRow[] })?.chapters;
  if (Array.isArray(chapters) && chapters.length) {
    return chapters.filter((c) => {
      const parsed = parseDateWithFallback(c?.release_date ?? c?.created_at ?? row?.updated_at);
      return parsed && isWithinLastHours(parsed, lookbackHours);
    });
  }

  return [{
    chapter_id: row?.latest_chapter_id,
    chapter_number: row?.latest_chapter_number,
    created_at: row?.latest_chapter_time ?? row?.updated_at,
  }].filter((c) => {
    const parsed = parseDateWithFallback(c?.created_at as string);
    return parsed && isWithinLastHours(parsed, lookbackHours);
  });
}

export function buildDirectUrlFallbackRows(matcher: PreferredSecondaryMatcher | null, existingIds = new Set<string>()) {
  const urls = matcher?.urlKeys instanceof Set ? Array.from(matcher.urlKeys) : [];
  const map = matcher?.urlTitleMap instanceof Map ? matcher.urlTitleMap : new Map<string, string>();
  const rows: SecondaryMangaRow[] = [];
  for (const u of urls) {
    const norm = normalizeSourceUrl(u);
    const mid = norm?.match(/\/series\/([^/?#]+)/i)?.[1];
    if (!mid || existingIds.has(String(mid))) continue;
    rows.push({
      manga_id: mid, title: map.get(norm!) || "Unknown Title", __directFallback: true,
      direct_series_url: norm, updated_at: new Date().toISOString(), latest_chapter_time: new Date().toISOString(),
    } as SecondaryMangaRow);
  }
  return rows;
}

export async function selectRotatingDirectFallbackRows(rows: SecondaryMangaRow[], limit: number, redis: RedisClient | null, source: string) {
  if (!rows.length || limit <= 0) return [];
  if (rows.length <= limit) return rows;
  if (!redis) return rows.slice(0, limit);

  const key = `secondary:direct_fallback_cursor:${source}`;
  let start = 0;
  try {
    const raw = await redis.get(key);
    if (raw) start = parseInt(raw, 10) % rows.length;
  } catch { /* start defaults to 0 */ }

  const picked = [];
  for (let i = 0; i < limit; i++) picked.push(rows[(start + i) % rows.length]);
  await redis.set(key, String((start + picked.length) % rows.length), { ex: 2592000 });
  return picked;
}

export function filterPriorityRows(rows: SecondaryMangaRow[], preferredMatcher: PreferredSecondaryMatcher | null) {
  return rows.filter(row => {
    const title = String(row?.title ?? "").trim();
    const mangaUrl = normalizeSourceUrl(row?.direct_series_url || "") || `${SECONDARY_PUBLIC_BASE}/series/${row.manga_id}`;
    return shouldPrioritizeSecondaryEntry({ title, mangaUrl }, preferredMatcher);
  });
}
