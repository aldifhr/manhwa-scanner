import { getLogger } from "../logger.js";
import {
  batchGetLastScrapeChecks,
  batchSetLastScrapeChecks,
  dedupedRequest,
} from "../redis.js";
import {
  getCookie as getCookieFn,
  normalizeSource,
  normalizeSourceUrl,
  normalizeTitleKey,
} from "./shared.js";
import { safeParseDate } from "../dateUtils.js";
import { scrapeIkiruUpdatesWithMeta as scrapeIkiruFn } from "./ikiru.js";
import { scrapeSecondarySourceUpdates as scrapeSecondaryFn } from "./secondary.js";
import { getChapterNumber } from "../domain.js";

// Module-level cached logger to avoid recreation on every call
const moduleLogger = getLogger({ scope: "scraper" });

// ============ HIBERNATION LOGIC (merged from hibernation.js) ============
// NOTE: Hibernation (PHASE 7) runs BEFORE incremental (PHASE 8)
// This ensures that "woken" titles from hibernation get a chance to be scraped
// (incremental filtering happens after hibernation wake probability)
const HIBERNATION_THRESHOLD_DAYS = 14;
const HIBERNATION_WAKE_PROBABILITY = 0.05;
const INCREMENTAL_SKIP_THRESHOLD_MS = 3 * 60 * 1000; // 3 minutes

async function getHibernatingTitleKeys(redis, titleKeys, options = {}) {
  if (!redis || !titleKeys.length) return new Set();
  if (options.force === true || options.fullRefresh === true) return new Set();

  const logger = getLogger({ scope: "hibernation" });
  const nowMs = Date.now();
  const thresholdMs = (options.thresholdDays || HIBERNATION_THRESHOLD_DAYS) * 24 * 60 * 60 * 1000;
  const wakeProb = options.wakeProbability !== undefined ? options.wakeProbability : HIBERNATION_WAKE_PROBABILITY;

  let timestamps = await redis.hmget("manga:last_updates", ...titleKeys);

  if (!timestamps) return new Set();
  if (!Array.isArray(timestamps) && typeof timestamps === "object") {
    timestamps = titleKeys.map(tk => timestamps[tk]);
  }

  const skipSet = new Set();
  for (let i = 0; i < titleKeys.length; i++) {
    const ts = timestamps[i];
    if (!ts) continue;

    const lastUpdateMs = new Date(ts).getTime();
    if (nowMs - lastUpdateMs > thresholdMs) {
      if (Math.random() >= wakeProb) {
        skipSet.add(titleKeys[i]);
      }
    }
  }

  if (skipSet.size > 0) {
    logger.info({ hibernatingCount: skipSet.size, totalChecked: titleKeys.length }, "hibernation targets found");
  }

  return skipSet;
}

// Apply incremental scraping filter to title keys
async function applyIncrementalFilter(titleKeys, redis, logger) {
  if (!redis || titleKeys.size === 0) return titleKeys;

  const titleKeysArray = Array.from(titleKeys);
  const lastChecks = await batchGetLastScrapeChecks(titleKeysArray);
  const now = Date.now();
  const filteredKeys = new Set(titleKeys);

  for (let i = 0; i < titleKeysArray.length; i++) {
    const lastCheck = lastChecks[i];
    if (lastCheck && now - Number(lastCheck) < INCREMENTAL_SKIP_THRESHOLD_MS) {
      filteredKeys.delete(titleKeysArray[i]);
    }
  }

  if (filteredKeys.size < titleKeys.size) {
    logger.info(
      { skipped: titleKeys.size - filteredKeys.size },
      "incremental scrape: skipped recently checked titles",
    );
  }

  return filteredKeys;
}

function buildDefaultSecondaryMetrics() {
  return {
    detailAttempts: 0,
    detailSuccesses: 0,
    detailFallbacks: 0,
    detail429: 0,
    detailSkippedNonPriority: 0,
  };
}

function buildPreferredSecondaryMatcher(titles = [], urls = []) {
  return {
    titleKeys: new Set(
      (Array.isArray(titles) ? titles : [])
        .map((title) => normalizeTitleKey(title))
        .filter(Boolean),
    ),
    urlKeys: new Set(
      (Array.isArray(urls) ? urls : [])
        .map((url) => normalizeSourceUrl(url))
        .filter(Boolean),
    ),
  };
}

function hasPreferredSecondaryMatcher(preferredMatcher) {
  return Boolean(
    preferredMatcher &&
    (preferredMatcher.titleKeys?.size > 0 ||
      preferredMatcher.urlKeys?.size > 0),
  );
}

export async function orchestrateScrapeSources({
  redis = null,
  options = {},
  getCookie = getCookieFn,
  scrapeIkiruUpdatesWithMeta = scrapeIkiruFn,
  scrapeSecondarySourceUpdates = scrapeSecondaryFn,
  logger = getLogger({ scope: "scraper" }),
} = {}) {
  if (typeof getCookie !== "function") {
    throw new Error("orchestrateScrapeSources requires getCookie");
  }
  if (typeof scrapeIkiruUpdatesWithMeta !== "function") {
    throw new Error(
      "orchestrateScrapeSources requires scrapeIkiruUpdatesWithMeta",
    );
  }
  if (typeof scrapeSecondarySourceUpdates !== "function") {
    throw new Error(
      "orchestrateScrapeSources requires scrapeSecondarySourceUpdates",
    );
  }

  try {
    const disabledSources = new Set(
      Array.isArray(options?.disabledSources)
        ? options.disabledSources.map((source) => normalizeSource(source))
        : [],
    );
    let preferredIkiruTitleKeys = new Set(
      (Array.isArray(options?.preferredIkiruTitles)
        ? options.preferredIkiruTitles
        : []
      )
        .map((title) => normalizeTitleKey(title))
        .filter(Boolean),
    );

    // Derive secondary sources from matcher keys to ensure consistency
    const preferredSecondaryMatchersBySource = {
      shinigami_project: buildPreferredSecondaryMatcher(
        options?.preferredSecondaryTitles?.shinigami_project,
        options?.preferredSecondaryUrls?.shinigami_project,
      ),
      shinigami_mirror: buildPreferredSecondaryMatcher(
        options?.preferredSecondaryTitles?.shinigami_mirror,
        options?.preferredSecondaryUrls?.shinigami_mirror,
      ),
    };
    const secondarySources = Object.keys(preferredSecondaryMatchersBySource);

    // --- STEP 1: AUTO-HIBERNATION ---
    // Remove titles that haven't updated in >14 days (with 5% wake probability)
    const allTitleKeys = Array.from(
      new Set([
        ...preferredIkiruTitleKeys,
        ...preferredSecondaryMatchersBySource.shinigami_project.titleKeys,
        ...preferredSecondaryMatchersBySource.shinigami_mirror.titleKeys,
      ]),
    );

    const skipTitleKeys = await getHibernatingTitleKeys(
      redis,
      allTitleKeys,
      options,
    );

    if (skipTitleKeys.size > 0) {
      // Filter Ikiru
      for (const tk of skipTitleKeys) {
        preferredIkiruTitleKeys.delete(tk);
      }
      // Filter Secondary Sources
      for (const source of secondarySources) {
        const matcher = preferredSecondaryMatchersBySource[source];
        for (const tk of skipTitleKeys) {
          matcher.titleKeys.delete(tk);
        }
      }
    }
    // --- END STEP 1 ---

    // --- STEP 2: INCREMENTAL SCRAPING ---
    // Skip titles that were scraped within the last 3 minutes (configurable)
    const useIncremental = options?.incremental !== false;

    if (useIncremental && preferredIkiruTitleKeys.size > 0) {
      preferredIkiruTitleKeys = await applyIncrementalFilter(
        preferredIkiruTitleKeys,
        redis,
        logger,
      );
    }

    // Apply incremental filter to secondary sources too
    for (const source of secondarySources) {
      const matcher = preferredSecondaryMatchersBySource[source];
      if (useIncremental && matcher.titleKeys.size > 0) {
        const filtered = await applyIncrementalFilter(
          matcher.titleKeys,
          redis,
          logger,
        );
        matcher.titleKeys = filtered;
      }
    }
    // --- END STEP 2 ---

    // Helper to create simple dedupe key (prefix + sorted title keys, truncated if too long)
    const buildDedupeKey = (prefix, titleKeys) => {
      const sorted = Array.from(titleKeys).sort().join(",");
      // Use first 100 chars of sorted keys to avoid extremely long keys
      const truncated = sorted.length > 100 ? sorted.slice(0, 100) + "..." : sorted;
      return prefix + ":scrape:" + truncated;
    };

    const sourceStates = {
      ikiru: { status: "pending", count: 0, error: null, metrics: null },
      shinigami_project: {
        status: "pending",
        count: 0,
        error: null,
        metrics: null,
      },
      shinigami_mirror: {
        status: "pending",
        count: 0,
        error: null,
        metrics: null,
      },
    };
    const scrapedChapters = [];

    // Run all sources in parallel
    const [ikiruResult, ...secondaryResults] = await Promise.all([
      // 1. Ikiru Scraper
      (async () => {
        try {
          const hasIkiruWhitelist = preferredIkiruTitleKeys.size > 0;
          if (!hasIkiruWhitelist) {
            return {
              results: [],
              state: {
                status: "skipped",
                count: 0,
                error: "no whitelist titles (hibernating or empty)",
                metrics: null,
              },
            };
          }
          if (disabledSources.has("ikiru")) {
            return {
              results: [],
              state: {
                status: "skipped",
                count: 0,
                error: "cooldown active",
                metrics: null,
              },
            };
          }
          const cookie = await getCookie(redis);
          logger.info(
            {
              mode: cookie ? "realtime" : "cached",
              preferredIkiruTitles: preferredIkiruTitleKeys.size,
            },
            "ikiru scrape start",
          );

          // Record scrape timestamps BEFORE dedupedRequest to avoid double-recording
          // when concurrent requests have the same dedupe key
          const titlesToRecord = Array.from(preferredIkiruTitleKeys);
          await batchSetLastScrapeChecks(titlesToRecord);

          // Use dedupedRequest to avoid duplicate scraping for same titles (can be disabled for tests)
          const useDedup = options?.deduplicate !== false;
          let out;

          if (useDedup) {
            const dedupeKey = buildDedupeKey("ikiru", preferredIkiruTitleKeys);
            out = await dedupedRequest(
              dedupeKey,
              () => scrapeIkiruUpdatesWithMeta(
                redis,
                preferredIkiruTitleKeys,
                logger,
                {
                  skipExpansion: !!options?.skipExpansion,
                },
              ),
              30000,
            );
          } else {
            out = await scrapeIkiruUpdatesWithMeta(
              redis,
              preferredIkiruTitleKeys,
              logger,
              {
                skipExpansion: !!options?.skipExpansion,
              },
            );
          }

          return { results: out.results, state: out.state };
        } catch (err) {
          logger.error({ err: err.message }, "ikiru scrape failed");
          return {
            results: [],
            state: {
              status: "error",
              count: 0,
              error: err.message,
              metrics: null,
            },
          };
        }
      })(),

      // 2. Secondary Scrapers (Shinigami)
      ...secondarySources.map(async (source) => {
        const preferredMatcher = preferredSecondaryMatchersBySource[source];
        if (!hasPreferredSecondaryMatcher(preferredMatcher)) {
          return {
            source,
            results: [],
            state: {
              status: "skipped",
              count: 0,
              error: "no whitelist titles",
              metrics: buildDefaultSecondaryMetrics(),
            },
          };
        }
        if (disabledSources.has(source)) {
          return {
            source,
            results: [],
            state: {
              status: "skipped",
              count: 0,
              error: "cooldown active",
              metrics: buildDefaultSecondaryMetrics(),
            },
          };
        }

        // Record scrape timestamps BEFORE dedupedRequest (consistent with Ikiru)
        const secondaryTitles = Array.from(preferredMatcher.titleKeys);
        await batchSetLastScrapeChecks(secondaryTitles);

        try {
          // Use dedupedRequest to avoid duplicate scraping (can be disabled for tests)
          // NOTE: throwOnError is NOT used here (unlike before) - consistent with Ikiru error handling
          const useDedupSecondary = options?.deduplicate !== false;
          let out;

          if (useDedupSecondary) {
            const dedupeKey = buildDedupeKey(source, preferredMatcher.titleKeys);
            out = await dedupedRequest(
              dedupeKey,
              () => scrapeSecondarySourceUpdates(
                source,
                { preferredMatcher },
                logger,
              ),
              30000,
            );
          } else {
            out = await scrapeSecondarySourceUpdates(
              source,
              { preferredMatcher },
              logger,
            );
          }

          return {
            source,
            results: out.results,
            state: {
              status: "ok",
              count: out.results.length,
              error: null,
              metrics: out.metrics,
            },
          };
        } catch (err) {
          // Log error for secondary source (consistent with Ikiru)
          logger.error({ err: err.message, source }, "secondary scrape failed");
          return {
            source,
            results: [],
            state: {
              status: "error",
              count: 0,
              error: err.message,
              metrics: null,
            },
          };
        }
      }),
    ]);

    // Gather Ikiru result
    scrapedChapters.push(...ikiruResult.results);
    sourceStates.ikiru = ikiruResult.state;

    // Gather Secondary results
    for (const res of secondaryResults) {
      scrapedChapters.push(...res.results);
      sourceStates[res.source] = res.state;
    }

    if (scrapedChapters.length > 0) {
      logger.info(
        {
          ikiru: ikiruResult.results.length,
          shinigami: secondaryResults.reduce(
            (acc, r) => acc + r.results.length,
            0,
          ),
        },
        "all scrapes complete",
      );
    }

    // --- STEP 3: STABILIZATION ---
    // Sort by timestamp (ascending) + title (alphabetical) + chapter number (ascending) for perfect stability
    scrapedChapters.sort((a, b) => {
      const ta = safeParseDate(a.updatedTime)?.getTime() ?? 0;
      const tb = safeParseDate(b.updatedTime)?.getTime() ?? 0;

      if (ta !== tb) return ta - tb;

      const titleA = (a.title || "").toLowerCase();
      const titleB = (b.title || "").toLowerCase();
      if (titleA !== titleB) return titleA.localeCompare(titleB);

      // Finally by chapter number if title and timestamp are the same
      return (
        (getChapterNumber(a.chapter) || 0) - (getChapterNumber(b.chapter) || 0)
      );
    });

    logger.info({ count: scrapedChapters.length }, "scrape complete");
    return { items: scrapedChapters, sourceStates };
  } catch (err) {
    // FATAL ERROR: Return partial data that was successfully scraped before the error
    // This prevents throwing away valid data from sources that succeeded
    logger.error({ err: err.message }, "scrape fatal - returning partial data");
    return {
      items: scrapedChapters,
      sourceStates: sourceStates || {
        ikiru: { status: "error", count: 0, error: err.message, metrics: null },
        shinigami_project: {
          status: "error",
          count: 0,
          error: err.message,
          metrics: null,
        },
        shinigami_mirror: {
          status: "error",
          count: 0,
          error: err.message,
          metrics: null,
        },
      },
    };
  }
}

// Main entry point for scraping manga updates
// Uses imported function references to avoid undefined variable issues
export async function scrapeMangaUpdatesWithMeta(redis = null, options = {}) {
  return orchestrateScrapeSources({
    redis,
    options,
    getCookie: getCookieFn,
    scrapeIkiruUpdatesWithMeta: scrapeIkiruFn,
    scrapeSecondarySourceUpdates: scrapeSecondaryFn,
    logger: getLogger({ scope: "scraper" }),
  });
}

export async function scrapeMangaUpdates(redis = null, options = {}) {
  const { items } = await scrapeMangaUpdatesWithMeta(redis, options);
  return items;
}
