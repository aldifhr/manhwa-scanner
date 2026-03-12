import { LOGS_API_CACHE_KEY, invalidateDashboardCaches } from "./cacheKeys.js";

const CRON_LOG_LIST_KEY = "cron:logs";
const CRON_LOG_LIST_LIMIT = 499;
const CRON_LOG_LIST_TTL = 60 * 60 * 24 * 30;

export function normalizeCronLogEntry(entry = {}) {
  return {
    time: entry.time || new Date().toISOString(),
    tag: entry.tag || "info",
    code: entry.code || null,
    type: entry.type || null,
    source: entry.source || null,
    title: entry.title || null,
    message: String(entry.message || "").trim() || "Unknown log",
  };
}

export async function appendCronLog(redis, entry = {}) {
  if (!redis) return;
  const payload = normalizeCronLogEntry(entry);
  await redis.lpush(CRON_LOG_LIST_KEY, payload);
  await Promise.all([
    redis.ltrim(CRON_LOG_LIST_KEY, 0, CRON_LOG_LIST_LIMIT),
    redis.expire(CRON_LOG_LIST_KEY, CRON_LOG_LIST_TTL),
  ]);
  await invalidateDashboardCaches(redis, [LOGS_API_CACHE_KEY]);
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
