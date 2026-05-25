import { readCronStatus, loadSourceHealthSnapshot } from "../services/storage.js";
import { SOURCE_KEYS } from "../constants/redis.js";
import { redis } from "../redis.js";
import type { RedisClient } from "../types.js";

export async function readCronStatusWithHealth(redisClient: RedisClient = redis) {
  const data = await readCronStatus(redisClient);
  if (!data) return null;

  const fallbackHealth = await loadSourceHealthSnapshot(redisClient, SOURCE_KEYS);
  const rawRecommendations = await redisClient.get("health:recommendations");
  let recommendations: unknown[] = [];
  if (rawRecommendations) {
    try {
      const parsed = JSON.parse(rawRecommendations);
      recommendations = Array.isArray(parsed) ? parsed : [];
    } catch {
      recommendations = [];
    }
  }
  const lastHealthCheck = await redisClient.get("health:last-check");

  const base = {
    ...data,
    recommendations,
    lastHealthCheck,
  };

  if (data.sourceHealth && typeof data.sourceHealth === "object") {
    const mergedHealth = { ...fallbackHealth };
    for (const [source, value] of Object.entries(data.sourceHealth)) {
      mergedHealth[source] = value;
    }
    return {
      ...base,
      sourceHealth: mergedHealth,
    };
  }

  return {
    ...base,
    sourceHealth: fallbackHealth,
  };
}
