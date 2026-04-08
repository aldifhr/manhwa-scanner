/**
 * SCRAPERS MODULE - Centralized exports
 *
 * Structure:
 * - shared.js: Core utilities and helpers
 * - ikiru.js: Ikiru source scraper
 * - secondary.js: Secondary sources (Shinigami, etc.)
 * - orchestrator.js: Scraping coordination and hibernation
 * - cacheWarming.js: Optional cache warming service
 */

// Core exports from orchestrator (main entry point)
export {
  orchestrateScrapeSources,
  scrapeMangaUpdates,
  scrapeMangaUpdatesWithMeta,
} from "./orchestrator.js";

// Individual source scrapers (for advanced use)
export {
  scrapeIkiruUpdatesWithMeta,
  searchIkiru,
  fetchRecentChaptersFromMangaPage,
} from "./ikiru.js";

export {
  scrapeSecondarySourceUpdates,
  searchShngm,
} from "./secondary.js";

// Shared utilities (use sparingly - prefer orchestrator)
export {
  baseHeaders,
  getCookie,
  normalizeSource,
  normalizeSourceUrl,
  normalizeTitleKey,
  normalizeText,
  toAbsoluteUrl,
  shouldPrioritizeSecondaryTitle,
} from "./shared.js";

// Cache warming (optional background service)
export {
  startCacheWarming,
  stopCacheWarming,
  warmCachesIfNeeded,
} from "./cacheWarming.js";
