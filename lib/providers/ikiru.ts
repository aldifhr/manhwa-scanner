import { getLogger } from "../logger.js";
import { MangaProvider } from "./base.js";
import { 
  searchIkiru, 
  scrapeIkiruUpdatesWithMeta, 
  fetchIkiruMetadata
} from "../scrapers/ikiru/index.js";
import { 
  ChapterItem, 
  RedisClient, 
  ProviderResult, 
  MangaMetadata, 
  SourceState 
} from "../types.js";
import { 
  scrapeHtmlTitle, 
  titleFromSlug, 
  extractSlugFromUrl 
} from "../utils/scraping.js";

import { MetricsTracker } from "./metrics.js";

const logger = getLogger({ scope: "provider:ikiru" });
const metricsTracker = new MetricsTracker();

/**
 * Extract fallback title from Ikiru URL slug
 * 
 * @param url - Ikiru manga URL
 * @returns Title extracted from slug or null
 * 
 * @example
 * ```typescript
 * fallbackIkiruTitleFromUrl("https://ikiru.wtf/manga/solo-leveling")
 * // Returns: "Solo Leveling"
 * ```
 */
export function fallbackIkiruTitleFromUrl(url: string): string | null {
  const slug = extractSlugFromUrl(url, "manga");
  return titleFromSlug(slug || "");
}

/**
 * Scrape manga title from Ikiru page
 * 
 * Attempts to extract title from HTML using multiple selectors.
 * Falls back to slug-based title if scraping fails.
 * 
 * @param url - Ikiru manga URL
 * @returns Title and error information
 */
async function scrapeIkiruTitle(url: string): Promise<{ title: string | null; error?: string }> {
  const result = await scrapeHtmlTitle({
    url,
    selectors: [
      "h1.entry-title",
      ".post-title h1",
      "h1.manga-title",
      "h1",
    ],
    fallbackTitle: fallbackIkiruTitleFromUrl(url),
    timeout: 8000,
    retries: 1,
  });

  return {
    title: result.title,
    error: result.error,
  };
}

/**
 * Unified Provider implementation for Ikiru
 */
export const ikiruProvider: MangaProvider = {
  id: "ikiru",
  displayName: "Ikiru",
  priority: 10,

  async initialize(redis: RedisClient) {
    await metricsTracker.load(redis, "ikiru");
  },

  async search(query: string, redis: RedisClient | null): Promise<ProviderResult<ChapterItem[]>> {
    return searchIkiru(query, {}, redis);
  },

  canHandleUrl(url: string): boolean {
    const str = String(url || "").toLowerCase();
    return str.includes("ikiru") && /\/manga\/[^/]+/i.test(str);
  },

  async resolveUrl(url: string): Promise<ProviderResult<{ title: string | null; metadata?: MangaMetadata }>> {
    // 1. Instantly parse title from slug. Extremely fast, zero network overhead, never hangs!
    const fallbackTitle = fallbackIkiruTitleFromUrl(url);
    if (fallbackTitle) {
      return { success: true, data: { title: fallbackTitle } };
    }

    // 2. Fallback to lightweight title scrape
    const { title, error } = await scrapeIkiruTitle(url);
    if (error && !title) {
      return {
        success: false,
        error: { message: error, source: "ikiru" }
      };
    }
    return { success: true, data: { title } };
  },

  async scrapeUpdates(options: {
    redis: RedisClient | null;
    preferredMatcher?: any;
    logger?: any;
    force?: boolean;
    fullRefresh?: boolean;
    skipExpansion?: boolean;
    deadline?: number;
  }): Promise<{ results: ChapterItem[]; state: SourceState }> {
    const { redis, preferredMatcher, logger, ...rest } = options;
    const start = Date.now();
    try {
      const res = await scrapeIkiruUpdatesWithMeta(redis, preferredMatcher, logger, rest);
      const duration = Date.now() - start;
      metricsTracker.record(duration, res.state.status === "ok");
      if (redis) metricsTracker.persist(redis, "ikiru").catch(() => {});
      return res;
    } catch (err) {
      metricsTracker.record(Date.now() - start, false);
      throw err;
    }
  },

  async fetchMetadata(url: string, redis: RedisClient | null): Promise<MangaMetadata | null> {
    const raw = await fetchIkiruMetadata(url, redis);
    if (!raw) return null;

    return {
      title: raw.title || fallbackIkiruTitleFromUrl(url) || "Unknown Title",
      source: "ikiru",
      url,
      cover: raw.cover,
      description: raw.description,
      rating: raw.rating,
      status: raw.status,
      lastUpdated: new Date().toISOString(), // Fallback
      genres: raw.genres
    };
  },

  getMetrics() {
    return metricsTracker.getMetrics();
  }
};
