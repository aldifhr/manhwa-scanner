import { redis }           from "../lib/redis.js";
import { logApiHit } from "../lib/requestLog.js";
import { prepareAuthorizedGet } from "../lib/api/getEndpoint.js";
import { RECENT_API_CACHE_KEY } from "../lib/cacheKeys.js";

const RECENT_CACHE_SEC = Number(process.env.RECENT_CACHE_SEC || 90);

export default async function handler(req, res) {
  logApiHit("recent", req);

  const prepared = prepareAuthorizedGet(req, res, {
    defaultCacheTtl: 90,
    rawCacheTtl: RECENT_CACHE_SEC,
    maxAgeCap: 30,
  });
  if (!prepared) return;
  const { cacheTtl } = prepared;

  try {
    const cached = await redis.get(RECENT_API_CACHE_KEY);
    if (cached && typeof cached === "object") {
      return res.status(200).json(cached);
    }

    // Ambil lebih banyak dulu agar aman kalau ada entry corrupt
    const raw = await redis.lrange("recent:chapters", 0, 49);

    const items = raw
      // Upstash auto-deserialize — tidak perlu JSON.parse manual
      .filter((item) => item && item.sentAt)
      // Guard invalid date agar sort tetap deterministic
      .sort((a, b) => {
        const ta = new Date(a.sentAt).getTime();
        const tb = new Date(b.sentAt).getTime();
        if (isNaN(ta) || isNaN(tb)) return 0;
        return tb - ta;
      })
      .slice(0, 20);

    const payload = { items };
    await redis.set(RECENT_API_CACHE_KEY, payload, { ex: cacheTtl }).catch(() => {});

    return res.status(200).json(payload);
  } catch (err) {
    console.error("[recent] Error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
}
