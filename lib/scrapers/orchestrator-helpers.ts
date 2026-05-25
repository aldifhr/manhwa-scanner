/**
 * Orchestrator Helper Functions
 * Extracted from orchestrator.ts to reduce complexity and improve testability
 */

import { RedisClient, ChapterItem, OrchestrateOptions, SourceHealth } from "../types.js";
import { normalizeSourceUrl, normalizeTitleKey, compactTitleKey, fuzzyTitleSimilarity } from "./shared.js";
import { MANGA_LAST_UPDATES_KEY } from "../constants/redis.js";
import { batchGetMangaMetadata } from "../services/storage.js";
import { getLogger } from "../logger.js";

const logger = getLogger({ scope: "orchestrator:helpers" });

const HIBERNATION_THRESHOLD_DAYS = 10;
const HIBERNATION_WAKE_PROBABILITY = 0.05;
const INCREMENTAL_SKIP_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

export interface PreferredSecondaryMatcher {
  titleKeys: Set<string>;
  urlKeys: Set<string>;
  urlTitleMap: Map<string, string>;
}

/**
 * Get titles that should be hibernated (skipped) based on last update time
 */
export async function getHibernatingTitleKeys(
  redis: RedisClient | null,
  titleKeys: string[],
  options: OrchestrateOptions = {}
): Promise<Set<string>> {
  if (!redis || !titleKeys.length) return new Set();
  if (options.force === true || options.fullRefresh === true) return new Set();

  const nowMs = Date.now();
  const defaultThresholdMs = (options.thresholdDays || HIBERNATION_THRESHOLD_DAYS) * 24 * 60 * 60 * 1000;
  const defaultWakeProb = options.wakeProbability !== undefined ? options.wakeProbability : HIBERNATION_WAKE_PROBABILITY;
  const randomFn = typeof options.randomFn === "function" ? options.randomFn : Math.random;

  const CHUNK_SIZE = 500;
  const timestamps: (string | null)[] = [];
  const metadataList: (any | null)[] = [];
  
  for (let i = 0; i < titleKeys.length; i += CHUNK_SIZE) {
    const chunk = titleKeys.slice(i, i + CHUNK_SIZE);
    
    // Fetch last check timestamp and manga metadata concurrently to save latency
    const [chunkResult, chunkMetaResult] = await Promise.all([
      redis.hmget(MANGA_LAST_UPDATES_KEY, ...chunk),
      batchGetMangaMetadata(redis, chunk).catch(err => {
        logger.warn({ err }, "Failed to batch get manga metadata in hibernation checks");
        return chunk.map(() => null);
      })
    ]);
    
    if (chunkResult) {
      if (!Array.isArray(chunkResult) && typeof chunkResult === "object") {
        const chunkRecord = chunkResult as Record<string, string | null>;
        timestamps.push(...chunk.map(tk => chunkRecord[tk] ?? null));
      } else {
        timestamps.push(...(chunkResult as (string | null)[]));
      }
    } else {
      timestamps.push(...new Array(chunk.length).fill(null));
    }
    
    if (chunkMetaResult) {
      metadataList.push(...chunkMetaResult);
    } else {
      metadataList.push(...new Array(chunk.length).fill(null));
    }
  }

  const skipSet = new Set<string>();
  let completedSkipped = 0;
  let hiatusSkipped = 0;

  for (let i = 0; i < titleKeys.length; i++) {
    const ts = timestamps[i];
    if (!ts) continue;

    const lastUpdateMs = new Date(ts).getTime();
    const meta = metadataList[i];
    const status = String(meta?.status || "").toLowerCase();
    
    let thresholdMs = defaultThresholdMs;
    let wakeProb = defaultWakeProb;

    // ADAPTIVE HIBERNATION HEURISTICS based on manga status
    if (status.includes("tamat") || status.includes("complete") || status.includes("end")) {
      // Completed Series: 30 days threshold, checking only once in 200 runs (0.5% wake chance)
      thresholdMs = 30 * 24 * 60 * 60 * 1000;
      wakeProb = 0.005;
    } else if (status.includes("hiatus") || status.includes("dropped") || status.includes("mute")) {
      // Hiatus/Dropped: 20 days threshold, checking only once in 50 runs (2% wake chance)
      thresholdMs = 20 * 24 * 60 * 60 * 1000;
      wakeProb = 0.02;
    }

    if (nowMs - lastUpdateMs > thresholdMs) {
      if (randomFn() >= wakeProb) {
        skipSet.add(titleKeys[i]);
        if (status.includes("tamat") || status.includes("complete") || status.includes("end")) {
          completedSkipped++;
        } else if (status.includes("hiatus") || status.includes("dropped") || status.includes("mute")) {
          hiatusSkipped++;
        }
      }
    }
  }

  if (skipSet.size > 0) {
    logger.info(
      { 
        hibernatingCount: skipSet.size, 
        totalChecked: titleKeys.length,
        completedSkipped,
        hiatusSkipped,
        activeSkipped: skipSet.size - completedSkipped - hiatusSkipped
      }, 
      "hibernation targets found with status-aware adaptive heuristics"
    );
  }

  return skipSet;
}

export async function applyIncrementalFilter(
  titleKeys: Set<string>,
  redis: RedisClient | null,
  batchGetLastScrapeChecks: (redis: RedisClient, keys: string[]) => Promise<(string | null)[]>
): Promise<Set<string>> {
  if (!redis || titleKeys.size === 0) return titleKeys;

  const titleKeysArray = Array.from(titleKeys);
  
  // Concurrently fetch last checks AND manga metadata to maximize network efficiency
  const [lastChecks, metadataList] = await Promise.all([
    batchGetLastScrapeChecks(redis, titleKeysArray),
    batchGetMangaMetadata(redis, titleKeysArray).catch(err => {
      logger.warn({ err }, "Failed to batch get manga metadata in incremental checks");
      return titleKeysArray.map(() => null);
    })
  ]);

  const now = Date.now();
  const filteredKeys = new Set(titleKeys);
  let adaptiveSkipped = 0;

  for (let i = 0; i < titleKeysArray.length; i++) {
    const lastCheck = lastChecks[i];
    if (!lastCheck) continue;

    const lastCheckTime = Number(lastCheck);
    const meta = metadataList[i];
    
    // Dynamic interval calculation based on last update age
    let skipThresholdMs = INCREMENTAL_SKIP_THRESHOLD_MS; // default 10 minutes
    
    if (meta?.lastUpdated) {
      const lastReleaseMs = new Date(meta.lastUpdated).getTime();
      const ageMs = now - lastReleaseMs;
      
      // ADAPTIVE SCHEDULING HEURISTICS:
      if (ageMs < 2 * 24 * 60 * 60 * 1000) {
        // High frequency releases (updated within 2 days): 10 minutes interval
        skipThresholdMs = 10 * 60 * 1000;
      } else if (ageMs < 7 * 24 * 60 * 60 * 1000) {
        // Moderate frequency releases (updated within 7 days): 1 hour interval
        skipThresholdMs = 60 * 60 * 1000;
      } else if (ageMs < 14 * 24 * 60 * 60 * 1000) {
        // Rare releases (updated within 14 days): 6 hours interval
        skipThresholdMs = 6 * 60 * 60 * 1000;
      } else {
        // Stagnant series (over 14 days): 12 hours interval
        skipThresholdMs = 12 * 60 * 60 * 1000;
      }
    } else {
      // Fallback: If no metadata exists, moderate to 1 hour to save hits
      skipThresholdMs = 60 * 60 * 1000;
    }

    if (now - lastCheckTime < skipThresholdMs) {
      filteredKeys.delete(titleKeysArray[i]);
      adaptiveSkipped++;
    }
  }

  if (filteredKeys.size < titleKeys.size) {
    logger.info(
      {
        total: titleKeys.size,
        scanned: filteredKeys.size,
        skipped: adaptiveSkipped
      },
      "incremental scrape: filtered titles with dynamic adaptive scheduling intervals"
    );
  }

  return filteredKeys;
}

/**
 * Build preferred secondary matcher from titles, urls, and entries
 */
export function buildPreferredSecondaryMatcher(
  titles: string[] = [],
  urls: string[] = [],
  entries: { title: string; url: string }[] = []
): PreferredSecondaryMatcher {
  const normalizedEntries = Array.isArray(entries)
    ? entries
      .map((entry) => ({
        title: String(entry?.title || "").trim(),
        url: normalizeSourceUrl(entry?.url || ""),
      }))
      .filter((entry): entry is { title: string; url: string } => !!(entry.title && entry.url))
    : [];

  const urlTitleMap = new Map(
    normalizedEntries.map((entry) => [entry.url, entry.title])
  );

  return {
    titleKeys: new Set(
      [...(Array.isArray(titles) ? titles : []), ...normalizedEntries.map((e) => e.title)]
        .map((title) => normalizeTitleKey(title))
        .filter((tk): tk is string => !!tk)
    ),
    urlKeys: new Set(
      [...(Array.isArray(urls) ? urls : []), ...normalizedEntries.map((e) => e.url)]
        .map((url) => normalizeSourceUrl(url))
        .filter((uk): uk is string => !!uk)
    ),
    urlTitleMap,
  };
}

/**
 * Check if preferred secondary matcher has any entries
 */
export function hasPreferredSecondaryMatcher(preferredMatcher: PreferredSecondaryMatcher): boolean {
  return Boolean(
    preferredMatcher &&
    (preferredMatcher.titleKeys?.size > 0 || preferredMatcher.urlKeys?.size > 0)
  );
}

/**
 * Filter chapters to only include whitelisted titles/urls
 */
export function filterWhitelistedChapters(
  chapters: ChapterItem[],
  whitelistTitles: Set<string>,
  whitelistUrls: Set<string>
): ChapterItem[] {
  const compactWhitelistTitles = new Set(
    Array.from(whitelistTitles).map(t => compactTitleKey(t))
  );

  return chapters.filter(ch => {
    const rawTitle = ch.title || "";
    const tk = (ch as ChapterItem & { titleKey?: string }).titleKey || normalizeTitleKey(rawTitle);
    const ck = compactTitleKey(rawTitle);
    const uk = normalizeSourceUrl(ch.mangaUrl || "");
    
    // 1. Exact Title Key Match
    if (tk && whitelistTitles.has(tk)) return true;
    
    // 2. Compact Title Match (ignores spaces/symbols)
    if (ck && compactWhitelistTitles.has(ck)) return true;
    
    // 3. URL Match
    if (uk && whitelistUrls.has(uk)) return true;
    
    // 4. Fuzzy Match Fallback (more expensive, but robust)
    for (const wtk of whitelistTitles) {
      if (fuzzyTitleSimilarity(tk, wtk) > 0.95) return true;
    }
    
    return false;
  });
}

/**
 * Filter chapters to only include recent ones (within last N hours)
 */
export function filterRecentChapters(
  chapters: ChapterItem[],
  cutoffHours: number,
  safeParseDate: (date: string | Date | null | undefined) => Date | null,
  isWithinLastHours: (date: Date, hours: number) => boolean
): ChapterItem[] {
  return chapters.filter(ch => {
    if (!ch.updatedTime) return true; // Allow empty time (like from Ikiru)
    const parsedDate = safeParseDate(ch.updatedTime);
    if (!parsedDate) return false;
    const isRecent = isWithinLastHours(parsedDate, cutoffHours);
    if (!isRecent) {
      logger.debug(
        { title: ch.title, chapter: ch.chapter, updatedTime: ch.updatedTime },
        "filtered out stale chapter"
      );
    }
    return isRecent;
  });
}

/**
 * Sort chapters by time, title, and chapter number
 */
export function sortChapters(
  chapters: ChapterItem[],
  getChapterNumber: (chapter: string) => number | null,
  safeParseDate: (date: string | Date | null | undefined) => Date | null
): ChapterItem[] {
  const enrichedChapters = chapters.map((ch: ChapterItem & { _timeCache?: number; _titleCache?: string; _chapterNum?: number }) => {
    const updatedTime = ch.updatedTime;
    return {
      ...ch,
      _timeCache: updatedTime ? safeParseDate(updatedTime)?.getTime() : NaN,
      _titleCache: String(ch.title || "").toLowerCase(),
      _chapterNum: getChapterNumber(String(ch.chapter || "")) || 0,
    };
  });

  enrichedChapters.sort((a, b) => {
    const ta = a._timeCache;
    const tb = b._timeCache;
    const hasTa = Number.isFinite(ta);
    const hasTb = Number.isFinite(tb);

    if (hasTa !== hasTb) return hasTa ? -1 : 1;
    if (hasTa && hasTb && (ta as number) !== (tb as number)) return (ta as number) - (tb as number);

    if (a._titleCache !== b._titleCache) return a._titleCache.localeCompare(b._titleCache);

    return a._chapterNum - b._chapterNum;
  });

  return enrichedChapters.map(({ _timeCache, _titleCache, _chapterNum, ...item }) => item);
}
