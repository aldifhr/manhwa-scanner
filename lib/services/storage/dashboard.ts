import { redis } from "../../redis.js";
import { getLogger } from "../../logger.js";
import { z } from "zod";
import { CronLogEntry, RedisClient, WhitelistEntry, MangaMetadata } from "../../types.js";
import { normalizeCronLogEntry } from "../../utils/log-helpers.js";
import { CronLogEntrySchema, ChapterItemSchema } from "../../schemas.js";
import { validateData } from "../../validation.js";
import {
  CRON_LAST_RUN_KEY,
  SOURCES_HEALTH_KEY,
  RECENT_CHAPTERS_KEY,
  CRON_LOG_LIST_KEY,
  LIVE_EVENTS_KEY,
  NOTIFICATION_QUEUE_KEY,
  HEALTH_RECOMMENDATIONS_KEY,
  HEALTH_LAST_CHECK_KEY,
} from "../../constants/redis.js";
import { loadWhitelist } from "./whitelist.js";
import { batchGetMangaMetadata } from "./metadata.js";
import { supabase } from "../../supabase.js";
import { normalizeTitleKey } from "../../domain.js";

const logger = getLogger({ scope: "storage.dashboard" });

export interface DashboardSnapshot {
  cronStatus: unknown;
  sourceHealth: Record<string, unknown>;
  recommendations: string[];
  lastHealthCheck: string | null;
  recentChapters: unknown[];
  recentLogs: CronLogEntry[];
  liveEvents: unknown[];
  whitelist: WhitelistEntry[];
  whitelistCount: number;
  queueLength: number;
  queueItems: unknown[];
  timestamp: string;
}


export async function readCronLogs(_redisClient: RedisClient, start = 0, stop = 49): Promise<CronLogEntry[]> {
  // Use Supabase for logs to get unlimited history and better reliability
  const limit = Math.max(1, stop - start + 1);
  const { data, error } = await supabase
    .from('cron_logs')
    .select('raw_payload')
    .order('timestamp', { ascending: false })
    .range(start, stop);

  if (error || !data) {
    logger.warn({ error: error?.message }, "Failed to fetch logs from Supabase, falling back to Redis");
    // Fallback to Redis if Supabase fails
    const logs = await _redisClient.lrange(CRON_LOG_LIST_KEY, start, stop);
    if (!logs) return [];
    return (logs as string[])
      .map((l) => {
        const parsed: unknown = typeof l === "string" ? JSON.parse(l) : l;
        const normalized = normalizeCronLogEntry(parsed as Record<string, unknown>);
        return validateData(CronLogEntrySchema, normalized, "cron_log_entry", logger);
      })
      .filter((l): l is CronLogEntry => !!l);
  }

  return data
    .map(d => {
      const normalized = normalizeCronLogEntry(d.raw_payload);
      return validateData(CronLogEntrySchema, normalized, "cron_log_entry", logger);
    })
    .filter((l): l is CronLogEntry => !!l);
}

export async function readRecentChapters(redisClient: RedisClient, start = 0, stop = 49): Promise<unknown[]> {
  const entries = await redisClient.zrange(RECENT_CHAPTERS_KEY, start, stop, { rev: true });
  if (!entries) return [];
  return (entries as string[])
    .map((l) => {
      const p = typeof l === "string" ? JSON.parse(l) : l as Record<string, unknown>;
      const deminified = {
        title: p.title || p.t,
        chapter: p.chapter || p.c,
        url: p.url || p.u,
        cover: p.cover || p.cv,
        source: p.source || p.s,
        updatedTime: p.updatedTime || p.ut,
        sentAt: p.sentAt || p.sa,
        enqueuedAt: p.enqueuedAt || p.ea,
        sentOrder: p.sentOrder || p.so,
        expiresAt: p.expiresAt || p.e,
      };
      const validated = validateData(ChapterItemSchema, deminified, "recent_chapters_item", logger);
      if (!validated) return null;
      return {
        ...validated,
        sentAt: deminified.sentAt,
        enqueuedAt: deminified.enqueuedAt,
        sentOrder: deminified.sentOrder,
        expiresAt: deminified.expiresAt,
      };
    })
    .filter(Boolean);
}

export async function fetchDashboardSnapshot(): Promise<DashboardSnapshot> {
  let results: unknown[] = [null, {}, null, null, [], [], [], 0, []];

  try {
    const pipeline = redis.pipeline();
    pipeline.get(CRON_LAST_RUN_KEY);
    pipeline.hgetall(SOURCES_HEALTH_KEY);
    pipeline.get(HEALTH_RECOMMENDATIONS_KEY);
    pipeline.get(HEALTH_LAST_CHECK_KEY);
    pipeline.zrange(RECENT_CHAPTERS_KEY, 0, 19, { rev: true });
    // pipeline.lrange(CRON_LOG_LIST_KEY, 0, 9); // Removed in favor of Supabase consistency
    pipeline.lrange(LIVE_EVENTS_KEY, 0, 49);
    pipeline.llen(NOTIFICATION_QUEUE_KEY);
    pipeline.lrange(NOTIFICATION_QUEUE_KEY, 0, 49);
    results = await pipeline.exec();
  } catch (err: unknown) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "[fetchDashboardSnapshot] Pipeline execution failed");
  }

  if (!Array.isArray(results) || results.length < 8) {
    logger.warn({ resultsLength: Array.isArray(results) ? results.length : 0 }, "[fetchDashboardSnapshot] Invalid results, using defaults");
    results = [null, {}, null, null, [], [], 0, []];
  }

  let cronStatus = results[0];
  if (typeof cronStatus === "string") {
    try { cronStatus = JSON.parse(cronStatus); } catch { cronStatus = null; }
  }

  const sourceHealth = (results[1] as Record<string, unknown>) || {};

  let recommendationsRaw = results[2];
  if (typeof recommendationsRaw === "string") {
    try { recommendationsRaw = JSON.parse(recommendationsRaw); } catch { recommendationsRaw = []; }
  }
  const recommendations: string[] = Array.isArray(recommendationsRaw) ? recommendationsRaw as string[] : [];

  const lastHealthCheck: string | null = typeof results[3] === "string" ? results[3] : null;

  const recentChapters = ((results[4] as string[]) || [])
    .map((v) => { try { return typeof v === "string" ? JSON.parse(v) : v; } catch { return null; } })
    .filter(Boolean)
    .slice(0, 20);

  // Consistency: Pull logs from Supabase via readCronLogs instead of Redis pipeline
  const parsedRecentLogs = await readCronLogs(redis, 0, 9);

  const liveEvents = ((results[5] as string[]) || [])
    .map((v) => { try { return JSON.parse(v); } catch { return null; } })
    .filter(Boolean);

  const queueLength = (results[6] as number) || 0;
  const queueItems = ((results[7] as string[]) || [])
    .map((v) => { try { return JSON.parse(v); } catch { return null; } })
    .filter(Boolean);

  let whitelist: WhitelistEntry[] = [];
  try {
    whitelist = await loadWhitelist();
    
    // Hydrate whitelist with metadata (covers, etc.)
    const titleKeys = whitelist.map(w => w._normalizedTitle || normalizeTitleKey(w.title));
    const metadata = await batchGetMangaMetadata(redis, titleKeys);
    
    whitelist = whitelist.map((entry, i) => {
      const meta = metadata[i];
      if (meta && meta.cover) {
        return {
          ...entry,
          cover: meta.cover,
          description: meta.description,
          status: meta.status,
          rating: meta.rating
        } as any;
      }
      return entry;
    });
  } catch (err: unknown) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "[fetchDashboardSnapshot] Failed to load whitelist");
  }

  return {
    cronStatus,
    sourceHealth,
    recommendations,
    lastHealthCheck,
    recentChapters,
    recentLogs: parsedRecentLogs,
    liveEvents,
    whitelist,
    whitelistCount: whitelist.length,
    queueLength,
    queueItems,
    timestamp: new Date().toISOString(),
  };
}
