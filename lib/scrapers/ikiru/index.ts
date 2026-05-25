import {
  SITE_URL,
  normalizeSource,
  normalizeSourceUrl,
  shouldPrioritizeSecondaryTitle,
  lazyFilterMap,
  classifyScraperError,
} from "../shared.js";
import { parseDateWithFallback, parseLooseRelativeTime } from "../../dateUtils.js";
import { IKIRU_CONFIG } from "../../config.js";
import { RedisClient, ChapterItem, ScraperMetrics, SourceState, ScraperProvider } from "../../types.js";
import { getLogger } from "../../logger.js";
import { runScrapling } from "../../utils/scrapling-bridge.js";

const logger = getLogger({ scope: "ikiru:scraper" });

// --- Scraper Logic ---

export async function fetchIkiruMetadata(mangaUrl: string, _redis: RedisClient | null = null) {
  try {
    const raw = await runScrapling<any>({
      action: "metadata",
      url: mangaUrl,
      baseUrl: SITE_URL
    });

    if (!raw) return null;

    return {
      title: raw.title || null,
      description: raw.description || raw.synopsis || null,
      genres: raw.genres || [],
      status: raw.status || null,
      rating: raw.rating || null,
      cover: raw.cover || null,
    };
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ url: mangaUrl, err: message }, "Failed to fetch Ikiru metadata via Scrapling");
    return null;
  }
}

export async function scrapeIkiruUpdatesWithMeta(
  _redis: RedisClient | null = null,
  _preferredIkiru: { titles: Set<string | null>; urls: Set<string | null> } | Set<string | null> = new Set(),
  _logger: any = null,
  options: { skipExpansion?: boolean; maxPages?: number } = {},
) {
  const { maxPages = IKIRU_CONFIG.MAX_PAGES } = options;
  const sourceState: SourceState = {
    status: "pending",
    count: 0,
    error: null,
    metrics: null,
  };

  try {
    logger.info({ maxPages, baseUrl: `${SITE_URL}latest-update/` }, "Scraping Ikiru latest with pages");
    const rawResults = await runScrapling<any[]>({
      action: "latest",
      baseUrl: `${SITE_URL}latest-update/`,
      maxPages
    });

    const results = rawResults.map(item => ({
      ...item,
      updatedTime: item.updatedTime ? (parseDateWithFallback(item.updatedTime) || parseLooseRelativeTime(item.updatedTime))?.toISOString() : null
    }));

    sourceState.status = "ok";
    sourceState.count = results.length;
    sourceState.metrics = {
      pagesScanned: maxPages,
      stalePageStreak: 0,
      emptyPageStreak: 0,
      maxPages,
      preferredTitles: 0,
      preferredUrls: 0,
      expandedCount: 0,
      expansionSkipped: true
    } as ScraperMetrics;

    return { results, state: sourceState };
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error({ err: error.message }, "[scrapeIkiruUpdatesWithMeta] Scrapling failed");
    
    sourceState.status = "error";
    sourceState.error = error.message;
    sourceState.errCode = classifyScraperError(error);
    
    return { results: [], state: sourceState };
  }
}

export async function searchIkiru(
  query: string,
  _options: Record<string, unknown> = {},
  _redis: RedisClient | null = null,
): Promise<{ success: boolean; data: ChapterItem[] }> {
  const keyword = String(query ?? "").trim();
  if (!keyword) return { success: true, data: [] };

  try {
    const rawResults = await runScrapling<any[]>({
      action: "search",
      query: keyword,
      baseUrl: SITE_URL
    });

    const results = rawResults.map(item => ({
      ...item,
      updatedTime: item.updatedTime ? (parseDateWithFallback(item.updatedTime) || parseLooseRelativeTime(item.updatedTime))?.toISOString() : null
    }));

    return { success: true, data: results };
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error({ query, err: error.message }, "[searchIkiru] Scrapling failed");
    return { success: false, data: [] };
  }
}

export async function fetchIkiruChapters(mangaUrl: string): Promise<ChapterItem[]> {
  try {
    const rawResults = await runScrapling<any[]>({
      action: "expand",
      url: mangaUrl,
      baseUrl: SITE_URL,
      skipMeta: false
    });

    return rawResults.map(item => ({
      ...item,
      description: item.description || item.synopsis || null,
      updatedTime: item.updatedTime ? (parseDateWithFallback(item.updatedTime) || parseLooseRelativeTime(item.updatedTime))?.toISOString() : null
    }));
  } catch (err: unknown) {
    logger.error({ mangaUrl, err: String(err) }, "[fetchIkiruChapters] Scrapling failed");
    return [];
  }
}

// --- Provider Implementation ---

export const IkiruProvider: ScraperProvider = {
  name: "ikiru",

  async scrapeLatest(options: any) {
    return scrapeIkiruUpdatesWithMeta(
      options.redis,
      options.preferred,
      logger as any,
      options
    );
  },

  async search(query: string, options: any = {}) {
    return searchIkiru(query, {}, options.redis);
  },

  async fetchMetadata(mangaUrl: string, options: any = {}) {
    return fetchIkiruMetadata(mangaUrl, options.redis);
  }
};
