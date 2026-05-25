/**
 * URL Normalization Service
 * Pre-normalize URLs at input to avoid repeated operations
 */

import { getLogger } from "../logger.js";
import type { RedisClient, WhitelistEntry, WhitelistSource } from "../types.js";
import { normalizeSourceUrl } from "../scrapers/shared.js";

const logger = getLogger({ scope: "url-normalizer" });

/**
 * Normalize whitelist entry URLs
 * Call this ONCE when adding to whitelist
 */
export function normalizeWhitelistEntry(entry: WhitelistEntry): WhitelistEntry {
  return {
    ...entry,
    sources: entry.sources?.map(normalizeWhitelistSource) || [],
  };
}

/**
 * Normalize a single source
 */
function normalizeWhitelistSource(source: WhitelistSource): WhitelistSource {
  return {
    ...source,
    url: normalizeSourceUrl(source.url), // Pre-normalize once!
  };
}

/**
 * Batch normalize whitelist entries
 */
export function normalizeWhitelistBatch(
  entries: WhitelistEntry[]
): WhitelistEntry[] {
  return entries.map(normalizeWhitelistEntry);
}

/**
 * Normalize and save whitelist to Redis
 * This ensures all URLs are pre-normalized
 */
export async function saveNormalizedWhitelist(
  whitelist: WhitelistEntry[],
  redis: RedisClient
): Promise<void> {
  try {
    // Normalize all entries
    const normalized = normalizeWhitelistBatch(whitelist);
    
    // Save to Redis
    const key = "whitelist";
    await redis.set(key, JSON.stringify(normalized));
    
    logger.info({ 
      count: normalized.length,
      totalSources: normalized.reduce((sum, e) => sum + (e.sources?.length || 0), 0)
    }, "Saved normalized whitelist");
  } catch (err) {
    logger.error({ err }, "Failed to save normalized whitelist");
    throw err;
  }
}

/**
 * Validate and normalize URL input
 * Use this in API endpoints that accept URLs
 */
export function validateAndNormalizeUrl(url: string): {
  valid: boolean;
  normalized: string;
  error?: string;
} {
  try {
    // Basic validation
    if (!url || typeof url !== "string") {
      return {
        valid: false,
        normalized: "",
        error: "URL is required",
      };
    }

    // Normalize
    const normalized = normalizeSourceUrl(url);

    // Check if valid URL
    try {
      new URL(normalized);
    } catch {
      return {
        valid: false,
        normalized: "",
        error: "Invalid URL format",
      };
    }

    return {
      valid: true,
      normalized,
    };
  } catch (err) {
    return {
      valid: false,
      normalized: "",
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

/**
 * Pre-normalize URLs in existing whitelist (migration)
 */
export async function migrateWhitelistUrls(redis: RedisClient): Promise<{
  migrated: number;
  errors: number;
}> {
  try {
    // Load existing whitelist
    const key = "whitelist";
    const data = await redis.get(key);
    
    if (!data) {
      logger.info("No whitelist to migrate");
      return { migrated: 0, errors: 0 };
    }

    const whitelist = JSON.parse(data) as WhitelistEntry[];
    
    // Normalize all
    const normalized = normalizeWhitelistBatch(whitelist);
    
    // Save back
    await redis.set(key, JSON.stringify(normalized));
    
    const totalSources = normalized.reduce(
      (sum, e) => sum + (e.sources?.length || 0),
      0
    );

    logger.info({ 
      entries: normalized.length,
      sources: totalSources 
    }, "Migrated whitelist URLs");

    return {
      migrated: totalSources,
      errors: 0,
    };
  } catch (err) {
    logger.error({ err }, "Failed to migrate whitelist URLs");
    return {
      migrated: 0,
      errors: 1,
    };
  }
}
