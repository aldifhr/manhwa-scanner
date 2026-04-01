import { redis } from "../lib/redis.js";
import { logApiHit } from "../lib/logger.js";
import { prepareAuthorizedGet } from "../lib/api/getEndpoint.js";
import {
  readStatusCache,
  writeStatusCache,
} from "../lib/monitorStore.js";
import { readCronStatusWithHealth } from "../lib/cronRuntime.js";

const STATUS_CACHE_SEC = Number(process.env.STATUS_CACHE_SEC || 60);

export default async function handler(req, res) {
  logApiHit("status", req);

  const prepared = prepareAuthorizedGet(req, res, {
    defaultCacheTtl: 60,
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
    console.error("[last-run] Error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
}
