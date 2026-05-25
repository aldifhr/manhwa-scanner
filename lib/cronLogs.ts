import {
  LOGS_API_CACHE_KEY,
  CRON_LOG_LIST_KEY,
  CRON_LOG_THROTTLE_KEY_PREFIX,
  CRON_DAILY_STATS_MASTER_KEY,
} from "./constants/redis.js";
import {
  invalidateDashboardCaches,
} from "./services/storage.js";
import { RedisClient, CronLogEntry } from "./types.js";
import { env } from "./config/env.js";
import { supabase } from "./supabase.js";
import { normalizeCronLogEntry } from "./utils/log-helpers.js";
export { normalizeCronLogEntry };


const CRON_LOG_LIST_LIMIT = env.CRON_LOG_LIST_LIMIT;
const CRON_LOG_LIST_TTL = env.CRON_LOG_LIST_TTL;
const CRON_DAILY_STATS_TTL = env.CRON_DAILY_STATS_TTL;

/**
 * Appends a log entry to both Redis and Supabase.
 */

function formatDateKey(rawTime: string | number | Date | null = null): string {
  const value = rawTime ? new Date(rawTime) : new Date();
  if (Number.isNaN(value.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }
  return value.toISOString().slice(0, 10);
}

interface TimestampContainer {
  timestamp?: string;
  time?: string;
  createdAt?: string;
}

function isTimestampContainer(obj: unknown): obj is TimestampContainer {
  return obj !== null && typeof obj === "object" && !(obj instanceof Date);
}

/**
 * Get the daily stats storage key for a timestamp.
 */
export function cronDailyStatsKey(rawTime: string | number | Date | TimestampContainer | null = null): string {
  let actualTime: string | number | Date | null = null;
  if (isTimestampContainer(rawTime)) {
    actualTime = rawTime.timestamp ?? rawTime.time ?? rawTime.createdAt ?? null;
  } else {
    actualTime = rawTime;
  }
  return formatDateKey(actualTime);
}

export interface CronDailyStats {
  date: string;
  runs: number;
  sentLogs: number;
  partialLogs: number;
  failedLogs: number;
  skippedLogs: number;
  shortCircuits: number;
  chaptersSent: number;
  chaptersSkipped: number;
  deliveryFailed: number;
  raw: Record<string, unknown>;
}

function normalizeStatsRecord(date: string, raw: Record<string, unknown> | null = null): CronDailyStats {
  const input = raw && typeof raw === "object" ? raw : {};
  return {
    date,
    runs: Number(input.events_total || 0),
    sentLogs: Number(input["tag:sent"] || 0),
    partialLogs: Number(input["tag:partial"] || 0),
    failedLogs: Number(input["tag:failed"] || 0),
    skippedLogs: Number(input["tag:skipped"] || 0),
    shortCircuits: Number(input["type:short_circuit"] || 0),
    chaptersSent: Number(input.chapters_sent || 0),
    chaptersSkipped: Number(input.chapters_skipped || 0),
    deliveryFailed: Number(input.delivery_failed || 0),
    raw: input,
  };
}

/**
 * Read historical daily stats.
 */
export async function readCronDailyStats(
  redis: RedisClient,
  days = 30,
  endDate = new Date(),
  includeEmpty = false,
): Promise<CronDailyStats[]> {
  if (!redis) return [];

  const safeDays = Math.max(1, Math.min(90, Math.floor(Number(days) || 30)));
  const end = new Date(endDate);
  if (Number.isNaN(end.getTime())) return [];

  const dates: string[] = [];
  for (let offset = safeDays - 1; offset >= 0; offset -= 1) {
    const date = new Date(end);
    date.setUTCDate(end.getUTCDate() - offset);
    dates.push(formatDateKey(date));
  }

  let masterData: Record<string, string> = {};
  try {
    masterData = (await redis.hgetall(CRON_DAILY_STATS_MASTER_KEY)) as Record<string, string> || {};
  } catch (_err) {
    masterData = {};
  }

  const rows = dates.map((date) => {
    const raw = (masterData as Record<string, unknown>)[date];
    let parsed: Record<string, unknown> = {};
    if (typeof raw === "string") {
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        parsed = {};
      }
    } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      parsed = raw as Record<string, unknown>;
    }
    return normalizeStatsRecord(date, parsed);
  });

  // Hybrid: If some rows are empty (because Redis expired), try to fill from Supabase
  const missingDates = rows.filter(r => r.runs === 0).map(r => r.date);
  if (missingDates.length > 0) {
    try {
      const { data: dbStats } = await supabase
        .from('scraper_stats')
        .select('*')
        .in('date', missingDates);

      if (dbStats && dbStats.length > 0) {
        for (const dbRow of dbStats) {
          const rowIndex = rows.findIndex(r => r.date === dbRow.date);
          if (rowIndex !== -1) {
            rows[rowIndex] = normalizeStatsRecord(dbRow.date, dbRow.raw_data);
          }
        }
      }
    } catch (err) {
      // console.error("[readCronDailyStats] Supabase fallback failed:", err);
    }
  }

  // Background cleanup (fallback for fields without HEXPIRE support)
  try {
    const sevenDaysAgoStr = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    for (const d of Object.keys(masterData)) {
      if (d < sevenDaysAgoStr) {
        // Delete old fields (HEXPIRE should handle this, but cleanup as fallback)
        await redis.hdel(CRON_DAILY_STATS_MASTER_KEY, d);
      }
    }
  } catch { /* ignore cleanup errors */ }

  if (includeEmpty) return rows;

  return rows.filter(
    (row: CronDailyStats) =>
      row.runs > 0 ||
      row.sentLogs > 0 ||
      row.partialLogs > 0 ||
      row.failedLogs > 0 ||
      row.skippedLogs > 0 ||
      row.shortCircuits > 0 ||
      row.chaptersSent > 0 ||
      row.deliveryFailed > 0,
  );
}

function shouldPersistRawCronLog(entry?: Record<string, unknown>): boolean {
  const normalized = normalizeCronLogEntry(entry);
  if (normalized.type === "short_circuit") return true;
  if (["sent", "failed", "partial", "skipped", "info"].includes(normalized.tag || "")) return true;
  if (normalized.code === "cron_fatal") return true;
  return false;
}

/**
 * Increment daily counters for a log entry.
 */
export async function appendCronDailyStats(redis: RedisClient, entry?: Record<string, unknown>): Promise<void> {
  if (!redis) return;
  const payload = normalizeCronLogEntry(entry);
  const key = cronDailyStatsKey(payload.timestamp);
  const increments: [string, number][] = [
    ["events_total", 1],
    [`tag:${payload.tag || "info"}`, 1],
  ];

  if (payload.code) increments.push([`code:${payload.code}`, 1]);
  if (payload.type) increments.push([`type:${payload.type}`, 1]);
  if (payload.source) {
    increments.push([`source:${payload.source}`, 1]);
    if (payload.tag) {
      increments.push([`source:${payload.source}:tag:${payload.tag}`, 1]);
    }
  }

  const count = Number(payload.count);
  if (Number.isFinite(count) && count > 0) {
    increments.push(["chapters_sent", count]);
  }

  const failed = Number(payload.failed);
  if (Number.isFinite(failed) && failed > 0) {
    increments.push(["delivery_failed", failed]);
  }

  const skipped = Number((payload as Record<string, unknown>).skipped);
  if (Number.isFinite(skipped) && skipped > 0) {
    increments.push(["chapters_skipped", skipped]);
  }

  const currentVal: unknown = await redis.hget(CRON_DAILY_STATS_MASTER_KEY, key);
  let next: Record<string, number> = {};
  if (currentVal && typeof currentVal === "string") {
    try {
      const parsed = JSON.parse(currentVal);
      if (parsed !== null && typeof parsed === "object") {
        next = parsed as Record<string, number>;
      }
    } catch {
      // Invalid JSON, start fresh
    }
  } else if (currentVal && typeof currentVal === "object" && !Array.isArray(currentVal)) {
    next = currentVal as Record<string, number>;
  }

  for (const [field, amount] of increments) {
    next[field] = Number(next[field] || 0) + amount;
  }

  await redis.hset(CRON_DAILY_STATS_MASTER_KEY, {
    [key]: JSON.stringify(next),
  });

  // Also sync to Supabase (optimized: we do this asynchronously)
  // In a real production app, we might throttle this or do it in the background
  try {
    const { error } = await supabase.from('scraper_stats').upsert({
      date: key,
      sent: Number(next.chapters_sent || 0),
      skipped: Number(next.chapters_skipped || 0),
      failed: Number(next.chapters_failed || 0),
      scraped: Number(next.events_total || 0),
      raw_data: next,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'date' });
    if (error) throw error;
  } catch (err) {
    // console.error("[appendCronDailyStats] Supabase sync failed:", err);
  }

  // Set TTL per field using HEXPIRE (Redis 7.4+)
  try {
    const ttl = Number(CRON_DAILY_STATS_TTL);
    await redis.expire(CRON_DAILY_STATS_MASTER_KEY, ttl);
  } catch {
    // Fallback cleanup
  }
}

/**
 * Append a permanent log entry and update daily stats.
 */
export async function appendCronLog(redis: RedisClient, entry?: Record<string, unknown>): Promise<boolean> {
  if (!redis) return false;
  const payload = normalizeCronLogEntry(entry);
  await appendCronDailyStats(redis, payload);
  await invalidateDashboardCaches(redis, [LOGS_API_CACHE_KEY]);

  if (!shouldPersistRawCronLog(payload)) return false;

  try {
    // 1. Write to Redis (for live dashboard)
    await redis.lpush(CRON_LOG_LIST_KEY, JSON.stringify(payload));
    await Promise.all([
      redis.ltrim(CRON_LOG_LIST_KEY, 0, CRON_LOG_LIST_LIMIT),
      redis.expire(CRON_LOG_LIST_KEY, CRON_LOG_LIST_TTL),
    ]);

    // 2. Persist to Supabase (for permanent history)
    await supabase.from('cron_logs').insert({
      timestamp: payload.timestamp,
      tag: payload.tag,
      code: payload.code,
      type: payload.type,
      source: payload.source,
      title: payload.title,
      count: payload.count,
      sent: payload.sent,
      skipped: payload.skipped,
      failed_count: payload.failed,
      message: payload.message,
      raw_payload: payload
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[cronLogs] persistence failed: ${msg}`);
    return false;
  }
  return true;
}

function buildThrottleKey(entry?: Record<string, unknown>): string {
  const normalized = normalizeCronLogEntry(entry);
  return [
    CRON_LOG_THROTTLE_KEY_PREFIX,
    normalized.source || "unknown",
    normalized.code || "no_code",
    normalized.type || "no_type",
  ].join(":");
}

/**
 * Append a log entry only if it's not throttled.
 */
export async function appendCronLogThrottled(
  redis: RedisClient,
  entry?: Record<string, unknown>,
  throttleSec = 0,
): Promise<boolean> {
  if (!redis) return false;
  const normalized = normalizeCronLogEntry(entry);
  const safeThrottleSec = Math.max(0, Math.floor(Number(throttleSec) || 0));

  if (safeThrottleSec <= 0) {
    return appendCronLog(redis, normalized);
  }

  const throttleKey = buildThrottleKey(normalized);
  const claimed = await redis.set(throttleKey, normalized.time as string, {
    nx: true,
    ex: safeThrottleSec,
  });

  if (!claimed) {
    // If throttled, we still count the run in daily stats
    await appendCronDailyStats(redis, normalized);
    await invalidateDashboardCaches(redis, [LOGS_API_CACHE_KEY]);
    return false;
  }

  return appendCronLog(redis, normalized);
}

/**
 * Classify error type from message or source.
 */
export function classifyErrorType(message = "", source = ""): string {
  const text = `${message} ${source}`.toLowerCase();
  if (text.includes(" 403") || text.includes("forbidden")) return "discord_403";
  if (text.includes(" 404") || text.includes("not found")) return "discord_404";
  if (text.includes(" 429") || text.includes("rate limit"))
    return "discord_429";
  if (
    text.includes("timeout") ||
    text.includes("timed out") ||
    text.includes("etimedout")
  ) {
    return "source_timeout";
  }
  if (
    text.includes("parse") ||
    text.includes("selector") ||
    text.includes("cheerio")
  ) {
    return "source_parse";
  }
  if (text.includes("redis")) return "redis_error";
  if (text.includes("failed") || text.includes("error")) return "runtime_error";
  return "other_error";
}

interface ErrorWithResponse {
  message?: string;
  response?: { status?: number };
}

function hasResponseProperty(err: unknown): err is ErrorWithResponse {
  return err !== null && typeof err === "object" && "response" in err;
}

/**
 * Build a structured error log entry.
 */
export function buildCronErrorLog(err: Error | ErrorWithResponse | unknown, extra?: Record<string, unknown>): CronLogEntry {
  const safeExtra = extra ?? {};
  let message = "Unknown error";

  if (err instanceof Error) {
    message = err.message;
  } else if (typeof err === "object" && err !== null) {
    const errWithMsg = err as { message?: string };
    message = errWithMsg.message ?? String(err);
  } else {
    message = String(err || "Unknown error");
  }

  let status: number | null = null;
  if (hasResponseProperty(err)) {
    status = err.response?.status ?? null;
  }
  if (status === null) {
    status = (safeExtra.statusCode as number | null) ?? null;
  }

  const source = (safeExtra.source as string | null) ?? null;
  const type = (safeExtra.type as string) || classifyErrorType(message, source || "");

  return normalizeCronLogEntry({
    tag: (safeExtra.tag as string) || "failed",
    code: (safeExtra.code as string) || (status ? `http_${status}` : type),
    type,
    source,
    title: (safeExtra.title as string | null) || null,
    message,
    time: (safeExtra.time as string) || new Date().toISOString(),
  });
}
