import { waitUntil } from "@vercel/functions";
import { InteractionResponseType } from "discord-interactions";
import { redis } from "../redis.js";
import { RedisClient } from "../types.js";
import { editInteractionResponse } from "../discord.js";
import { runCronJob } from "../cronRuntime.js";
import { isGuildAdmin } from "../permissions.js";
import { DISCORD_EPHEMERAL_FLAG } from "../config.js";
import { getLogger } from "../logger.js";
import { withDistributedLock } from "../redis.js";

const logger = getLogger({ scope: "commands:sync" });

const SYNC_COOLDOWN_SECONDS = 60; // 1 minute cooldown between manual syncs

async function checkSyncCooldown(redisClient: RedisClient, userId: string) {
  const cooldownKey = `sync:cooldown:${userId}`;
  const lastSync = await redisClient.get(cooldownKey);
  if (lastSync) {
    const lastSyncMs = parseInt(lastSync, 10);
    if (Number.isNaN(lastSyncMs)) return { onCooldown: false };
    const remaining = Math.ceil((lastSyncMs + SYNC_COOLDOWN_SECONDS * 1000 - Date.now()) / 1000);
    return { onCooldown: true, remaining: Math.max(0, remaining) };
  }
  return { onCooldown: false };
}

async function setSyncCooldown(redisClient: RedisClient, userId: string) {
  const cooldownKey = `sync:cooldown:${userId}`;
  await redisClient.set(cooldownKey, Date.now().toString(), { ex: SYNC_COOLDOWN_SECONDS });
}

export default async function handleSync(payload: any, _options: any, res: any) {
  if (!isGuildAdmin(payload)) {
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: "Hanya admin yang bisa menjalankan sync.",
        flags: DISCORD_EPHEMERAL_FLAG,
      },
    });
  }

  const userId = payload.member?.user?.id ?? payload.user?.id;
  const cooldown = await checkSyncCooldown(redis, userId);
  if (cooldown.onCooldown) {
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: `⏳ Sync sedang cooldown. Tunggu ${cooldown.remaining} detik lagi.`,
        flags: DISCORD_EPHEMERAL_FLAG,
      },
    });
  }

  await setSyncCooldown(redis, userId);

  res.json({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: DISCORD_EPHEMERAL_FLAG },
  });

  waitUntil(
    (async () => {
      const lockKey = "cron:run:lock";
      try {
        await withDistributedLock(redis, lockKey, async () => {
          // Immediate feedback
          await editInteractionResponse(payload, "⏳ Memulai sinkronisasi, mohon tunggu...");
          
          logger.info({ userId }, "Manual sync starting...");
          
          // Run cron with 60s timeout
          const out = await runCronJob({ 
            redisClient: redis,
            deadlineMs: 60000, // 60 second timeout
          });
          
          const summary = out.body as { sent: number; failed: number; duration: string | number };
          const channelId = process.env.NOTIFICATION_CHANNEL_ID;
          const channelMention = channelId ? `<#${channelId}>` : "notification channel";
          
          const msg = `🚀 **Sync Selesai**\nSent: ${summary.sent}, Failed: ${summary.failed}, Duration: ${summary.duration}s\nCek ${channelMention} atau dashboard.`;
          await editInteractionResponse(payload, msg);
        }, { ttlSec: 60, timeoutMs: 30000, label: "Sync" }); // 30s lock timeout
      } catch (err: unknown) {
        if ((err as any).message?.includes("Gagal mendapatkan lock")) {
          return editInteractionResponse(
            payload,
            "⚠️ Bot sedang sinkronisasi. Cek lagi nanti.",
          );
        }
        logger.error({ err: (err as any).message, userId }, "Manual sync failed");
        await editInteractionResponse(payload, `❌ Sync gagal: ${(err as any).message}`);
      }
    })(),
  );
}
