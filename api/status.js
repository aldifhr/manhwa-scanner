import { redis } from "../lib/redis.js";
import { logApiHit } from "../lib/requestLog.js";
import { prepareAuthorizedGet } from "../lib/api/getEndpoint.js";
import { STATUS_API_CACHE_KEY } from "../lib/cacheKeys.js";

const SOURCE_KEYS = ["ikiru", "shinigami_project", "shinigami_mirror"];
const STATUS_CACHE_SEC = Number(process.env.STATUS_CACHE_SEC || 30);

export default async function handler(req, res) {
  logApiHit("status", req);

  const prepared = prepareAuthorizedGet(req, res, {
    defaultCacheTtl: 30,
    rawCacheTtl: STATUS_CACHE_SEC,
    maxAgeCap: 15,
  });
  if (!prepared) return;
  const { cacheTtl } = prepared;

  try {
    const cached = await redis.get(STATUS_API_CACHE_KEY);
    if (cached !== null && cached !== undefined) {
      return res.json(cached);
    }

    const data = await redis.get("cron:last_run");
    if (!data) {
      await redis.set(STATUS_API_CACHE_KEY, null, { ex: cacheTtl }).catch(() => {});
      return res.json(null);
    }
    if (data.sourceHealth) {
      await redis.set(STATUS_API_CACHE_KEY, data, { ex: cacheTtl }).catch(() => {});
      return res.json(data);
    }

    const sourceHealthPairs = await Promise.all(
      SOURCE_KEYS.map(async (source) => {
        const raw = await redis.get(`source:health:${source}`);
        return [source, raw ?? null];
      }),
    );

    const payload = {
      ...data,
      sourceHealth: Object.fromEntries(sourceHealthPairs),
    };
    await redis.set(STATUS_API_CACHE_KEY, payload, { ex: cacheTtl }).catch(() => {});
    return res.json(payload);
  } catch (err) {
    console.error("[last-run] Error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
}
