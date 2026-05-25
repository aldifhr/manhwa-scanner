import { RedisClient } from "../types.js";
import { getLogger } from "../logger.js";
import { sendDiscordEmbedsChannelBatch } from "../discord/messaging.js";
import { DiscordEmbedData } from "../types.js";
import { env } from "../config/env.js";

const logger = getLogger({ scope: "health-monitor" });

const LAST_SOURCE_UPDATE_PREFIX = "health:last_update:";
const STALE_THRESHOLD_MS = 6 * 60 * 60 * 1000; // 6 Hours
const HEALTH_ALERT_CHANNEL_ID = env.HEALTH_ALERT_CHANNEL_ID || "1500721659915665549";

/**
 * Record that a source just provided an update
 */
export async function recordSourceActivity(redis: RedisClient, source: string) {
  const key = `${LAST_SOURCE_UPDATE_PREFIX}${source}`;
  await redis.set(key, Date.now().toString());
}

/**
 * Check if any source has become stale (no updates for a long time)
 */
export async function checkSourceHealth(redis: RedisClient, sources: string[]) {
  const alerts: string[] = [];
  const now = Date.now();

  for (const source of sources) {
    const key = `${LAST_SOURCE_UPDATE_PREFIX}${source}`;
    const lastUpdateStr = await redis.get(key);
    
    if (lastUpdateStr) {
      const lastUpdate = parseInt(lastUpdateStr);
      const elapsed = now - lastUpdate;
      
      if (elapsed > STALE_THRESHOLD_MS) {
        const hours = Math.round(elapsed / (1000 * 60 * 60));
        alerts.push(`⚠️ **[${source.toUpperCase()}]** tidak mengirim update selama **${hours} jam**!`);
      }
    } else {
      // First time initialization
      await recordSourceActivity(redis, source);
    }
  }

  if (alerts.length > 0) {
    logger.warn({ count: alerts.length }, "Source health alerts detected");
    
    // Send alert to Discord
    const alertMessage = `🚨 **SISTEM MONITORING MANHWA** 🚨\n\n${alerts.join('\n')}\n\n*Catatan: Bot tetap berjalan, namun sumber di atas tidak memberikan update baru selama beberapa jam terakhir.*`;
    
    try {
      const embeds: DiscordEmbedData[] = [{
        title: "⚠️ Peringatan Stabilitas Sumber",
        description: alertMessage,
        type: "report",
        // Mandatory fields for DiscordEmbedData
        chapter: "Health Monitor",
        url: "https://manhwa-scrap.system",
        source: "system",
      }];
      
      await sendDiscordEmbedsChannelBatch(
        embeds,
        HEALTH_ALERT_CHANNEL_ID
      );
    } catch (err) {
      logger.error({ err: (err as Error).message }, "Failed to send health alert to Discord");
    }
    
    return alertMessage;
  }
  
  return null;
}
