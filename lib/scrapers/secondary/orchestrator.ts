import { getLogger } from "../../logger.js";
import pLimit from "p-limit";
import { 
  SecondaryMangaRow, 
  RedisClient, 
  ScraperMetrics, 
  SourceState,
  ChapterItem 
} from "../../types.js";
import { 
  DetailState,
  SecondaryChapterRow 
} from "./types.js";
import { 
  SCRAPER_LOOKBACK_HOURS 
} from "../../config.js";
import { 
  normalizeSource,
  normalizeSourceUrl,
  normalizeTitleKey,
  SECONDARY_PUBLIC_BASE,
  shouldPrioritizeSecondaryEntry,
  classifyScraperError
} from "../shared.js";
import { 
  API_BASE, 
  fetchUpdateList, 
  fetchSecondaryFullMangaInfo,
  searchShngm 
} from "./api.js";
import { 
  transformChapterResults,
  parseSeriesIdFromUrl 
} from "./parser.js";
import { 
  filterPriorityRows,
  selectRotatingDirectFallbackRows,
  buildDirectUrlFallbackRows,
  shouldFetchDetail,
  claimDetailSlot,
  fetchDetailChapters,
  releaseDetailSlot,
  getFallbackChapters,
  fetchSecondaryRecentChapters
} from "./logic.js";
import { 
  capRows, 
  capExpansionSearches, 
  DEFAULT_SECONDARY_OPTIONS 
} from "../secondary-expansion-limiter.js";
import { globalAdaptiveLimiter } from "../optimizer.js";
import { PreferredSecondaryMatcher } from "../orchestrator.js";

const logger = getLogger({ scope: "secondary:orchestrator" });

export function createInitialMetrics(): ScraperMetrics {
  return {
    detailAttempts: 0,
    detailSuccesses: 0,
    detailFallbacks: 0,
    detail429: 0,
    detailSkippedNonPriority: 0,
    responseTime: 0,
  };
}

async function processRow(
  row: SecondaryMangaRow,
  apiBase: string,
  redis: RedisClient | null,
  metrics: ScraperMetrics,
  detailState: DetailState,
  seen: Set<string>,
  preferredMatcher: PreferredSecondaryMatcher | null,
  normalized: string,
  lookbackHours = SCRAPER_LOOKBACK_HOURS,
  deadline = 0,
) {
  const title = String(row?.title ?? "").trim();
  if (!title || !row?.manga_id) return [];
  const mangaUrl = normalizeSourceUrl(row?.direct_series_url || "") || `${SECONDARY_PUBLIC_BASE}/series/${row.manga_id}`;
  const now = Date.now();

  const isPriority = shouldPrioritizeSecondaryEntry({ title, mangaUrl }, preferredMatcher);
  if (!isPriority) {
    metrics.detailSkippedNonPriority = (metrics.detailSkippedNonPriority || 0) + 1;
    return [];
  }

  if (row?.__directFallback) {
    let resRow = row;
    const chs: any[] = await fetchSecondaryRecentChapters(apiBase, row.manga_id, redis, lookbackHours, deadline);
    if (!chs.length) return [];

    if (!resRow.title || /^unknown title$/i.test(resRow.title) || resRow.status === null) {
      const full = await fetchSecondaryFullMangaInfo(apiBase, row.manga_id, deadline);
      const d = full.meta;
      resRow = { ...resRow, title: d?.title || resRow.title, status: d?.status ?? resRow.status, cover_image_url: d?.cover_image_url || resRow.cover_image_url };
    }
    return transformChapterResults(resRow, chs as any, seen, normalized, mangaUrl, now, lookbackHours);
  }

  if (detailState.circuitOpen) {
    return transformChapterResults(row, getFallbackChapters(row, now, lookbackHours) as any, seen, normalized, mangaUrl, now, lookbackHours);
  }

  const useDetail = shouldFetchDetail(row, isPriority, detailState.count, detailState.circuitOpen, now);
  let chapters: any[] | null = null;
  if (useDetail && claimDetailSlot(detailState)) {
    chapters = await fetchDetailChapters(apiBase, row.manga_id, redis, metrics, detailState, normalized, lookbackHours, deadline);
    releaseDetailSlot(detailState);
  }

  if (!chapters) chapters = getFallbackChapters(row, now, lookbackHours);

  return transformChapterResults(row, chapters as SecondaryChapterRow[], seen, normalized, mangaUrl, now, lookbackHours);
}

export interface ScrapeSecondaryOptions {
  preferredMatcher?: PreferredSecondaryMatcher | null;
  redis?: RedisClient | null;
  options?: { force?: boolean; fullRefresh?: boolean; skipExpansion?: boolean; [key: string]: unknown };
  deadline?: number;
}

export async function scrapeSecondaryUpdatesWithMeta(
  source = "shinigami",
  { preferredMatcher = null, redis = null, options = {}, deadline = 0 }: ScrapeSecondaryOptions = {},
) {
  if (!API_BASE) return { 
    results: [], 
    state: { status: "error", error: "API_BASE missing", count: 0, metrics: createInitialMetrics() } 
  };
  const lookbackHours = options.force || options.fullRefresh ? 168 : SCRAPER_LOOKBACK_HOURS;
  const normalized = normalizeSource(source);
  const metrics = createInitialMetrics();
  const seen = new Set<string>();
  const detailState: DetailState = { count: 0, circuitOpen: false };

  try {
    const typesToFetch = normalized === "shinigami" ? (["project", "mirror"] as const) : ([normalized === "mirror" ? "mirror" : "project"] as const);
    const updateRows: SecondaryMangaRow[] = [];
    
    for (const type of typesToFetch) {
      if (deadline > 0 && Date.now() >= deadline - 2000) break;
      const rows = await fetchUpdateList(API_BASE, type as any, deadline, lookbackHours);
      updateRows.push(...rows);
    }

    const existingIds = new Set(updateRows.map(r => String(r?.manga_id || "")).filter(Boolean));
    const directFallbackRows = await selectRotatingDirectFallbackRows(buildDirectUrlFallbackRows(preferredMatcher, existingIds), 50, redis, normalized);

    const allRowsToProcess = [...updateRows, ...directFallbackRows] as SecondaryMangaRow[];
    
    const priorityRows = filterPriorityRows(allRowsToProcess, preferredMatcher);
    const skippedCount = allRowsToProcess.length - priorityRows.length;
    metrics.detailSkippedNonPriority = (metrics.detailSkippedNonPriority || 0) + skippedCount;

    let dynamicMaxRows = 60; // Increased base limit
    if (deadline > 0) {
      const timeRemaining = deadline - Date.now();
      if (timeRemaining > 20000) dynamicMaxRows = 100; // High limit for whitelisted items
      else if (timeRemaining > 10000) dynamicMaxRows = 60;
      else if (timeRemaining > 5000) dynamicMaxRows = 25;
      else dynamicMaxRows = 10;
    } else {
      dynamicMaxRows = 100;
    }

    const { capped: cappedRows, wasCapped: rowsCapped, originalCount } = capRows(
      priorityRows,
      dynamicMaxRows,
      (msg, meta) => logger.warn(meta, msg),
    );

    const concurrency = globalAdaptiveLimiter.getConcurrency();
    const limit = pLimit(concurrency);
    
    const tasks = cappedRows.map((row: SecondaryMangaRow) => limit(() => processRow(row, API_BASE, redis, metrics, detailState, seen, preferredMatcher, normalized, lookbackHours, deadline)));

    const results = (await Promise.all(tasks)).flat();

    if (options.fullRefresh && !options.skipExpansion) {
      const processed = new Set(results.map((r: ChapterItem) => normalizeTitleKey(r.title)));
      const missing = Array.from((preferredMatcher?.titleKeys as Set<string>) || []).filter(tk => !processed.has(tk));
      const cappedMissing = capExpansionSearches(missing, DEFAULT_SECONDARY_OPTIONS.maxExpansionSearches);

      if (cappedMissing.length) {
        const expTasks = cappedMissing.map(tk => limit(async () => {
          const s = await searchShngm(tk as string, source, deadline);
          if (s.success && s.data?.[0]) {
            return processRow(
              { manga_id: parseSeriesIdFromUrl(s.data[0].mangaUrl ?? null)!, title: s.data[0].title, __directFallback: true } as any,
              API_BASE,
              redis,
              metrics,
              detailState,
              seen,
              preferredMatcher,
              normalized,
              lookbackHours,
              deadline
            );
          }
          return [];
        }));
        results.push(...(await Promise.all(expTasks)).flat());
      }
    }

    const state: SourceState = {
      status: "healthy",
      count: results.length,
      error: null,
      metrics,
    };

    return { results, state };
  } catch (err: unknown) {
    const errMessage = err instanceof Error ? err.message : String(err);
    const errCode = classifyScraperError(err);
    return { 
      results: [], 
      state: { status: "error", error: errMessage, errCode, count: 0, metrics } 
    };
  }
}
