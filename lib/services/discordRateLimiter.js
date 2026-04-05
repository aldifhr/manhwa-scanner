import Bottleneck from "bottleneck";
import pLimit from "p-limit";

const limiter = new Bottleneck({
  // Global guard against Discord burst/rate-limit.
  maxConcurrent: Number(process.env.DISCORD_SEND_MAX_CONCURRENT || 10),
  minTime: Number(process.env.DISCORD_SEND_MIN_TIME_MS || 50),
});

export async function scheduleDiscordSend(sendFn, item, channelId, redis, mentions = "") {
  return limiter.schedule(() => sendFn(item, channelId, redis, mentions));
}

export async function sendToChannelsLimited({
  sendFn,
  item,
  channelIds = [],
  redis = null,
  mentions = "",
  concurrency = Number(process.env.DISCORD_CHANNEL_CONCURRENCY || 10),
  onError = null,
}) {
  if (!Array.isArray(channelIds) || channelIds.length === 0) {
    return { success: 0, failed: 0 };
  }
  if (channelIds.length === 1) {
    const channelId = channelIds[0];
    try {
      await scheduleDiscordSend(sendFn, item, channelId, redis, mentions);
      return { success: 1, failed: 0 };
    } catch (err) {
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
          await scheduleDiscordSend(sendFn, item, channelId, redis, mentions);
          successCount++;
        } catch (err) {
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
