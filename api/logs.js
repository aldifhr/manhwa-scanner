import { redis } from "../lib/redis.js";
import { logApiHit } from "../lib/requestLog.js";
import { prepareAuthorizedGet } from "../lib/api/getEndpoint.js";
import { LOGS_API_CACHE_KEY } from "../lib/cacheKeys.js";
import { readCronDailyStats } from "../lib/cronLogs.js";
import {
  readCronLogs,
  readObjectCache,
  writeObjectCache,
} from "../lib/monitorStore.js";

const LOGS_CACHE_SEC = Number(process.env.LOGS_CACHE_SEC || 300);

export default async function handler(req, res) {
  logApiHit("logs", req);

  const prepared = prepareAuthorizedGet(req, res, {
    defaultCacheTtl: 300,
    rawCacheTtl: LOGS_CACHE_SEC,
    maxAgeCap: 60,
  });
  if (!prepared) return;
  const { cacheTtl } = prepared;

  try {
    const cached = await readObjectCache(redis, LOGS_API_CACHE_KEY);
    if (cached) {
      return res.status(200).json(cached);
    }

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
