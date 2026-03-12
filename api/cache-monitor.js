import { redis } from "../lib/redis.js";
import { logApiHit } from "../lib/requestLog.js";
import { prepareAuthorizedGet } from "../lib/api/getEndpoint.js";
import {
  LOGS_API_CACHE_KEY,
  RECENT_API_CACHE_KEY,
  SOURCE_COMPARE_CACHE_KEY,
  SOURCE_COMPARE_STATE_KEY,
  STATUS_API_CACHE_KEY,
  WHITELIST_API_CACHE_KEY,
} from "../lib/cacheKeys.js";

const CACHE_KEYS = [
  { label: "status", key: STATUS_API_CACHE_KEY },
  { label: "whitelist", key: WHITELIST_API_CACHE_KEY },
  { label: "recent", key: RECENT_API_CACHE_KEY },
  { label: "logs", key: LOGS_API_CACHE_KEY },
  { label: "source-compare", key: SOURCE_COMPARE_CACHE_KEY },
  { label: "compare-state", key: SOURCE_COMPARE_STATE_KEY },
];

export default async function handler(req, res) {
  logApiHit("cache-monitor", req);

  const prepared = prepareAuthorizedGet(req, res, {
    defaultCacheTtl: 60,
    rawCacheTtl: 60,
    maxAgeCap: 30,
  });
  if (!prepared) return;

  try {
    const items = await Promise.all(
      CACHE_KEYS.map(async ({ label, key }) => {
        const [value, ttl] = await Promise.all([
          redis.get(key).catch(() => null),
          redis.ttl(key).catch(() => null),
        ]);
        const exists = value !== null && value !== undefined;
        return {
          label,
          key,
          exists,
          ttl,
          sizeHint: Array.isArray(value?.items)
            ? value.items.length
            : Array.isArray(value?.logs)
              ? value.logs.length
              : Array.isArray(value?.comparisons)
                ? value.comparisons.length
                : value?.recentCount ?? null,
          generatedAt: value?.generatedAt || value?.timestamp || null,
        };
      }),
    );

    return res.status(200).json({ items });
  } catch (err) {
    return res.status(500).json({ error: "Internal error" });
  }
}
