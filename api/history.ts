import type { Request, Response } from "express";
import { redis } from "../lib/redis.js";
import {
  LOGS_API_CACHE_KEY,
  RECENT_API_CACHE_KEY,
} from "../lib/constants/redis.js";
import {
  readCronLogs,
  readObjectCache,
  readRecentChapters,
  writeObjectCache,
} from "../lib/services/storage.js";
import { logApiError, logApiHit, logApiOk } from "../lib/logger.js";
import { prepareAuthorizedGet } from "../lib/api/response.js";
import { readCronDailyStats } from "../lib/cronLogs.js";
import { LOGS_CACHE_SEC, RECENT_CACHE_SEC } from "../lib/config.js";
import { getTimestampMs } from "../lib/dateUtils.js";
import {
  createErrorResponse,
  createSuccessResponse,
} from "../lib/api/response.js";
import { CronLogEntry, DiscordEmbedData } from "../lib/types.js";

// Limits for recent chapters fetch/display
const RECENT_FETCH_LIMIT = 50;
const RECENT_DISPLAY_LIMIT = 20;

// Limits for logs
const LOGS_FETCH_LIMIT = 200;
const LOGS_DISPLAY_LIMIT = 100;

/**
 * Sorts recent chapters by time and display order.
 */
export function sortRecentItems(items: DiscordEmbedData[] = []): DiscordEmbedData[] {
  return [...items].sort((a, b) => {
    const timeA = getTimestampMs(a.sentAt || a.enqueuedAt || 0);
    const timeB = getTimestampMs(b.sentAt || b.enqueuedAt || 0);
    
    if (timeA !== timeB) return timeB - timeA;
    
    const orderA = Number(a.sentOrder ?? 999);
    const orderB = Number(b.sentOrder ?? 999);
    if (orderA !== orderB) return orderA - orderB;

    return (a.title || "").localeCompare(b.title || "");
  });
}

async function handleRecent(req: Request, res: Response, reqLogger: any) {
  const prepared = await prepareAuthorizedGet(req, res, {
    defaultCacheTtl: RECENT_CACHE_SEC,
    rawCacheTtl: RECENT_CACHE_SEC,
    maxAgeCap: 60,
  });
  if (!prepared) return;
  const { cacheTtl } = prepared;

  try {
    const cached = await readObjectCache(redis, RECENT_API_CACHE_KEY);
    if (cached) {
      logApiOk(reqLogger, { status: 200, cached: true });
      return res.status(200).json(createSuccessResponse(cached));
    }

    const raw = await readRecentChapters(redis, 0, RECENT_FETCH_LIMIT - 1);
    const validItems = (raw as DiscordEmbedData[]).filter(item => item?.sentAt || item?.enqueuedAt);
    const sorted = sortRecentItems(validItems).slice(0, RECENT_DISPLAY_LIMIT);

    const payload = { items: sorted, fetched: raw.length, displayed: sorted.length };
    await writeObjectCache(redis, RECENT_API_CACHE_KEY, payload, cacheTtl);
    logApiOk(reqLogger, { status: 200, cached: false, count: sorted.length });
    return res.status(200).json(createSuccessResponse(payload));
  } catch (err: unknown) {
    logApiError(reqLogger, err, { status: 500 });
    return res.status(500).json(createErrorResponse("RECENT_FETCH_FAILED", err instanceof Error ? err.message : String(err)));
  }
}

async function handleLogs(req: Request, res: Response, reqLogger: any) {
  const prepared = await prepareAuthorizedGet(req, res, {
    defaultCacheTtl: LOGS_CACHE_SEC,
    rawCacheTtl: LOGS_CACHE_SEC,
    maxAgeCap: 60,
  });
  if (!prepared) return;
  const { cacheTtl } = prepared;

  try {
    const cached = await readObjectCache(redis, LOGS_API_CACHE_KEY);
    if (cached) {
      logApiOk(reqLogger, { status: 200, cached: true });
      return res.status(200).json(createSuccessResponse(cached));
    }

    const raw = await readCronLogs(redis, 0, LOGS_FETCH_LIMIT - 1);
    const dailyStats = await readCronDailyStats(redis, 30);

    const logs = (raw as CronLogEntry[])
      .filter(Boolean)
      .slice(0, LOGS_DISPLAY_LIMIT)
      .map(log => ({
        timestamp: log.timestamp || log.time || null,
        tag: log.tag || "info",
        code: log.code || null,
        type: log.type || null,
        source: log.source || null,
        title: String(log.title || "").trim() || null,
        count: Number.isFinite(log.count) ? log.count : null,
        failed: Number.isFinite(log.failed) ? log.failed : null,
        message: log.message || "Unknown log",
      }));

    const payload = { logs, dailyStats, totalLogs: raw.length, displayedLogs: logs.length };
    await writeObjectCache(redis, LOGS_API_CACHE_KEY, payload, cacheTtl);
    logApiOk(reqLogger, { status: 200, cached: false, count: raw.length });
    return res.status(200).json(createSuccessResponse(payload));
  } catch (err: unknown) {
    logApiError(reqLogger, err, { status: 500 });
    return res.status(500).json(createErrorResponse("LOGS_FETCH_FAILED", err instanceof Error ? err.message : String(err)));
  }
}

export default async function handler(req: Request, res: Response) {
  const reqLogger = logApiHit("history", req);

  // Apply Serverless Rate Limiting
  const ip = req.headers["x-real-ip"] || req.headers["x-forwarded-for"] || req.ip || "unknown";
  const clientIp = Array.isArray(ip) ? ip[0] : ip;
  try {
    const { rateLimiters } = await import("../lib/rateLimiter.js");
    await rateLimiters.standard.consume(clientIp);
  } catch (err: any) {
    logApiOk(reqLogger, { status: 429, reason: "rate_limited" });
    return res.status(429).json(createErrorResponse("TOO_MANY_REQUESTS", "Rate limit exceeded. Please try again later."));
  }

  if (req.method !== "GET") {
    logApiOk(reqLogger, { status: 405, reason: "method_not_allowed" });
    return res.status(405).json(createErrorResponse("METHOD_NOT_ALLOWED", "Method not allowed"));
  }

  const endpoint = String(req.query.endpoint || req.query.action || "recent");

  if (endpoint === "recent") return handleRecent(req, res, reqLogger);
  if (endpoint === "logs") return handleLogs(req, res, reqLogger);

  logApiOk(reqLogger, { status: 400, reason: "unknown_endpoint" });
  return res.status(400).json(createErrorResponse("UNKNOWN_ENDPOINT", "Unknown endpoint"));
}
