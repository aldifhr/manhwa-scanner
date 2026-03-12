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

const FIXED_KEYS = [
  { label: "whitelist", key: "whitelist:manga" },
  { label: "channels", key: "channels:guild-map" },
  { label: "cron:last_run", key: "cron:last_run" },
  { label: "recent:chapters", key: "recent:chapters" },
  { label: "cron:logs", key: "cron:logs" },
  { label: "cache:status", key: STATUS_API_CACHE_KEY },
  { label: "cache:whitelist", key: WHITELIST_API_CACHE_KEY },
  { label: "cache:recent", key: RECENT_API_CACHE_KEY },
  { label: "cache:logs", key: LOGS_API_CACHE_KEY },
  { label: "cache:source-compare", key: SOURCE_COMPARE_CACHE_KEY },
  { label: "state:source-compare", key: SOURCE_COMPARE_STATE_KEY },
];

const DYNAMIC_PATTERNS = [
  { label: "chapter:* sample", match: "chapter:*" },
  { label: "history:seen:* sample", match: "history:seen:*" },
  { label: "history:manga:* sample", match: "history:manga:*" },
  { label: "cache:channel-valid:* sample", match: "cache:channel-valid:*" },
];
const TTL_AUDIT_CACHE_KEY = "cache:api:ttl-audit:v1";
const TTL_AUDIT_CACHE_SEC = 120;

async function findFirstKey(match) {
  const [nextCursor, keys] = await redis.scan(0, { match, count: 1 }).catch(() => [0, []]);
  void nextCursor;
  return Array.isArray(keys) && keys.length > 0 ? keys[0] : null;
}

export default async function handler(req, res) {
  logApiHit("ttl-audit", req);

  const prepared = prepareAuthorizedGet(req, res, {
    defaultCacheTtl: 180,
    rawCacheTtl: 180,
    maxAgeCap: 60,
  });
  if (!prepared) return;

  try {
    const cached = await redis.get(TTL_AUDIT_CACHE_KEY).catch(() => null);
    if (cached && typeof cached === "object") {
      return res.status(200).json(cached);
    }

    const fixed = await Promise.all(
      FIXED_KEYS.map(async ({ label, key }) => ({
        label,
        key,
        ttl: await redis.ttl(key).catch(() => null),
      })),
    );

    const dynamic = await Promise.all(
      DYNAMIC_PATTERNS.map(async ({ label, match }) => {
        const key = await findFirstKey(match);
        return {
          label,
          key,
          ttl: key ? await redis.ttl(key).catch(() => null) : null,
        };
      }),
    );

    const payload = { items: [...fixed, ...dynamic] };
    await redis.set(TTL_AUDIT_CACHE_KEY, payload, { ex: TTL_AUDIT_CACHE_SEC }).catch(() => {});
    return res.status(200).json(payload);
  } catch (err) {
    return res.status(500).json({ error: "Internal error" });
  }
}
