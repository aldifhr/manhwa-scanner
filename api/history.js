import {
  readCronLogs,
  readObjectCache,
  readRecentChapters,
  redis,
  writeObjectCache,
} from "../lib/redis.js";
import { logApiError, logApiHit, logApiOk } from "../lib/logger.js";
import { prepareAuthorizedGet } from "../lib/api/getEndpoint.js";
import { LOGS_API_CACHE_KEY, RECENT_API_CACHE_KEY } from "../lib/cacheKeys.js";
import { readCronDailyStats } from "../lib/cronLogs.js";
import { LOGS_CACHE_SEC, RECENT_CACHE_SEC } from "../lib/config.js";
import { getTimestampMs, isValidDate } from "../lib/dateUtils.js";
import {
  createErrorResponse,
  createSuccessResponse,
} from "../lib/api/response.js";

// Limits for recent chapters fetch/display
const RECENT_FETCH_LIMIT = 50; // Fetch extra to account for filtered items
const RECENT_DISPLAY_LIMIT = 20;

// Limits for logs
const LOGS_FETCH_LIMIT = 200;
const LOGS_DISPLAY_LIMIT = 100; // Limit response to prevent oversized payloads

export function sortRecentItems(items = []) {
  const withSortKey = items.map((item) => {
    const sentAtTime = getTimestampMs(item?.sentAt);
    const sortOrder = Number.isFinite(Number(item?.sentOrder))
      ? Number(item.sentOrder)
      : Number.MAX_SAFE_INTEGER;
    return { item, sentAtTime, sortOrder };
  });

  return withSortKey
    .sort((a, b) => {
      // Primary sort: by sentAtTime (descending)
      if (
        Number.isFinite(a.sentAtTime) &&
        Number.isFinite(b.sentAtTime) &&
        b.sentAtTime !== a.sentAtTime
      ) {
        return b.sentAtTime - a.sentAtTime;
      }
      // Secondary sort: by sortOrder (ascending)
      if (a.sortOrder !== b.sortOrder) {
        return a.sortOrder - b.sortOrder;
      }
      // Tertiary sort: by title (alphabetical)
      const titleCmp = String(a.item?.title || "").localeCompare(
        String(b.item?.title || ""),
      );
      if (titleCmp !== 0) return titleCmp;
      // Final sort: by chapter (numerical)
      return String(a.item?.chapter || "").localeCompare(
        String(b.item?.chapter || ""),
        undefined,
        { numeric: true },
      );
    })
    .map(({ item }) => item);
}

async function handleRecent(req, res, reqLogger) {
  const prepared = prepareAuthorizedGet(req, res, {
    defaultCacheTtl: RECENT_CACHE_SEC,
    rawCacheTtl: RECENT_CACHE_SEC,
    maxAgeCap: 60,
  });
  if (!prepared) return;
  const { cacheTtl } = prepared;

  try {
    // Check cache - note: cache validity is handled by Redis TTL
    const cached = await readObjectCache(redis, RECENT_API_CACHE_KEY);
    if (cached) {
      logApiOk(reqLogger, { status: 200, cached: true });
      return res.status(200).json(createSuccessResponse(cached));
    }

    // Fetch more than needed to account for filtering
    const raw = await readRecentChapters(redis, 0, RECENT_FETCH_LIMIT - 1);
    const items = sortRecentItems(
      raw
        .filter((item) => item?.sentAt && isValidDate(item?.sentAt))
        .map((item) => ({
          ...item,
          sentOrder: Number.isFinite(Number(item?.sentOrder))
            ? Number(item.sentOrder)
            : null,
        })),
    ).slice(0, RECENT_DISPLAY_LIMIT);

    const payload = { items, fetched: raw.length, displayed: items.length };
    await writeObjectCache(redis, RECENT_API_CACHE_KEY, payload, cacheTtl);
    logApiOk(reqLogger, { status: 200, cached: false, count: items.length });
    return res.status(200).json(createSuccessResponse(payload));
  } catch (err) {
    logApiError(reqLogger, err, { status: 500 });
    return res
      .status(500)
      .json(
        createErrorResponse(
          "RECENT_FETCH_FAILED",
          process.env.NODE_ENV === "production" ? "Internal error" : err.message,
        ),
      );
  }
}

async function handleLogs(req, res, reqLogger) {
  const prepared = prepareAuthorizedGet(req, res, {
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

    // Fetch logs and limit response size
    const raw = await readCronLogs(redis, 0, LOGS_FETCH_LIMIT - 1);
    const dailyStats = await readCronDailyStats(redis, 30);

    const payload = {
      logs: raw
        .filter(Boolean)
        .slice(0, LOGS_DISPLAY_LIMIT)
        .map((log) => ({
          time: log?.time || null,
          tag: log?.tag || "info",
          code: log?.code || null,
          type: log?.type || null,
          source: log?.source || null,
          title: String(log?.title || "").trim() || null, // Consistent trimming
          count: Number.isFinite(Number(log?.count)) ? Number(log.count) : null,
          failed: Number.isFinite(Number(log?.failed))
            ? Number(log.failed)
            : null,
          message: String(log?.message || "").trim() || "Unknown log",
        })),
      dailyStats,
      totalLogs: raw.length,
      displayedLogs: Math.min(raw.length, LOGS_DISPLAY_LIMIT),
    };

    await writeObjectCache(redis, LOGS_API_CACHE_KEY, payload, cacheTtl);
    logApiOk(reqLogger, { status: 200, cached: false, count: raw.length });
    return res.status(200).json(createSuccessResponse(payload));
  } catch (err) {
    logApiError(reqLogger, err, { status: 500 });
    return res
      .status(500)
      .json(
        createErrorResponse(
          "LOGS_FETCH_FAILED",
          process.env.NODE_ENV === "production" ? "Internal error" : err.message,
        ),
      );
  }
}

export default async function handler(req, res) {
  const reqLogger = logApiHit("history", req);

  if (req.method !== "GET") {
    logApiOk(reqLogger, { status: 405, reason: "method_not_allowed" });
    return res
      .status(405)
      .json(createErrorResponse("METHOD_NOT_ALLOWED", "Method not allowed"));
  }

  const endpoint = req.query.endpoint || "recent";

  if (endpoint === "recent") {
    return handleRecent(req, res, reqLogger);
  }

  if (endpoint === "logs") {
    return handleLogs(req, res, reqLogger);
  }

  logApiOk(reqLogger, { status: 400, reason: "unknown_endpoint" });
  return res
    .status(400)
    .json(createErrorResponse("UNKNOWN_ENDPOINT", "Unknown endpoint"));
}
