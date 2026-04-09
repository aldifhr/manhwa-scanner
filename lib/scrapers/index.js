/**
 * SCRAPERS MODULE - Centralized exports
 */

// Core orchestrator (use these for scraping)
export {
  orchestrateScrapeSources,
  scrapeMangaUpdates,
  scrapeMangaUpdatesWithMeta,
} from "./orchestrator.js";

// Individual source scrapers (advanced use only)
export {
  scrapeIkiruUpdatesWithMeta,
  searchIkiru,
  fetchIkiruRecentChaptersFromLatestPage,
  // @deprecated: kept for transition, avoid new usage.
  fetchRecentChaptersFromMangaPage,
} from "./ikiru.js";

export {
  scrapeSecondarySourceUpdates,
  searchShngm,
  fetchRandomShinigamiManga,
} from "./secondary.js";

// Utilities (for custom implementations)
export {
  baseHeaders,
  getCookie,
  normalizeSource,
  normalizeSourceUrl,
  normalizeTitleKey,
  normalizeText,
  toAbsoluteUrl,
} from "./shared.js";
