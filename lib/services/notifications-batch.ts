/**
 * Batch subscriber lookup utilities
 * Replaces N+1 query pattern with efficient batch lookups
 */

import { RedisClient } from "../types.js";
import { normalizeTitleKey } from "../domain.js";
import { arrayUnique, arrayUnion } from "../utils.js";
import { getLogger } from "../logger.js";
import { supabase } from "../supabase.js";
import {
  MANGA_SUBSCRIBERS_SET_PREFIX,
  USER_ALL_MODE_SET_KEY,
  MANGA_MUTES_SET_PREFIX
} from "../constants/redis.js";

const logger = getLogger({ scope: "notifications:batch" });

const SUBSCRIBERS_SET = MANGA_SUBSCRIBERS_SET_PREFIX;
const ALL_MODE_SET = USER_ALL_MODE_SET_KEY;
const MUTES_SET = MANGA_MUTES_SET_PREFIX;

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

    // 1. Queue all subscribers checks
    for (const key of subscriberKeys) {
      pipeline.exists(key);
      pipeline.smembers(key);
    }
    // 2. Queue all_mode check
    pipeline.exists(ALL_MODE_SET);
    pipeline.smembers(ALL_MODE_SET);
    // 3. Queue all mute checks
    for (const key of muteKeys) {
      pipeline.exists(key);
      pipeline.smembers(key);
    }

    const results = await pipeline.exec();
    if (!results || !Array.isArray(results)) {
      return result;
    }

    const titleCount = uniqueTitles.length;
    
    // Parse all_mode
    const allModeExists = Number(results[titleCount * 2]) === 1;
    let allModeUsers = (results[titleCount * 2 + 1] as string[] | null) || [];
    
    if (!allModeExists) {
      try {
        const { data } = await supabase.from("user_all_mode").select("user_id");
        allModeUsers = (data || []).map(r => r.user_id);
        
        const backfillPipeline = redis.pipeline();
        if (allModeUsers.length > 0) backfillPipeline.sadd(ALL_MODE_SET, ...allModeUsers);
        else backfillPipeline.sadd(ALL_MODE_SET, "__empty__");
        backfillPipeline.expire(ALL_MODE_SET, 86400);
        await backfillPipeline.exec();
      } catch (err) {
        logger.warn({ err }, "Failed to backfill all_mode cache");
      }
    }
    allModeUsers = allModeUsers.filter(x => x !== "__empty__");

    // Collect missing subscriber titles
    const missingSubTitles: string[] = [];
    const cachedSubs = new Map<string, string[]>();

    for (let i = 0; i < titleCount; i++) {
      const titleKey = uniqueTitles[i];
      const exists = Number(results[i * 2]) === 1;
      const members = (results[i * 2 + 1] as string[] | null) || [];
      
      if (exists) {
        cachedSubs.set(titleKey, members.filter(x => x !== "__empty__"));
      } else {
        missingSubTitles.push(titleKey);
      }
    }

    // Collect missing mute titles
    const missingMuteTitles: string[] = [];
    const cachedMutes = new Map<string, string[]>();

    const muteStartIndex = titleCount * 2 + 2;
    for (let i = 0; i < titleCount; i++) {
      const titleKey = uniqueTitles[i];
      const exists = Number(results[muteStartIndex + i * 2]) === 1;
      const members = (results[muteStartIndex + i * 2 + 1] as string[] | null) || [];
      
      if (exists) {
        cachedMutes.set(titleKey, members.filter(x => x !== "__empty__"));
      } else {
        missingMuteTitles.push(titleKey);
      }
    }

    // Batch fetch missing subs from Supabase
    if (missingSubTitles.length > 0) {
      try {
        const { data } = await supabase.from("user_follows").select("title_key, user_id").in("title_key", missingSubTitles);
        const fetchedMap = new Map<string, string[]>();
        for (const titleKey of missingSubTitles) {
          fetchedMap.set(titleKey, []);
        }
        if (data) {
          for (const row of data) {
            fetchedMap.get(row.title_key)?.push(row.user_id);
          }
        }
        
        const backfillPipeline = redis.pipeline();
        for (const [titleKey, userIds] of fetchedMap.entries()) {
          cachedSubs.set(titleKey, userIds);
          const key = `${SUBSCRIBERS_SET}${titleKey}`;
          if (userIds.length > 0) backfillPipeline.sadd(key, ...userIds);
          else backfillPipeline.sadd(key, "__empty__");
          backfillPipeline.expire(key, 86400);
        }
        await backfillPipeline.exec();
      } catch (err) {
        logger.error({ err }, "Failed to batch load subscribers from Supabase");
      }
    }

    // Batch fetch missing mutes from Supabase
    if (missingMuteTitles.length > 0) {
      try {
        const { data } = await supabase.from("manga_mutes").select("title_key, user_id").in("title_key", missingMuteTitles);
        const fetchedMap = new Map<string, string[]>();
        for (const titleKey of missingMuteTitles) {
          fetchedMap.set(titleKey, []);
        }
        if (data) {
          for (const row of data) {
            fetchedMap.get(row.title_key)?.push(row.user_id);
          }
        }
        
        const backfillPipeline = redis.pipeline();
        for (const [titleKey, userIds] of fetchedMap.entries()) {
          cachedMutes.set(titleKey, userIds);
          const key = `${MUTES_SET}${titleKey}`;
          if (userIds.length > 0) backfillPipeline.sadd(key, ...userIds);
          else backfillPipeline.sadd(key, "__empty__");
          backfillPipeline.expire(key, 86400);
        }
        await backfillPipeline.exec();
      } catch (err) {
        logger.error({ err }, "Failed to batch load mutes from Supabase");
      }
    }

    // Combine results
    for (let i = 0; i < titleCount; i++) {
      const titleKey = uniqueTitles[i];
      const originalTitle = normalizedMap.get(titleKey)!;

      const subscribers = cachedSubs.get(titleKey) || [];
      const mutes = cachedMutes.get(titleKey) || [];

      // Combine native subs + all_mode, then filter mutes
      const combined = arrayUnique(arrayUnion(subscribers, allModeUsers));
      const muteSet = new Set(mutes);
      const filtered = combined.filter((userId: string) => !muteSet.has(userId));

      result.set(originalTitle, filtered);
    }
  } catch (err: unknown) {
    logger.error(
      { error: (err as Error).message, titleCount: titles.length },
      "batchGetMangaSubscribers failed",
    );
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
