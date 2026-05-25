import { redis } from "../../redis.js";
import { normalizeTitleKey, normalizeWhitelist, normalizeSourceUrl } from "../../domain.js";
import { getLogger } from "../../logger.js";
import { supabase, withSupabaseTimeout } from "../../supabase.js";
import { WhitelistEntry, RedisClient } from "../../types.js";
import { WhitelistEntrySchema } from "../../schemas.js";
import { z } from "zod";
import { WHITELIST_DB_CACHE_KEY } from "../../constants/redis.js";

const logger = getLogger({ scope: "storage" });

let whitelistCache: WhitelistEntry[] | null = null;
let whitelistCacheExpiry = 0;
const WHITELIST_CACHE_TTL_MS = 60000;

function validateData<T>(schema: z.ZodSchema<T>, data: unknown, context: string): T | null {
  if (data === null || data === undefined) return null;
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  logger.warn(
    {
      context,
      errors: result.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`),
      sample: typeof data === "string" ? data.substring(0, 100) : "object",
    },
    "Data validation failed for Redis object",
  );
  return null;
}

export function invalidateWhitelistCache(): void {
  whitelistCache = null;
  whitelistCacheExpiry = 0;
}

export async function loadWhitelist(redisClient: RedisClient = redis): Promise<WhitelistEntry[]> {
  const now = Date.now();
  if (whitelistCache && now < whitelistCacheExpiry) {
    return whitelistCache;
  }

  try {
    const cached = await redisClient.get(WHITELIST_DB_CACHE_KEY);
    if (cached) {
      const parsed = typeof cached === "string" ? JSON.parse(cached) : cached;
      if (Array.isArray(parsed)) {
        const hydrated = parsed.map((entry) => {
          entry._normalizedTitle = normalizeTitleKey(entry.title);
          entry._normalizedUrls = new Set(
            (entry.sources || [])
              .map((s: { url?: string | null }) => normalizeSourceUrl(s?.url ?? undefined))
              .filter((u: string | null): u is string => !!u),
          );
          return entry;
        });
        whitelistCache = hydrated;
        whitelistCacheExpiry = Date.now() + WHITELIST_CACHE_TTL_MS;
        logger.info({ count: hydrated.length }, "[loadWhitelist] Loaded from Redis cache");
        return hydrated;
      }
    }
  } catch (err: unknown) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[loadWhitelist] Redis cache read failed, falling back to Supabase",
    );
  }

  try {
    const { data, error } = await withSupabaseTimeout(() =>
      supabase.from("whitelist").select("*"),
    );
    if (error) throw error;
    if (!data || data.length === 0) return [];

    const result = data
      .map((row) => {
        const entry: WhitelistEntry = { title: row.title, sources: row.sources || [] };
        const validated = validateData(WhitelistEntrySchema, entry, "whitelist_entry");
        if (!validated) return null;
        validated._normalizedTitle = normalizeTitleKey(validated.title);
        validated._normalizedUrls = new Set(
          (validated.sources || [])
            .map((s: { url?: string | null }) => normalizeSourceUrl(s?.url ?? undefined))
            .filter((u: string | null): u is string => !!u),
        );
        return validated;
      })
      .filter((e): e is WhitelistEntry => !!e);

    whitelistCache = result;
    whitelistCacheExpiry = Date.now() + WHITELIST_CACHE_TTL_MS;
    redisClient
      .set(WHITELIST_DB_CACHE_KEY, JSON.stringify(result), { ex: 3600 })
      .catch((err) =>
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "[loadWhitelist] Failed to update Redis cache",
        ),
      );
    logger.info({ count: result.length }, "[loadWhitelist] Loaded from Supabase");
    return result;
  } catch (err: unknown) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "[loadWhitelist] Supabase Error",
    );
    throw err;
  }
}

export async function saveWhitelist(
  list: WhitelistEntry[],
  redisClient: RedisClient = redis,
): Promise<void> {
  const normalized = normalizeWhitelist(list);

  try {
    if (!normalized.length) {
      const { error } = await withSupabaseTimeout(() =>
        supabase.from("whitelist").delete().neq("title_key", "some_impossible_key"),
      );
      if (error) throw error;
      whitelistCache = null;
      whitelistCacheExpiry = 0;
      return;
    }

    const rows = normalized
      .map((item) => ({
        title_key: normalizeTitleKey(item.title),
        title: item.title,
        sources: item.sources || [],
      }))
      .filter((r) => !!r.title_key);

    const { error } = await withSupabaseTimeout(() =>
      supabase.from("whitelist").upsert(rows, { onConflict: "title_key" }),
    );
    if (error) throw error;

    const incomingKeys = new Set(rows.map((r) => r.title_key));
    const { data: existingRows } = await withSupabaseTimeout(() =>
      supabase.from("whitelist").select("title_key"),
    );
    if (existingRows) {
      const keysToDelete = existingRows
        .map((r) => r.title_key)
        .filter((k) => !incomingKeys.has(k));
      if (keysToDelete.length > 0) {
        await withSupabaseTimeout(() =>
          supabase.from("whitelist").delete().in("title_key", keysToDelete),
        );
      }
    }

    // Update cache immediately with new data
    whitelistCache = list;
    whitelistCacheExpiry = Date.now() + 300000; // 5 minutes
    
    // Parallel Redis cache update
    redisClient
      .set(WHITELIST_DB_CACHE_KEY, JSON.stringify(list), { ex: 300 }) // 5 minutes in seconds
      .catch((err) =>
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "[saveWhitelist] Failed to update Redis cache",
        ),
      );
    logger.info({ count: normalized.length }, "[saveWhitelist] Saved to Supabase successfully");
  } catch (err: unknown) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "[saveWhitelist] Supabase Error",
    );
    throw err;
  }
}
