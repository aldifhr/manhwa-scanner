import { redis }           from "../lib/redis.js";
import { isCronAuthorized } from "../lib/auth.js";
import { logApiHit } from "../lib/requestLog.js";
import { RECENT_API_CACHE_KEY } from "../lib/cacheKeys.js";

const RECENT_CACHE_SEC = Number(process.env.RECENT_CACHE_SEC || 90);

export default async function handler(req, res) {
  logApiHit("recent", req);

  if (req.method !== "GET")
    return res.status(405).json({ error: "Method not allowed" });

  if (!isCronAuthorized(req))
    return res.status(401).json({ error: "Unauthorized" });

  const cacheTtl = Number.isFinite(RECENT_CACHE_SEC) && RECENT_CACHE_SEC > 0
    ? Math.floor(RECENT_CACHE_SEC)
    : 90;
  res.setHeader("Cache-Control", `private, max-age=${Math.min(cacheTtl, 30)}, stale-while-revalidate=${cacheTtl}`);

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
