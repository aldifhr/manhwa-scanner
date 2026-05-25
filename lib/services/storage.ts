import { redis } from "../redis.js";
import { getLogger } from "../logger.js";
import {
  RedisClient,
  CronStatus,
  ClaimState,
  SourceHealth,
  ChapterItem,
} from "../types.js";
import {
  CronStatusSchema,
  SourceHealthSchema,
  ChannelValidationStateSchema,
} from "../schemas.js";
import { z } from "zod";
import {
  DISPATCH_HISTORY_KEY,
  CRON_LAST_RUN_KEY,
  SOURCES_HEALTH_KEY,
  LIVE_EVENTS_KEY,
  CHANNEL_HASH_KEY,
  CHANNEL_VALIDATION_STATE_KEY,
} from "../constants/redis.js";
import { BATCH_CLAIM_SCRIPT } from "../redisScripts.js";
import { validateData } from "../validation.js";
import { loadWhitelist, saveWhitelist, invalidateWhitelistCache } from "./storage/whitelist.js";
import { batchGetMangaMetadata, setMangaMetadata, deleteMangaMetadata } from "./storage/metadata.js";
import { supabasePing, syncDailyStatsToSupabase } from "./storage/stats.js";
import { supabase } from "../supabase.js";

export { loadWhitelist, saveWhitelist, invalidateWhitelistCache };
export { batchGetMangaMetadata, setMangaMetadata, deleteMangaMetadata };
export { supabasePing, syncDailyStatsToSupabase };
export { readCronLogs, readRecentChapters, fetchDashboardSnapshot } from "./storage/dashboard.js";

type ChannelValidationState = z.infer<typeof ChannelValidationStateSchema>;

const logger = getLogger({ scope: "storage" });

const LIVE_EVENTS_LIMIT = 50;


export async function invalidateDashboardCaches(
  redisClient: RedisClient,
  keys: string[] = [],
): Promise<void> {
  if (!redisClient || !Array.isArray(keys) || keys.length === 0) return;
  await Promise.all(
    [...new Set(keys)].map((key) => redisClient.del(key)),
  );
}


export async function readObjectCache<T>(redisClient: RedisClient, key: string): Promise<T | null> {
  const cached = await redisClient.get(key);
  if (!cached) return null;
  return typeof cached === "string" ? JSON.parse(cached) : (cached as T);
}

export async function writeObjectCache(
  redisClient: RedisClient,
  key: string,
  payload: unknown,
  cacheTtl: number,
): Promise<void> {
  await redisClient.set(key, JSON.stringify(payload), { ex: cacheTtl });
}

export async function writeCronStatus(redisClient: RedisClient, status: CronStatus): Promise<void> {
  const payload = JSON.stringify(status);
  await redisClient.set(CRON_LAST_RUN_KEY, payload);
}

export async function readCronStatus(redisClient: RedisClient): Promise<CronStatus | null> {
  const data = await redisClient.get(CRON_LAST_RUN_KEY);
  if (!data) return null;
  const parsed = typeof data === "string" ? JSON.parse(data) : data;
  return validateData(CronStatusSchema, parsed, "cron_status", logger);
}

export async function loadSourceHealthSnapshot(
  redisClient: RedisClient,
  keys: string[],
): Promise<Record<string, SourceHealth>> {
  const data = await redisClient.hgetall(SOURCES_HEALTH_KEY);
  if (!data) return {};

  const result: Record<string, SourceHealth> = {};
  for (const key of keys) {
    const raw = data[key];
    if (raw) {
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      const validated = validateData(SourceHealthSchema, parsed, `source_health:${key}`, logger);
      if (validated) result[key] = validated;
    }
  }
  return result;
}


export async function readChannelValidationState(
  redisClient: RedisClient = redis,
): Promise<ChannelValidationState | null> {
  const data = await redisClient.get(CHANNEL_VALIDATION_STATE_KEY);
  if (!data) return null;
  const parsed = typeof data === "string" ? JSON.parse(data) : data;
  return validateData(ChannelValidationStateSchema, parsed, "channel_validation_state", logger);
}

export async function writeChannelValidationState(
  redisClient: RedisClient = redis,
  state: ChannelValidationState,
): Promise<void> {
  await redisClient.set(CHANNEL_VALIDATION_STATE_KEY, JSON.stringify(state), {
    ex: 86400 * 7,
  });
}

export async function appendLiveEvent(
  redisClient: RedisClient,
  event: { message: string; type?: string },
): Promise<boolean> {
  const payload = {
    timestamp: new Date().toISOString(),
    message: String(event.message || "Unknown event").trim(),
    type: event.type || "info",
  };

  try {
    const pipeline = redisClient.pipeline();
    pipeline.lpush(LIVE_EVENTS_KEY, JSON.stringify(payload));
    pipeline.ltrim(LIVE_EVENTS_KEY, 0, LIVE_EVENTS_LIMIT - 1);
    pipeline.expire(LIVE_EVENTS_KEY, 3600 * 24); // 24h TTL
    await pipeline.exec();

    // Persist to Supabase asynchronously with basic error handling
    const supabasePromise = supabase.from('live_events').insert(payload);
    
    // Handle result asynchronously
    supabasePromise.then(({ error }) => {
       if (error) logger.warn({ error: error.message }, "Failed to persist live event to Supabase");
    });

    return true;
  } catch (err: unknown) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Failed to append live event");
    return false;
  }
}

// --- Channel Store ---
export async function getNotificationChannel(guildId: string, redisClient: RedisClient = redis): Promise<string | null> {
  const field = String(guildId);
  
  // 1. Check Redis Cache
  const hashVal = await redisClient.hget(CHANNEL_HASH_KEY, field);
  if (hashVal !== null) return String(hashVal);

  // 2. Check Supabase
  try {
    const { data, error } = await supabase
      .from('guild_settings')
      .select('channel_id')
      .eq('guild_id', field)
      .single();
    
    if (data && !error) {
      // Back-fill Redis
      await redisClient.hset(CHANNEL_HASH_KEY, { [field]: data.channel_id });
      return data.channel_id;
    }
  } catch (err) {
    logger.warn({ err }, "Failed to fetch guild settings from Supabase");
  }

  return null;
}

export async function setNotificationChannel(guildId: string, channelId: string, redisClient: RedisClient = redis): Promise<void> {
  const field = String(guildId);
  const value = String(channelId).trim();
  
  // 1. Write to Supabase
  try {
    const { error } = await supabase
      .from('guild_settings')
      .upsert({ guild_id: field, channel_id: value, updated_at: new Date().toISOString() });
    
    if (error) throw error;
  } catch (err) {
    logger.error({ err }, "Failed to save guild settings to Supabase");
  }

  // 2. Update Redis
  await redisClient.hset(CHANNEL_HASH_KEY, { [field]: value });
  
  // Clear local cache
  channelMapCache = null;
}

export async function deleteGuildChannel(guildId: string, redisClient: RedisClient = redis): Promise<void> {
  const field = String(guildId);
  
  // 1. Delete from Supabase
  try {
    await supabase.from('guild_settings').delete().eq('guild_id', field);
  } catch (err) {
    logger.error({ err }, "Failed to delete guild settings from Supabase");
  }

  // 2. Delete from Redis
  await redisClient.hdel(CHANNEL_HASH_KEY, field);
  
  // Clear local cache
  channelMapCache = null;
}

let channelMapCache: Record<string, string> | null = null;
let channelMapCacheExpiry = 0;

export async function getAllGuildChannels(redisClient: RedisClient = redis): Promise<Record<string, string>> {
  const now = Date.now();
  if (channelMapCache && now < channelMapCacheExpiry) {
    return channelMapCache;
  }

  const hashed = (await redisClient.hgetall(CHANNEL_HASH_KEY)) as Record<string, string>;
  const map = hashed || {};

  channelMapCache = map;
  channelMapCacheExpiry = now + 60000; // 1 minute
  return map;
}

export async function batchGetLastScrapeChecks(_redisClient: RedisClient, titleKeys: string[]): Promise<(string | null)[]> {
  if (!titleKeys?.length) return [];

  try {
    const { data, error } = await supabase
      .from('scrape_history')
      .select('title_key, last_check_at')
      .in('title_key', titleKeys);
    
    if (error) throw error;

    const map = new Map(data.map(d => [d.title_key, new Date(d.last_check_at).getTime().toString()]));
    return titleKeys.map(k => map.get(k) || null);
  } catch (err) {
    logger.warn({ err }, "Failed to fetch scrape history from Supabase");
    return new Array(titleKeys.length).fill(null);
  }
}

export async function batchSetLastScrapeChecks(
  _redisClient: RedisClient,
  titleKeys: string[],
  timestamp: string | number = Date.now(),
): Promise<void> {
  if (!titleKeys?.length) return;
  
  const last_check_at = new Date(timestamp).toISOString();
  const upserts = titleKeys.map(title_key => ({
    title_key,
    last_check_at,
  }));

  try {
    const { error } = await supabase
      .from('scrape_history')
      .upsert(upserts, { onConflict: 'title_key' });
    
    if (error) throw error;
  } catch (err) {
    logger.warn({ err }, "Failed to update scrape history in Supabase");
  }
}

export async function batchClaimPendingChapters(
  redisClient: RedisClient,
  items: { key: string; duplicateKey?: string | null; nowIso: string }[],
  pendingClaimTtl: number,
): Promise<boolean[]> {
  if (!items?.length) return [];

  const nowMs = Date.now();
  const ttlMs = pendingClaimTtl * 1000;

  const pipeline = redisClient.pipeline();
  const payloads = items.map(({ key, duplicateKey, nowIso }) => {
    const payload: ClaimState = {
      status: "pending",
      claimedAt: nowIso,
      sentAt: null,
      expiresAt: nowMs + ttlMs,
    };
    return {
      key,
      duplicateKey: duplicateKey || "",
      json: JSON.stringify(payload),
      nowIso
    };
  });

  payloads.forEach(({ key, duplicateKey, json, nowIso }) => {
    if (typeof pipeline.eval === "function") {
      pipeline.eval(
        BATCH_CLAIM_SCRIPT,
        [DISPATCH_HISTORY_KEY],
        [nowIso, "pending", String(ttlMs), key, duplicateKey || ""]
      );
    } else {
      // Fallback
      pipeline.hsetnx(DISPATCH_HISTORY_KEY, key, json);
    }
  });

  const rawResults = await pipeline.exec();
  const results = (Array.isArray(rawResults) ? rawResults : []).map(
    (res: any) => Number(res) === 1,
  );

  return results;
}
export async function batchCheckDispatchedChapters(chapterUrls: string[]): Promise<Set<string>> {
  if (!chapterUrls.length) return new Set();
  try {
    const { data, error } = await supabase
      .from('dispatch_history')
      .select('chapter_url')
      .in('chapter_url', chapterUrls);
    
    if (error) throw error;
    return new Set(data.map(d => d.chapter_url));
  } catch (err) {
    logger.warn({ err }, "Failed to check dispatch history in Supabase");
    return new Set();
  }
}

export async function recordDispatchToSupabase(chapter: ChapterItem, titleKey: string): Promise<void> {
  try {
    const { error } = await supabase
      .from('dispatch_history')
      .upsert({
        chapter_url: chapter.url,
        title_key: titleKey,
        source: chapter.source,
        chapter_title: chapter.chapter,
        sent_at: new Date().toISOString(),
        metadata: {
          cover: chapter.cover,
          updatedTime: chapter.updatedTime
        }
      });
    
    if (error) throw error;
  } catch (err) {
    logger.error({ err, url: chapter.url }, "Failed to record dispatch to Supabase");
  }
}
