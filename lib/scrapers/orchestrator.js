import { getLogger } from "../logger.js";
import { getHibernatingTitleKeys } from "./hibernation.js";
import {
  getCookie,
  normalizeSource,
  normalizeSourceUrl,
  normalizeTitleKey,
  parseIkiruDatetime,
} from "./shared.js";
import { scrapeIkiruUpdatesWithMeta } from "./ikiru.js";
import { scrapeSecondarySourceUpdates } from "./secondary.js";
import { getChapterNumber } from "../domain.js";


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
      (preferredMatcher.titleKeys?.size > 0 || preferredMatcher.urlKeys?.size > 0),
  );
}

export async function orchestrateScrapeSources({
  redis = null,
  options = {},
  getCookie,
  scrapeIkiruUpdatesWithMeta,
  scrapeSecondarySourceUpdates,
  logger = getLogger({ scope: "scraper" }),
} = {}) {
  if (typeof getCookie !== "function") {
    throw new Error("orchestrateScrapeSources requires getCookie");
  }
  if (typeof scrapeIkiruUpdatesWithMeta !== "function") {
    throw new Error("orchestrateScrapeSources requires scrapeIkiruUpdatesWithMeta");
  }
  if (typeof scrapeSecondarySourceUpdates !== "function") {
    throw new Error("orchestrateScrapeSources requires scrapeSecondarySourceUpdates");
  }

  try {
    const disabledSources = new Set(
      Array.isArray(options?.disabledSources)
        ? options.disabledSources.map((source) => normalizeSource(source))
        : [],
    );
    const preferredIkiruTitleKeys = new Set(
      (Array.isArray(options?.preferredIkiruTitles) ? options.preferredIkiruTitles : [])
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
    const allTitleKeys = Array.from(new Set([
      ...preferredIkiruTitleKeys,
      ...preferredSecondaryMatchersBySource.shinigami_project.titleKeys,
      ...preferredSecondaryMatchersBySource.shinigami_mirror.titleKeys,
    ]));

    const skipTitleKeys = await getHibernatingTitleKeys(redis, allTitleKeys, options);

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

    const sourceStates = {
      ikiru: { status: "pending", count: 0, error: null, metrics: null },
      shinigami_project: { status: "pending", count: 0, error: null, metrics: null },
      shinigami_mirror: { status: "pending", count: 0, error: null, metrics: null },
    };
    const allResults = [];

    // Run all sources in parallel
    const [ikiruResult, ...secondaryResults] = await Promise.all([
      // 1. Ikiru Scraper
      (async () => {
        try {
          const hasIkiruWhitelist = preferredIkiruTitleKeys.size > 0;
          if (!hasIkiruWhitelist) {
            return {
              results: [],
              state: { status: "skipped", count: 0, error: "no whitelist titles (hibernating or empty)", metrics: null }
            };
          }
          if (disabledSources.has("ikiru")) {
            return { 
              results: [], 
              state: { status: "skipped", count: 0, error: "cooldown active", metrics: null } 
            };
          }
          const cookie = await getCookie(redis);
          if (logger) logger.info({ mode: cookie ? "realtime" : "cached", preferredIkiruTitles: preferredIkiruTitleKeys.size }, "ikiru scrape start");
          const out = await scrapeIkiruUpdatesWithMeta(redis, preferredIkiruTitleKeys, logger, {
            skipExpansion: !!options?.skipExpansion,
          });
          return { results: out.results, state: out.state };
        } catch (err) {
          if (logger) logger.error({ err: err.message }, "ikiru scrape failed");
          return {
            results: [],
            state: { status: "error", count: 0, error: err.message, metrics: null }
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
            state: { status: "skipped", count: 0, error: "no whitelist titles", metrics: buildDefaultSecondaryMetrics() }
          };
        }
        if (disabledSources.has(source)) {
          return {
            source,
            results: [],
            state: { status: "skipped", count: 0, error: "cooldown active", metrics: buildDefaultSecondaryMetrics() }
          };
        }
        try {
          const out = await scrapeSecondarySourceUpdates(source, { throwOnError: true, preferredMatcher }, logger);
          return {
            source,
            results: out.results,
            state: { status: "ok", count: out.results.length, error: null, metrics: out.metrics }
          };
        } catch (err) {
          return {
            source,
            results: [],
            state: { status: "error", count: 0, error: err.message, metrics: null }
          };
        }
      })
    ]);

    // Gather Ikiru result
    allResults.push(...ikiruResult.results);
    sourceStates.ikiru = ikiruResult.state;

    // Gather Secondary results
    for (const res of secondaryResults) {
      allResults.push(...res.results);
      sourceStates[res.source] = res.state;
    }

    if (allResults.length > 0) {
      logger.info(
        {
          ikiru: ikiruResult.results.length,
          shinigami: secondaryResults.reduce((acc, r) => acc + r.results.length, 0),
        },
        "all scrapes complete",
      );
    }


    // --- PHASE 8: STABILIZATION ---
    // Sort by timestamp (ascending) + title (alphabetical) + chapter number (ascending) for perfect stability
    allResults.sort((a, b) => {
      const ta = parseIkiruDatetime(a.updatedTime)?.getTime() ?? 0;
      const tb = parseIkiruDatetime(b.updatedTime)?.getTime() ?? 0;
      
      if (ta !== tb) return ta - tb;

      const titleA = (a.title || "").toLowerCase();
      const titleB = (b.title || "").toLowerCase();
      if (titleA !== titleB) return titleA.localeCompare(titleB);
      
      // Terakhir oleh nomor chapter jika judul dan timestamp sama
      return (getChapterNumber(a.chapter) || 0) - (getChapterNumber(b.chapter) || 0);
    });

    logger.info({ count: allResults.length }, "scrape complete");
    return { items: allResults, sourceStates };
  } catch (err) {
    logger.error({ err: err.message }, "scrape fatal");
    return {
      items: [],
      sourceStates: {
        ikiru: { status: "error", count: 0, error: err.message, metrics: null },
        shinigami_project: { status: "error", count: 0, error: err.message, metrics: null },
        shinigami_mirror: { status: "error", count: 0, error: err.message, metrics: null },
      },
    };
  }
}

export async function scrapeMangaUpdatesWithMeta(redis = null, options = {}) {
  return orchestrateScrapeSources({
    redis,
    options,
    getCookie,
    scrapeIkiruUpdatesWithMeta,
    scrapeSecondarySourceUpdates,
    logger: getLogger({ scope: "scraper" }),
  });
}

export async function scrapeMangaUpdates(redis = null, options = {}) {
  const { items } = await scrapeMangaUpdatesWithMeta(redis, options);
  return items;
}

