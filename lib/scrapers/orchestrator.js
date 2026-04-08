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
import { createHash } from "crypto";

// ============ HIBERNATION LOGIC (merged from hibernation.js) ============
const HIBERNATION_THRESHOLD_DAYS = 14;
const HIBERNATION_WAKE_PROBABILITY = 0.05;

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
    const preferredIkiruTitleKeys = new Set(
      (Array.isArray(options?.preferredIkiruTitles)
        ? options.preferredIkiruTitles
        : []
      )
        .map((title) => normalizeTitleKey(title))
        .filter(Boolean),
    );

    const secondarySources = ["shinigami_project", "shinigami_mirror"];
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

    // --- PHASE 7: AUTO-HIBERNATION ---
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
    // --- END PHASE 7 ---

    // --- PHASE 8: INCREMENTAL SCRAPING ---
    // Check which titles were recently scraped to avoid redundant work
    if (options?.incremental !== false && preferredIkiruTitleKeys.size > 0) {
      const titleKeysArray = Array.from(preferredIkiruTitleKeys);
      const lastChecks = await batchGetLastScrapeChecks(titleKeysArray);
      const now = Date.now();
      const skipThresholdMs = 3 * 60 * 1000; // 3 minutes (balance between fresh data and rate limiting)

      for (let i = 0; i < titleKeysArray.length; i++) {
        const lastCheck = lastChecks[i];
        if (lastCheck && now - Number(lastCheck) < skipThresholdMs) {
          preferredIkiruTitleKeys.delete(titleKeysArray[i]);
        }
      }

      if (preferredIkiruTitleKeys.size < titleKeysArray.length) {
        logger.info(
          { skipped: titleKeysArray.length - preferredIkiruTitleKeys.size },
          "incremental scrape: skipped recently checked titles",
        );
      }
    }
    // --- END PHASE 8 ---

    // Helper to create hashed dedupe key (prevents very long keys)
    const buildDedupeKey = (prefix, titleKeys) => {
      const sorted = Array.from(titleKeys).sort().join(",");
      const hash = createHash("md5").update(sorted).digest("hex");
      return `${prefix}:scrape:${hash}`;
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

          // Record scrape timestamps for incremental scraping (regardless of result count)
          await batchSetLastScrapeChecks(Array.from(preferredIkiruTitleKeys));

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
        try {
          // Use dedupedRequest to avoid duplicate scraping (can be disabled for tests)
          const useDedupSecondary = options?.deduplicate !== false;
          let out;

          if (useDedupSecondary) {
            const dedupeKey = buildDedupeKey(source, preferredMatcher.titleKeys);
            out = await dedupedRequest(
              dedupeKey,
              () => scrapeSecondarySourceUpdates(
                source,
                { throwOnError: true, preferredMatcher },
                logger,
              ),
              30000,
            );
          } else {
            out = await scrapeSecondarySourceUpdates(
              source,
              { throwOnError: true, preferredMatcher },
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

    // --- PHASE 9: STABILIZATION ---
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
    logger.error({ err: err.message }, "scrape fatal");
    return {
      items: [],
      sourceStates: {
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
