import { RedisClient, ChapterItem } from "../../types.js";
import { chunkArray } from "../../utils.js";
import Bottleneck from "bottleneck";
import pLimit from "p-limit";
import { env } from "../../config/env.js";

const discordSendLimiter = new Bottleneck({
  maxConcurrent: env.DISCORD_SEND_MAX_CONCURRENT,
  minTime: env.DISCORD_SEND_MIN_TIME_MS,
});

export async function scheduleDiscordSend(
  sendFn: (item: ChapterItem, channelId: string, redis: RedisClient, mentions?: string) => Promise<{ success: boolean }>,
  item: ChapterItem,
  channelId: string,
  redis: RedisClient,
  mentions = "",
): Promise<{ success: boolean }> {
  return discordSendLimiter.schedule(() => sendFn(item, channelId, redis, mentions));
}

interface SendToChannelsOptionsTyped<T = ChapterItem> {
  sendFn: (item: T, channelId: string, redis: RedisClient, mentions?: string) => Promise<{ success: boolean }>;
  item: T;
  channelIds: string[];
  redis?: RedisClient | null;
  mentions?: string;
  concurrency?: number;
  onError?: ((err: unknown, channelId: string) => void | Promise<void>) | null;
}

export async function sendToChannelsLimited({
  sendFn,
  item,
  channelIds = [],
  redis = null,
  mentions = "",
  concurrency = env.DISCORD_CHANNEL_CONCURRENCY,
  onError = null,
}: SendToChannelsOptionsTyped): Promise<{ success: number; failed: number }> {
  if (!Array.isArray(channelIds) || channelIds.length === 0) {
    return { success: 0, failed: 0 };
  }

  if (channelIds.length === 1) {
    const channelId = channelIds[0];
    try {
      const res = await scheduleDiscordSend(sendFn, item, channelId, redis as RedisClient, mentions);
      if (res && res.success === false) {
        if (typeof onError === "function") {
          await Promise.resolve(onError(new Error("Send failed"), channelId));
        }
        return { success: 0, failed: 1 };
      }
      return { success: 1, failed: 0 };
    } catch (err: unknown) {
      if (typeof onError === "function") {
        await Promise.resolve(onError(err, channelId));
      }
      return { success: 0, failed: 1 };
    }
  }

  const limit = pLimit(Math.max(1, concurrency));
  let successCount = 0;
  let failedCount = 0;

  await Promise.all(
    channelIds.map((channelId) =>
      limit(async () => {
        try {
          const res = await scheduleDiscordSend(sendFn, item, channelId, redis as RedisClient, mentions);
          if (res && res.success === false) {
            failedCount++;
            if (typeof onError === "function") {
              await Promise.resolve(onError(res, channelId));
            }
          } else {
            successCount++;
          }
        } catch (err: unknown) {
          failedCount++;
          if (typeof onError === "function") {
            await Promise.resolve(onError(err, channelId));
          }
        }
      }),
    ),
  );

  return { success: successCount, failed: failedCount };
}

export function buildMentionChunks(subscribers: string[], chunkSize: number): string[] {
  if (!Array.isArray(subscribers) || subscribers.length === 0) {
    return [];
  }
  return chunkArray(subscribers, chunkSize).map((chunk) =>
    chunk.map((id) => `<@${id}>`).join(" "),
  );
}
