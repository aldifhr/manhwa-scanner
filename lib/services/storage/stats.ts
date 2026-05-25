import { getLogger } from "../../logger.js";
import { supabase, withSupabaseTimeout } from "../../supabase.js";
import { RedisClient } from "../../types.js";
import { CRON_DAILY_STATS_MASTER_KEY } from "../../constants/redis.js";

const logger = getLogger({ scope: "storage" });

export async function supabasePing(): Promise<boolean> {
  try {
    const { error } = await withSupabaseTimeout(
      () => supabase.from("whitelist").select("count", { count: "exact", head: true }),
      5000,
    );
    if (error) throw error;
    logger.debug("[supabasePing] Heartbeat sent successfully");
    return true;
  } catch (err: unknown) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[supabasePing] Heartbeat failed",
    );
    return false;
  }
}

export async function syncDailyStatsToSupabase(redisClient: RedisClient): Promise<void> {
  try {
    const data = (await redisClient.hgetall(CRON_DAILY_STATS_MASTER_KEY)) as Record<
      string,
      string
    >;
    if (!data) return;

    const entries = Object.entries(data);
    if (entries.length === 0) return;

    const sortedEntries = entries.sort((a, b) => b[0].localeCompare(a[0]));
    const latestDate = sortedEntries[0][0];
    const rawValue = sortedEntries[0][1];
    const latestData = typeof rawValue === "string" ? JSON.parse(rawValue) : rawValue;

    const { error } = await withSupabaseTimeout(() =>
      supabase.from("scraper_stats").upsert(
        {
          date: latestDate,
          sent: latestData.sent || 0,
          skipped: latestData.skipped || 0,
          failed: latestData.failed || 0,
          hibernated: latestData.hibernated || 0,
          incremental_saved: latestData.incrementalSaved || 0,
          guilds: latestData.guilds || 0,
          scraped: latestData.scraped || 0,
          duration_avg: Number(latestData.durationAvg) || 0,
          raw_data: latestData,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "date" },
      ),
    );
    if (error) throw error;
    logger.info({ date: latestDate }, "[syncDailyStatsToSupabase] Stats persisted to Supabase");
  } catch (err: unknown) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[syncDailyStatsToSupabase] Failed to sync stats",
    );
  }
}
