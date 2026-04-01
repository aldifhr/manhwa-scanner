import { redis } from "../lib/redis.js";
import { logApiHit } from "../lib/logger.js";
import { prepareAuthorizedGet } from "../lib/api/getEndpoint.js";
import { RECENT_API_CACHE_KEY, LOGS_API_CACHE_KEY } from "../lib/cacheKeys.js";
import { readCronDailyStats } from "../lib/cronLogs.js";
import {
  readCronLogs,
  readObjectCache,
  readRecentChapters,
  writeObjectCache,
} from "../lib/monitorStore.js";

const RECENT_CACHE_SEC = Number(process.env.RECENT_CACHE_SEC || 180);
const LOGS_CACHE_SEC = Number(process.env.LOGS_CACHE_SEC || 300);

export function sortRecentItems(items = []) {
  return [...items].sort((a, b) => {
    const ta = new Date(a?.sentAt).getTime();
    const tb = new Date(b?.sentAt).getTime();
    if (!isNaN(ta) && !isNaN(tb) && tb !== ta) return tb - ta;

    const oa = Number.isFinite(Number(a?.sentOrder)) ? Number(a.sentOrder) : Number.MAX_SAFE_INTEGER;
    const ob = Number.isFinite(Number(b?.sentOrder)) ? Number(b.sentOrder) : Number.MAX_SAFE_INTEGER;
    if (oa !== ob) return oa - ob;

    return (
      String(a?.title || "").localeCompare(String(b?.title || "")) ||
      String(a?.chapter || "").localeCompare(String(b?.chapter || ""), undefined, { numeric: true })
    );
  });
}

async function handleRecent(req, res, reqLogger) {
  const prepared = prepareAuthorizedGet(req, res, {
    defaultCacheTtl: 180,
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
        .filter((item) => item && item.sentAt)
        .filter((item) => !isNaN(new Date(item.sentAt).getTime()))
        .map((item) => ({
          ...item,
          sentOrder: Number.isFinite(Number(item?.sentOrder)) ? Number(item.sentOrder) : null,
        }))
    ).slice(0, 20);

    const payload = { items };
    await writeObjectCache(redis, RECENT_API_CACHE_KEY, payload, cacheTtl);
    return res.status(200).json(payload);
  } catch (err) {
    console.error("[recent] Error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
}

async function handleLogs(req, res, reqLogger) {
  const prepared = prepareAuthorizedGet(req, res, {
    defaultCacheTtl: 300,
    rawCacheTtl: LOGS_CACHE_SEC,
    maxAgeCap: 60,
  });
  if (!prepared) return;
  const { cacheTtl } = prepared;

  try {
    const cached = await readObjectCache(redis, LOGS_API_CACHE_KEY);
    if (cached) return res.status(200).json(cached);

    const raw = await readCronLogs(redis, 0, 49);
    const dailyStats = await readCronDailyStats(redis, 30);
    const payload = {
      logs: raw
        .filter(Boolean)
        .map((log) => ({
          time: log?.time || null,
          tag: log?.tag || "info",
          code: log?.code || null,
          type: log?.type || null,
          source: log?.source || null,
          title: log?.title || null,
          count: Number.isFinite(Number(log?.count)) ? Number(log.count) : null,
          failed: Number.isFinite(Number(log?.failed)) ? Number(log.failed) : null,
          message: log?.message || "-",
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
  const action = req.query.action;
  const reqLogger = logApiHit(`history-${action}`, req);

  if (action === "recent") return handleRecent(req, res, reqLogger);
  if (action === "logs") return handleLogs(req, res, reqLogger);

  return res.status(400).json({ error: "Unknown action" });
}
