export const RECENT_API_CACHE_KEY = "cache:api:recent:v1";
export const LOGS_API_CACHE_KEY = "cache:api:logs:v1";
export const STATUS_API_CACHE_KEY = "cache:api:status:v1";
export const WHITELIST_API_CACHE_KEY = "cache:api:whitelist:v1";

export async function invalidateDashboardCaches(redis, keys = []) {
  if (!redis || !Array.isArray(keys) || keys.length === 0) return;

  await Promise.all(
    [...new Set(keys)].map((key) => redis.del(key).catch(() => 0)),
  );
}
