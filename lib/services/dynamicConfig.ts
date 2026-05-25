
import { redis } from "../redis.js";
import { getLogger } from "../logger.js";

const logger = getLogger({ scope: "dynamic-config" });
const CONFIG_KEY = "config:dynamic_overrides";

export interface DynamicOverrides {
  shinigamiBase?: string;
  ikiruBase?: string;
  lastUpdated?: string;
}

let cachedOverrides: DynamicOverrides | null = null;
let lastFetch = 0;
const CACHE_TTL = 300000; // 5 minutes

/**
 * Get dynamic overrides from Redis
 */
export async function getDynamicOverrides(): Promise<DynamicOverrides> {
  const now = Date.now();
  if (cachedOverrides && (now - lastFetch < CACHE_TTL)) {
    return cachedOverrides;
  }

  try {
    const raw = await redis.get(CONFIG_KEY);
    if (raw) {
      cachedOverrides = typeof raw === 'string' ? JSON.parse(raw) : raw;
      lastFetch = now;
      return cachedOverrides || {};
    }
  } catch (err) {
    logger.warn({ err }, "Failed to fetch dynamic overrides from Redis");
  }

  return {};
}

/**
 * Set dynamic overrides in Redis
 */
export async function setDynamicOverrides(overrides: Partial<DynamicOverrides>): Promise<void> {
  try {
    const current = await getDynamicOverrides();
    const next = { ...current, ...overrides, lastUpdated: new Date().toISOString() };
    await redis.set(CONFIG_KEY, JSON.stringify(next));
    cachedOverrides = next;
    lastFetch = Date.now();
    logger.info(overrides, "Updated dynamic overrides");
  } catch (err) {
    logger.error({ err }, "Failed to set dynamic overrides in Redis");
  }
}
