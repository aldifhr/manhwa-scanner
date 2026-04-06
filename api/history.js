import {
  readCronLogs,
  readObjectCache,
  readRecentChapters,
  redis,
  writeObjectCache,
} from "../lib/redis.js";
import { logApiHit } from "../lib/logger.js";
import { prepareAuthorizedGet } from "../lib/api/getEndpoint.js";
import { LOGS_API_CACHE_KEY, RECENT_API_CACHE_KEY } from "../lib/cacheKeys.js";
import { readCronDailyStats } from "../lib/cronLogs.js";
import { LOGS_CACHE_SEC, RECENT_CACHE_SEC } from "../lib/config.js";
import { getTimestampMs, isValidDate } from "../lib/dateUtils.js";

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
      if (
        !isNaN(a.sentAtTime) &&
        !isNaN(b.sentAtTime) &&
        b.sentAtTime !== a.sentAtTime
      ) {
        return b.sentAtTime - a.sentAtTime;
      }
      if (a.sortOrder !== b.sortOrder) {
        return a.sortOrder - b.sortOrder;
      }
      return (
        String(a.item?.title || "").localeCompare(
          String(b.item?.title || ""),
        ) ||
        String(a.item?.chapter || "").localeCompare(
          String(b.item?.chapter || ""),
          undefined,
          { numeric: true },
        )
      );
    })
    .map(({ item }) => item);
}

async function handleRecent(req, res) {
  const prepared = prepareAuthorizedGet(req, res, {
    defaultCacheTtl: RECENT_CACHE_SEC,
    rawCacheTtl: RECENT_CACHE_SEC,
    maxAgeCap: 60,
  });
  if (!prepared) return;
  const { cacheTtl } = prepared;

  try {
    const cached = await readObjectCache(redis, RECENT_API_CACHE_KEY);
    if (cached) return res.status(200).json(cached);

    const raw = await readRecentChapters(redis, 0, 49);
    const items = sortRecentItems(
      raw
        .filter((item) => item?.sentAt && isValidDate(item?.sentAt))
        .map((item) => ({
          ...item,
          sentOrder: Number.isFinite(Number(item?.sentOrder))
            ? Number(item.sentOrder)
            : null,
        })),
    ).slice(0, 20);

    const payload = { items };
    await writeObjectCache(redis, RECENT_API_CACHE_KEY, payload, cacheTtl);
    return res.status(200).json(payload);
  } catch (err) {
    console.error("[recent] Error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
}

async function handleLogs(req, res) {
  const prepared = prepareAuthorizedGet(req, res, {
    defaultCacheTtl: LOGS_CACHE_SEC,
    rawCacheTtl: LOGS_CACHE_SEC,
    maxAgeCap: 60,
  });
  if (!prepared) return;
  const { cacheTtl } = prepared;

  try {
    const cached = await readObjectCache(redis, LOGS_API_CACHE_KEY);
    if (cached) return res.status(200).json(cached);

    const raw = await readCronLogs(redis, 0, 199);
    const dailyStats = await readCronDailyStats(redis, 30);

    const payload = {
      logs: raw.filter(Boolean).map((log) => ({
        time: log?.time || null,
        tag: log?.tag || "info",
        code: log?.code || null,
        type: log?.type || null,
        source: log?.source || null,
        title: log?.title || null,
        count: Number.isFinite(Number(log?.count)) ? Number(log.count) : null,
        failed: Number.isFinite(Number(log?.failed))
          ? Number(log.failed)
          : null,
        message: String(log?.message || "").trim() || "Unknown log",
      })),
      dailyStats,
    };

    await writeObjectCache(redis, LOGS_API_CACHE_KEY, payload, cacheTtl);
    return res.status(200).json(payload);
  } catch (err) {
    console.error("[logs] Error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const endpoint = req.query.endpoint || "recent";

  if (endpoint === "recent") {
    return handleRecent(req, res);
  }

  if (endpoint === "logs") {
    return handleLogs(req, res);
  }

  return res.status(400).json({ error: "Unknown endpoint" });
}
