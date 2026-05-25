/**
 * Batch subscriber lookup utilities
 * Replaces N+1 query pattern with efficient batch lookups
 */

import { RedisClient } from "../types.js";
import { normalizeTitleKey } from "../domain.js";
import { arrayUnique, arrayUnion } from "../utils.js";
import { getLogger } from "../logger.js";

const logger = getLogger({ scope: "notifications:batch" });

const SUBSCRIBERS_SET = "subscribers:";
const ALL_MODE_SET = "notify:all_mode";
const MUTES_SET = "mutes:";

/**
 * Batch fetch subscribers for multiple titles in one round-trip
 * Replaces N+1 getMangaSubscribers() calls with single pipeline
 */
export async function batchGetMangaSubscribers(
  redis: RedisClient,
  titles: string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();

  if (!titles.length) return result;

  // Normalize and dedupe titles
  const normalizedMap = new Map<string, string>(); // normalized -> original
  const uniqueTitles: string[] = [];

  for (const title of titles) {
    const key = normalizeTitleKey(title);
    if (key && !normalizedMap.has(key)) {
      normalizedMap.set(key, title);
      uniqueTitles.push(key);
    }
  }

  if (!uniqueTitles.length) return result;

  try {
    // Build all Redis keys
    const subscriberKeys = uniqueTitles.map((t) => `${SUBSCRIBERS_SET}${t}`);
    const muteKeys = uniqueTitles.map((t) => `${MUTES_SET}${t}`);

    // Single pipeline for all queries
    const pipeline = redis.pipeline();

    // Queue all smembers calls
    for (const key of subscriberKeys) {
      pipeline.smembers(key);
    }
    // Single all_mode set (same for all)
    pipeline.smembers(ALL_MODE_SET);
    // Queue all mute checks
    for (const key of muteKeys) {
      pipeline.smembers(key);
    }

    const results = await pipeline.exec();
    if (!results || !Array.isArray(results)) {
      return result;
    }

    // Parse results
    // Layout: [sub1, sub2, ..., allMode, mute1, mute2, ...]
    const titleCount = uniqueTitles.length;
    const allModeResult = results[titleCount] as string[] | null; // After all subscriber sets

    for (let i = 0; i < titleCount; i++) {
      const titleKey = uniqueTitles[i];
      const originalTitle = normalizedMap.get(titleKey)!;

      const subscribers = (results[i] as string[] | null) || [];
      const mutes = (results[titleCount + 1 + i] as string[] | null) || [];

      // Combine native subs + all_mode, then filter mutes
      const combined = arrayUnique(arrayUnion(subscribers, allModeResult || []));
      const muteSet = new Set(mutes);
      const filtered = combined.filter((userId: string) => !muteSet.has(userId));

      result.set(originalTitle, filtered);
    }
  } catch (err: unknown) {
    logger.error(
      { error: (err as Error).message, titleCount: titles.length },
      "batchGetMangaSubscribers failed",
    );
    // Return empty map on error (fail safe)
  }

  return result;
}

/**
 * Cache-friendly batch lookup with Map cache support
 */
export async function getSubscribersBatchWithCache(
  redis: RedisClient,
  titles: string[],
  cache: Map<string, string[]>,
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  const missing: string[] = [];

  // Check cache first
  for (const title of titles) {
    const cached = cache.get(title);
    if (cached) {
      result.set(title, cached);
    } else {
      missing.push(title);
    }
  }

  if (!missing.length) return result;

  // Batch fetch missing
  const fetched = await batchGetMangaSubscribers(redis, missing);

  // Populate result and cache
  for (const [title, subscribers] of fetched) {
    result.set(title, subscribers);
    cache.set(title, subscribers);
  }

  return result;
}

/**
 * Stats for batch vs individual lookup comparison
 */
export interface BatchLookupStats {
  uniqueTitles: number;
  totalChapters: number;
  cacheHits: number;
  cacheMisses: number;
  redisCalls: number;
  estimatedIndividualCalls: number;
  savingsPercent: number;
}

/**
 * Calculate batch lookup savings
 */
export function calculateBatchSavings(
  titles: string[],
  cacheHits: number,
): BatchLookupStats {
  const uniqueTitles = new Set(titles.map(normalizeTitleKey)).size;
  const totalChapters = titles.length;
  const cacheMisses = uniqueTitles - cacheHits;

  // Batch: 1 pipeline call (contains all queries)
  const redisCalls = 1;

  // Individual: 3 calls per unique title (subscribers, all_mode, mutes)
  // Note: all_mode is cached after first call, but worst case is 3 per title
  const estimatedIndividualCalls = uniqueTitles * 3;

  const savingsPercent =
    estimatedIndividualCalls > 0
      ? Math.round(((estimatedIndividualCalls - redisCalls) / estimatedIndividualCalls) * 100)
      : 0;

  return {
    uniqueTitles,
    totalChapters,
    cacheHits,
    cacheMisses,
    redisCalls,
    estimatedIndividualCalls,
    savingsPercent,
  };
}
