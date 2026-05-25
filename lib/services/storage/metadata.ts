import { getLogger } from "../../logger.js";
import { supabase, withSupabaseTimeout } from "../../supabase.js";
import { MangaMetadata, RedisClient } from "../../types.js";
import { MangaMetadataSchema } from "../../schemas.js";
import { z } from "zod";

const logger = getLogger({ scope: "storage" });

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

export async function batchGetMangaMetadata(
  _redisClient: RedisClient,
  titleKeys: string[],
  maxAgeHours = 168,
): Promise<(MangaMetadata | null)[]> {
  if (!titleKeys.length) return [];
  try {
    const { data, error } = await withSupabaseTimeout(() =>
      supabase
        .from("manga_metadata")
        .select("title_key, data, last_updated")
        .in("title_key", titleKeys),
    );
    if (error) throw error;

    const dataMap = new Map<string, Record<string, unknown>>();
    if (data) {
      data.forEach((row) => {
        dataMap.set(row.title_key, { ...row.data, lastUpdated: row.last_updated });
      });
    }

    const nowMs = Date.now();
    const maxAgeMs = maxAgeHours * 3600000;

    return titleKeys.map((tk) => {
      const rawData = dataMap.get(tk);
      if (!rawData) return null;
      try {
        const validated = validateData(MangaMetadataSchema, rawData, `manga_metadata:${tk}`);
        if (!validated) return null;
        if (maxAgeHours > 0 && validated.lastUpdated) {
          const age = nowMs - new Date(validated.lastUpdated).getTime();
          if (age > maxAgeMs) {
            logger.debug({ titleKey: tk }, "Batch metadata stale, skipping");
            return null;
          }
        }
        return validated;
      } catch {
        return null;
      }
    });
  } catch (err: unknown) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Failed to batch get manga metadata from Supabase",
    );
    return titleKeys.map(() => null);
  }
}

export async function setMangaMetadata(
  _redisClient: RedisClient,
  titleKey: string,
  data: Partial<MangaMetadata>,
  _ttlSec = 3600 * 24 * 30,
): Promise<boolean> {
  try {
    const { error } = await withSupabaseTimeout(() =>
      supabase.from("manga_metadata").upsert(
        {
          title_key: titleKey,
          data: data,
          last_updated: new Date().toISOString(),
        },
        { onConflict: "title_key" },
      ),
    );
    if (error) throw error;
    return true;
  } catch (err: unknown) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), titleKey },
      "Failed to set manga metadata in Supabase",
    );
    return false;
  }
}

export async function deleteMangaMetadata(
  _redisClient: RedisClient,
  titleKey: string,
): Promise<boolean> {
  try {
    const { error } = await withSupabaseTimeout(() =>
      supabase.from("manga_metadata").delete().eq("title_key", titleKey),
    );
    if (error) throw error;
    return true;
  } catch (err: unknown) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), titleKey },
      "Failed to delete manga metadata from Supabase",
    );
    return false;
  }
}
