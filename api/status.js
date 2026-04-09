import { readStatusCache, redis, writeStatusCache } from "../lib/redis.js";
import { logApiHit, getLogger } from "../lib/logger.js";
import { prepareAuthorizedGet } from "../lib/api/response.js";
import { readCronStatusWithHealth } from "../lib/cronRuntime.js";

import { STATUS_CACHE_SEC } from "../lib/config.js";

const logger = getLogger({ scope: "api:status" });

export default async function handler(req, res) {
  logApiHit("status", req);
  const realtime =
    String(req.query?.realtime || "").toLowerCase() === "1" ||
    String(req.query?.realtime || "").toLowerCase() === "true";

  const prepared = prepareAuthorizedGet(req, res, {
    defaultCacheTtl: STATUS_CACHE_SEC,
    rawCacheTtl: STATUS_CACHE_SEC,
    maxAgeCap: 30,
  });
  if (!prepared) return;
  const { cacheTtl } = prepared;

  try {
    if (realtime) {
      // Explicit real-time mode for dashboard polling.
      res.setHeader("Cache-Control", "private, no-store, max-age=0");
      const payload = await readCronStatusWithHealth(redis);
      return res.json(payload);
    }

    const cached = await readStatusCache(redis);
    if (cached.hit) {
      return res.json(cached.value);
    }

    const payload = await readCronStatusWithHealth(redis);
    await writeStatusCache(redis, payload, cacheTtl);
    return res.json(payload);
  } catch (err) {
    logger.error({ err: err.message }, "[last-run] Error");
    return res.status(500).json({ error: "Internal error" });
  }
}
