import { redis } from "../lib/redis.js";
import { logApiHit } from "../lib/requestLog.js";
import { prepareAuthorizedGet } from "../lib/api/getEndpoint.js";
import { LOGS_API_CACHE_KEY } from "../lib/cacheKeys.js";

const LOGS_CACHE_SEC = Number(process.env.LOGS_CACHE_SEC || 120);

export default async function handler(req, res) {
  logApiHit("logs", req);

  const prepared = prepareAuthorizedGet(req, res, {
    defaultCacheTtl: 120,
    rawCacheTtl: LOGS_CACHE_SEC,
    maxAgeCap: 30,
  });
  if (!prepared) return;
  const { cacheTtl } = prepared;

  try {
    const cached = await redis.get(LOGS_API_CACHE_KEY);
    if (cached && typeof cached === "object") {
      return res.status(200).json(cached);
    }

    const raw = await redis.lrange("cron:logs", 0, 49);
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
          message: log?.message || "-",
        })),
    };

    await redis.set(LOGS_API_CACHE_KEY, payload, { ex: cacheTtl }).catch(() => {});
    return res.status(200).json(payload);
  } catch (err) {
    console.error("[logs] Error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
}
