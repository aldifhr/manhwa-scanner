import { redis } from "../lib/redis.js";
import { isCronAuthorized } from "../lib/auth.js";
import { logApiHit } from "../lib/requestLog.js";
import { LOGS_API_CACHE_KEY } from "../lib/cacheKeys.js";

const LOGS_CACHE_SEC = Number(process.env.LOGS_CACHE_SEC || 120);

export default async function handler(req, res) {
  logApiHit("logs", req);

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!isCronAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const cacheTtl = Number.isFinite(LOGS_CACHE_SEC) && LOGS_CACHE_SEC > 0
    ? Math.floor(LOGS_CACHE_SEC)
    : 120;
  res.setHeader(
    "Cache-Control",
    `private, max-age=${Math.min(cacheTtl, 30)}, stale-while-revalidate=${cacheTtl}`,
  );

  try {
    const cached = await redis.get(LOGS_API_CACHE_KEY);
    if (cached && typeof cached === "object") {
      return res.status(200).json(cached);
    }

    const raw = await redis.lrange("cron:logs", 0, 49);
    const payload = { logs: raw.filter(Boolean) };

    await redis.set(LOGS_API_CACHE_KEY, payload, { ex: cacheTtl }).catch(() => {});
    return res.status(200).json(payload);
  } catch (err) {
    console.error("[logs] Error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
}
