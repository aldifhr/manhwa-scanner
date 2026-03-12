import { redis } from "../lib/redis.js";
import { logApiHit } from "../lib/requestLog.js";
import { prepareAuthorizedGet } from "../lib/api/getEndpoint.js";
import { RECENT_API_CACHE_KEY } from "../lib/cacheKeys.js";

const RECENT_CACHE_SEC = Number(process.env.RECENT_CACHE_SEC || 90);

export function sortRecentItems(items = []) {
  return [...items].sort((a, b) => {
    const ta = new Date(a?.sentAt).getTime();
    const tb = new Date(b?.sentAt).getTime();
    if (!isNaN(ta) && !isNaN(tb) && tb !== ta) return tb - ta;

    const oa = Number.isFinite(Number(a?.sentOrder)) ? Number(a.sentOrder) : Number.MAX_SAFE_INTEGER;
    const ob = Number.isFinite(Number(b?.sentOrder)) ? Number(b.sentOrder) : Number.MAX_SAFE_INTEGER;
    if (oa !== ob) return oa - ob;

    return (
      String(a?.title || "").localeCompare(String(b?.title || "")) ||
      String(a?.chapter || "").localeCompare(String(b?.chapter || ""), undefined, { numeric: true })
    );
  });
}

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

    const raw = await redis.lrange("recent:chapters", 0, 49);
    const items = sortRecentItems(
      raw
        .filter((item) => item && item.sentAt)
        .filter((item) => !isNaN(new Date(item.sentAt).getTime()))
        .map((item) => ({
          ...item,
          sentOrder: Number.isFinite(Number(item?.sentOrder)) ? Number(item.sentOrder) : null,
        })),
    ).slice(0, 20);

    const payload = { items };
    await redis.set(RECENT_API_CACHE_KEY, payload, { ex: cacheTtl }).catch(() => {});

    return res.status(200).json(payload);
  } catch (err) {
    console.error("[recent] Error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
}
