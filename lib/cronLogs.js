import { LOGS_API_CACHE_KEY, invalidateDashboardCaches } from "./cacheKeys.js";

const CRON_LOG_LIST_KEY = "cron:logs";
const CRON_LOG_LIST_LIMIT = Math.max(50, Number(process.env.CRON_LOG_LIST_LIMIT || 300));
const CRON_LOG_LIST_TTL = Math.max(3600, Number(process.env.CRON_LOG_LIST_TTL || 60 * 60 * 24 * 14));
const CRON_LOG_THROTTLE_KEY_PREFIX = "cron:log:throttle";
const CRON_DAILY_STATS_KEY_PREFIX = "cron:stats";
const CRON_DAILY_STATS_TTL = Math.max(
  3600,
  Number(process.env.CRON_DAILY_STATS_TTL || 60 * 60 * 24 * 45),
);

export function normalizeCronLogEntry(entry = {}) {
  return {
    time: entry.time || new Date().toISOString(),
    tag: entry.tag || "info",
    code: entry.code || null,
    type: entry.type || null,
    source: entry.source || null,
    title: entry.title || null,
    count: Number.isFinite(Number(entry.count)) ? Number(entry.count) : null,
    failed: Number.isFinite(Number(entry.failed)) ? Number(entry.failed) : null,
    message: String(entry.message || "").trim() || "Unknown log",
  };
}

function formatDateKey(rawTime = null) {
  const value = rawTime ? new Date(rawTime) : new Date();
  if (Number.isNaN(value.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }
  return value.toISOString().slice(0, 10);
}

export function cronDailyStatsKey(rawTime = null) {
  return `${CRON_DAILY_STATS_KEY_PREFIX}:${formatDateKey(rawTime)}`;
}

function normalizeStatsRecord(date, raw = null) {
  const input = raw && typeof raw === "object" ? raw : {};
  return {
    date,
    runs: Number(input.events_total || 0),
    sentLogs: Number(input["tag:sent"] || 0),
    partialLogs: Number(input["tag:partial"] || 0),
    failedLogs: Number(input["tag:failed"] || 0),
    shortCircuits: Number(input["type:short_circuit"] || 0),
    chaptersSent: Number(input.chapters_sent || 0),
    deliveryFailed: Number(input.delivery_failed || 0),
  };
}

export async function readCronDailyStats(redis, days = 30, endDate = new Date()) {
  if (!redis) return [];

  const safeDays = Math.max(1, Math.min(90, Math.floor(Number(days) || 30)));
  const end = new Date(endDate);
  if (Number.isNaN(end.getTime())) return [];

  const dates = [];
  for (let offset = safeDays - 1; offset >= 0; offset -= 1) {
    const date = new Date(end);
    date.setUTCDate(end.getUTCDate() - offset);
    dates.push(formatDateKey(date));
  }

  const rows = await Promise.all(
    dates.map(async (date) => {
      const key = `${CRON_DAILY_STATS_KEY_PREFIX}:${date}`;
      let raw = null;
      if (typeof redis.hgetall === "function") {
        raw = await redis.hgetall(key).catch(() => ({}));
      } else {
        raw = await redis.get(key).catch(() => null);
      }
      return normalizeStatsRecord(date, raw);
    }),
  );

  return rows.filter((row) =>
    row.runs > 0 ||
    row.sentLogs > 0 ||
    row.partialLogs > 0 ||
    row.failedLogs > 0 ||
    row.shortCircuits > 0 ||
    row.chaptersSent > 0 ||
    row.deliveryFailed > 0,
  );
}

function shouldPersistRawCronLog(entry = {}) {
  const normalized = normalizeCronLogEntry(entry);
  if (normalized.type === "short_circuit") return true;
  if (normalized.tag === "failed" || normalized.tag === "partial") return true;
  if (normalized.code === "cron_fatal") return true;
  return false;
}

async function incrementDailyStatField(redis, key, field, amount) {
  if (!Number.isFinite(amount) || amount === 0) return;

  if (typeof redis.hincrby === "function") {
    await redis.hincrby(key, field, amount);
  }
}

export async function appendCronDailyStats(redis, entry = {}) {
  if (!redis) return;
  const payload = normalizeCronLogEntry(entry);
  const key = cronDailyStatsKey(payload.time);
  const increments = [
    ["events_total", 1],
    [`tag:${payload.tag || "info"}`, 1],
  ];

  if (payload.code) increments.push([`code:${payload.code}`, 1]);
  if (payload.type) increments.push([`type:${payload.type}`, 1]);
  if (payload.source) increments.push([`source:${payload.source}`, 1]);

  const count = Number(payload.count);
  if (Number.isFinite(count) && count > 0) {
    increments.push(["chapters_sent", count]);
  }

  const failed = Number(payload.failed);
  if (Number.isFinite(failed) && failed > 0) {
    increments.push(["delivery_failed", failed]);
  }

  if (typeof redis.hincrby === "function") {
    await Promise.all([
      ...increments.map(([field, amount]) => incrementDailyStatField(redis, key, field, amount)),
      redis.expire(key, CRON_DAILY_STATS_TTL).catch(() => 0),
    ]);
    return;
  }

  const current = await redis.get(key);
  const next = current && typeof current === "object" ? { ...current } : {};
  for (const [field, amount] of increments) {
    next[field] = Number(next[field] || 0) + amount;
  }

  await Promise.all([
    redis.set(key, next),
    redis.expire(key, CRON_DAILY_STATS_TTL).catch(() => 0),
  ]);
}

export async function appendCronLog(redis, entry = {}) {
  if (!redis) return false;
  const payload = normalizeCronLogEntry(entry);
  await appendCronDailyStats(redis, payload);
  await invalidateDashboardCaches(redis, [LOGS_API_CACHE_KEY]);

  if (!shouldPersistRawCronLog(payload)) return false;

  await redis.lpush(CRON_LOG_LIST_KEY, payload);
  await Promise.all([
    redis.ltrim(CRON_LOG_LIST_KEY, 0, CRON_LOG_LIST_LIMIT),
    redis.expire(CRON_LOG_LIST_KEY, CRON_LOG_LIST_TTL),
  ]);
  return true;
}

function buildThrottleKey(entry = {}) {
  const normalized = normalizeCronLogEntry(entry);
  return [
    CRON_LOG_THROTTLE_KEY_PREFIX,
    normalized.source || "unknown",
    normalized.code || "no_code",
    normalized.type || "no_type",
  ].join(":");
}

export async function appendCronLogThrottled(redis, entry = {}, throttleSec = 0) {
  if (!redis) return false;
  const normalized = normalizeCronLogEntry(entry);
  const safeThrottleSec = Math.max(0, Math.floor(Number(throttleSec) || 0));
  if (safeThrottleSec <= 0) {
    return appendCronLog(redis, normalized);
  }

  const throttleKey = buildThrottleKey(normalized);
  const claimed = await redis.set(throttleKey, normalized.time, {
    nx: true,
    ex: safeThrottleSec,
  });
  if (!claimed) return false;

  return appendCronLog(redis, normalized);
}

export function classifyErrorType(message = "", source = "") {
  const text = `${message} ${source}`.toLowerCase();
  if (text.includes(" 403") || text.includes("forbidden")) return "discord_403";
  if (text.includes(" 404") || text.includes("not found")) return "discord_404";
  if (text.includes(" 429") || text.includes("rate limit")) return "discord_429";
  if (text.includes("timeout") || text.includes("timed out") || text.includes("etimedout")) {
    return "source_timeout";
  }
  if (text.includes("parse") || text.includes("selector") || text.includes("cheerio")) {
    return "source_parse";
  }
  if (text.includes("redis")) return "redis_error";
  if (text.includes("failed") || text.includes("error")) return "runtime_error";
  return "other_error";
}

export function buildCronErrorLog(err, extra = {}) {
  const message = err?.message || String(err || "Unknown error");
  const status = err?.response?.status ?? extra.statusCode ?? null;
  const source = extra.source || null;
  const type = extra.type || classifyErrorType(message, source || "");

  return normalizeCronLogEntry({
    tag: extra.tag || "failed",
    code: extra.code || (status ? `http_${status}` : type),
    type,
    source,
    title: extra.title || null,
    message,
    time: extra.time || new Date().toISOString(),
  });
}
