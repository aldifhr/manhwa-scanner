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
import {
  SOURCE_KEYS,
  buildNextSourceHealthMap,
  getDisabledSources,
  loadSourceHealthMap,
  saveSourceHealthMap,
} from "../services/health.js";

// Module-level cached logger to avoid recreation on every call
const moduleLogger = getLogger({ scope: "scraper" });

// ============ HIBERNATION LOGIC (merged from hibernation.js) ============
// NOTE: Hibernation (PHASE 7) runs BEFORE incremental (PHASE 8)
// This ensures that "woken" titles from hibernation get a chance to be scraped
// (incremental filtering happens after hibernation wake probability)
const HIBERNATION_THRESHOLD_DAYS = 14;
const HIBERNATION_WAKE_PROBABILITY = 0.05;
const INCREMENTAL_SKIP_THRESHOLD_MS = 3 * 60 * 1000; // 3 minutes
const DEFAULT_SECONDARY_METRICS = Object.freeze({
  detailAttempts: 0,
  detailSuccesses: 0,
  detailFallbacks: 0,
  detail429: 0,
  detailSkippedNonPriority: 0,
});

async function getHibernatingTitleKeys(redis, titleKeys, options = {}) {
  if (!redis || !titleKeys.length) return new Set();
  if (options.force === true || options.fullRefresh === true) return new Set();

  const logger = getLogger({ scope: "hibernation" });
  const nowMs = Date.now();
  const thresholdMs = (options.thresholdDays || HIBERNATION_THRESHOLD_DAYS) * 24 * 60 * 60 * 1000;
  const wakeProb = options.wakeProbability !== undefined ? options.wakeProbability : HIBERNATION_WAKE_PROBABILITY;
  const randomFn = typeof options.randomFn === "function" ? options.randomFn : Math.random;

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
      if (randomFn() >= wakeProb) {
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
  return { ...DEFAULT_SECONDARY_METRICS };
}

function buildPreferredSecondaryMatcher(titles = [], urls = [], entries = []) {
  const normalizedEntries = Array.isArray(entries)
    ? entries
      .map((entry) => ({
        title: String(entry?.title || "").trim(),
        url: normalizeSourceUrl(entry?.url || ""),
      }))
      .filter((entry) => entry.title && entry.url)
    : [];

  const urlTitleMap = new Map(
    normalizedEntries.map((entry) => [entry.url, entry.title]),
  );

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
    urlTitleMap,
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
  logger = moduleLogger,
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

  // Declare these outside try so catch can access partial results
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


  let currentHealthMap = {};
  if (redis) {
    currentHealthMap = await loadSourceHealthMap(redis, SOURCE_KEYS);
  }

  try {
    const cooldownSources = getDisabledSources(currentHealthMap, SOURCE_KEYS);
    const optionsDisabled = Array.isArray(options?.disabledSources)
      ? options.disabledSources.map((source) => normalizeSource(source))
      : [];

    const disabledSources = new Set([...cooldownSources, ...optionsDisabled]);
    if (disabledSources.size > 0) {
      moduleLogger.info(
        { disabled: Array.from(disabledSources) },
        "skipping disabled or cooling down sources",
      );
      for (const src of disabledSources) {
        if (sourceStates[src]) {
          sourceStates[src].status = "circuit_break";
          sourceStates[src].error = "Source in cooldown or manually disabled";
        }
      }
    }

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
        options?.preferredSecondaryEntries?.shinigami_project,
      ),
      shinigami_mirror: buildPreferredSecondaryMatcher(
        options?.preferredSecondaryTitles?.shinigami_mirror,
        options?.preferredSecondaryUrls?.shinigami_mirror,
        options?.preferredSecondaryEntries?.shinigami_mirror,
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

    // Apply incremental filter to secondary sources too (both titleKeys and urlKeys)
    for (const source of secondarySources) {
      const matcher = preferredSecondaryMatchersBySource[source];

      // Filter titleKeys
      if (useIncremental && matcher.titleKeys.size > 0) {
        const filtered = await applyIncrementalFilter(
          matcher.titleKeys,
          redis,
          logger,
        );
        matcher.titleKeys = filtered;
      }

      // Filter urlKeys (if any)
      if (useIncremental && matcher.urlKeys.size > 0) {
        const filtered = await applyIncrementalFilter(
          matcher.urlKeys,
          redis,
          logger,
        );
        matcher.urlKeys = filtered;
      }
    }
    // --- END STEP 2 ---

    // Helper to create dedupe key using length-based fingerprint (collision-resistant)
    const buildDedupeKey = (prefix, titleKeys, urlKeys = new Set()) => {
      const sortedTitles = Array.from(titleKeys).sort().join(",");
      const sortedUrls = Array.from(urlKeys).sort().join(",");
      const sorted = `${sortedTitles}||${sortedUrls}`;
      // Create fingerprint: length + first 50 chars + last 50 chars + hash of full string
      // This is safer than simple truncation which can cause collisions
      const len = sorted.length;
      const first = sorted.slice(0, 50);
      const last = len > 50 ? sorted.slice(-50) : "";
      // Simple hash: sum of char codes mod 10000 (not cryptographically secure, but sufficient for dedupe)
      let hash = 0;
      for (let i = 0; i < sorted.length; i++) {
        hash = ((hash << 5) - hash + sorted.charCodeAt(i)) | 0;
      }
      const fingerprint = Math.abs(hash).toString(36).slice(0, 8);
      return prefix + ":scrape:" + len + ":" + first + ":" + last + ":" + fingerprint;
    };

    // Run all sources in parallel
    const [ikiruResult, ...secondaryResults] = await Promise.all([
      // 1. Ikiru Scraper
      (async () => {
        const sourceStart = Date.now();
        try {
          if (disabledSources.has("ikiru")) {
            return {
              results: [],
              state: {
                status: "circuit_break",
                count: 0,
                error: "Source in cooldown or manually disabled",
                metrics: null,
                responseTime: Date.now() - sourceStart,
              },
            };
          }
          const hasIkiruWhitelist = preferredIkiruTitleKeys.size > 0;
          if (!hasIkiruWhitelist) {
            return {
              results: [],
              state: {
                status: "skipped",
                count: 0,
                error: "no whitelist titles (hibernating or empty)",
                metrics: null,
                responseTime: Date.now() - sourceStart,
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
          const ikiruTitleKeysSnapshot = new Set(preferredIkiruTitleKeys);

          if (useDedup) {
            const dedupeKey = buildDedupeKey("ikiru", ikiruTitleKeysSnapshot);
            out = await dedupedRequest(
              dedupeKey,
              () => scrapeIkiruUpdatesWithMeta(
                redis,
                ikiruTitleKeysSnapshot,
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
              ikiruTitleKeysSnapshot,
              logger,
              {
                skipExpansion: !!options?.skipExpansion,
              },
            );
          }

          // Record scrape timestamps AFTER successful scrape (only if we got results or explicit success)
          // This ensures timestamps reflect actual successful data retrieval, not just attempt
          if (out.state?.status !== "error" && ikiruTitleKeysSnapshot.size > 0) {
            await batchSetLastScrapeChecks(Array.from(ikiruTitleKeysSnapshot));
          }

          return {
            results: out.results,
            state: {
              ...out.state,
              responseTime: Date.now() - sourceStart,
            },
          };
        } catch (err) {
          logger.error({ err: err.message }, "ikiru scrape failed");
          return {
            results: [],
            state: {
              status: "error",
              count: 0,
              error: err.message,
              metrics: null,
              responseTime: Date.now() - sourceStart,
            },
          };
        }
      })(),

      // 2. Secondary Scrapers (Shinigami)
      ...secondarySources.map(async (source) => {
        const sourceStart = Date.now();
        const preferredMatcher = preferredSecondaryMatchersBySource[source];
        if (disabledSources.has(source)) {
          return {
            source,
            results: [],
            state: {
              status: "circuit_break",
              count: 0,
              error: "Source in cooldown or manually disabled",
              metrics: buildDefaultSecondaryMetrics(),
              responseTime: Date.now() - sourceStart,
            },
          };
        }
        if (!hasPreferredSecondaryMatcher(preferredMatcher)) {
          return {
            source,
            results: [],
            state: {
              status: "skipped",
              count: 0,
              error: "no whitelist titles",
              metrics: buildDefaultSecondaryMetrics(),
              responseTime: Date.now() - sourceStart,
            },
          };
        }

        try {
          // Use dedupedRequest to avoid duplicate scraping (can be disabled for tests)
          const useDedupSecondary = options?.deduplicate !== false;
          let out;
          const matcherSnapshot = {
            titleKeys: new Set(preferredMatcher.titleKeys),
            urlKeys: new Set(preferredMatcher.urlKeys),
          };

          if (useDedupSecondary) {
            const dedupeKey = buildDedupeKey(
              source,
              matcherSnapshot.titleKeys,
              matcherSnapshot.urlKeys,
            );
            out = await dedupedRequest(
              dedupeKey,
              () => scrapeSecondarySourceUpdates(
                source,
                { preferredMatcher: matcherSnapshot },
                logger,
              ),
              30000,
            );
          } else {
            out = await scrapeSecondarySourceUpdates(
              source,
              { preferredMatcher: matcherSnapshot },
              logger,
            );
          }

          // Record scrape timestamps AFTER successful scrape (consistent with Ikiru)
          // Only record for titleKeys that were actually processed
          if (
            (out?.state?.status === "ok" || (Array.isArray(out?.results) && out.results.length > 0)) &&
            matcherSnapshot.titleKeys.size > 0
          ) {
            const secondaryTitles = Array.from(matcherSnapshot.titleKeys);
            await batchSetLastScrapeChecks(secondaryTitles);
          }

          return {
            source,
            results: out.results,
            state: {
              status: "ok",
              count: out.results.length,
              error: null,
              metrics: out.metrics,
              responseTime: Date.now() - sourceStart,
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
              responseTime: Date.now() - sourceStart,
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
      if (!(res.source in sourceStates)) {
        logger.warn({ source: res.source }, "unknown secondary source state");
        sourceStates[res.source] = res.state;
      } else {
        sourceStates[res.source] = res.state;
      }
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
      const ta = safeParseDate(a.updatedTime)?.getTime();
      const tb = safeParseDate(b.updatedTime)?.getTime();
      const hasTa = Number.isFinite(ta);
      const hasTb = Number.isFinite(tb);

      if (hasTa !== hasTb) return hasTa ? -1 : 1;

      if (hasTa && hasTb && ta !== tb) return ta - tb;

      const titleA = (a.title || "").toLowerCase();
      const titleB = (b.title || "").toLowerCase();
      if (titleA !== titleB) return titleA.localeCompare(titleB);

      // Finally by chapter number if title and timestamp are the same
      return (
        (getChapterNumber(a.chapter) || 0) - (getChapterNumber(b.chapter) || 0)
      );
    });

    logger.info({ count: scrapedChapters.length }, "scrape complete");

    // --- STEP 4: UPDATE SOURCE HEALTH ---
    if (redis) {
      try {
        const nextSourceHealth = buildNextSourceHealthMap({
          sourceKeys: SOURCE_KEYS,
          currentMap: currentHealthMap,
          sourceStates,
          nowIso: new Date().toISOString(),
        });
        await saveSourceHealthMap(redis, nextSourceHealth, SOURCE_KEYS);
      } catch (healthErr) {
        logger.warn({ err: healthErr.message }, "failed to update source health map");
      }
    }

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
// Uses module-level cached logger for performance
export async function scrapeMangaUpdatesWithMeta(redis = null, options = {}) {
  return orchestrateScrapeSources({
    redis,
    options,
    getCookie: getCookieFn,
    scrapeIkiruUpdatesWithMeta: scrapeIkiruFn,
    scrapeSecondarySourceUpdates: scrapeSecondaryFn,
    logger: moduleLogger,
  });
}

export async function scrapeMangaUpdates(redis = null, options = {}) {
  const { items } = await scrapeMangaUpdatesWithMeta(redis, options);
  return items;
}
