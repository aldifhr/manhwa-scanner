import { redis } from "../lib/redis.js";
import { isCronAuthorized } from "../lib/auth.js";
import { logApiHit } from "../lib/requestLog.js";
import { STATUS_API_CACHE_KEY } from "../lib/cacheKeys.js";

const SOURCE_KEYS = ["ikiru", "shinigami_project", "shinigami_mirror"];
const STATUS_CACHE_SEC = Number(process.env.STATUS_CACHE_SEC || 30);

export default async function handler(req, res) {
  logApiHit("status", req);

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!isCronAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const cacheTtl = Number.isFinite(STATUS_CACHE_SEC) && STATUS_CACHE_SEC > 0
    ? Math.floor(STATUS_CACHE_SEC)
    : 30;
  res.setHeader(
    "Cache-Control",
    `private, max-age=${Math.min(cacheTtl, 15)}, stale-while-revalidate=${cacheTtl}`,
  );

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
