import { readStatusCache, redis, writeStatusCache } from "../lib/redis.js";
import { logApiHit, getLogger } from "../lib/logger.js";
import { prepareAuthorizedGet } from "../lib/api/response.js";
import { readCronStatusWithHealth } from "../lib/cronRuntime.js";

import { STATUS_CACHE_SEC } from "../lib/config.js";

const logger = getLogger({ scope: "api:status" });

export default async function handler(req, res) {
  logApiHit("status", req);

  const prepared = prepareAuthorizedGet(req, res, {
    defaultCacheTtl: STATUS_CACHE_SEC,
    rawCacheTtl: STATUS_CACHE_SEC,
    maxAgeCap: 30,
  });
  if (!prepared) return;
  const { cacheTtl } = prepared;

  try {
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
