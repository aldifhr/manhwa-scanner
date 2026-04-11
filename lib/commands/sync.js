import { waitUntil } from "@vercel/functions";
import { InteractionResponseType } from "discord-interactions";
import { redis } from "../redis.js";
import { editInteractionResponse } from "../discord.js";
import { runCronJob } from "../cronRuntime.js";
import { isGuildAdmin } from "../permissions.js";
import { DISCORD_EPHEMERAL_FLAG } from "../config.js";
import { getLogger } from "../logger.js";

const logger = getLogger({ scope: "commands:sync" });

const SYNC_COOLDOWN_SECONDS = 60; // 1 minute cooldown between manual syncs

async function checkSyncCooldown(redisClient, userId) {
  const cooldownKey = `sync:cooldown:${userId}`;
  const lastSync = await redisClient.get(cooldownKey);
  if (lastSync) {
    const lastSyncMs = parseInt(lastSync, 10);
    if (Number.isNaN(lastSyncMs)) {
      // Invalid timestamp, treat as not on cooldown
      return { onCooldown: false };
    }
    const remaining = Math.ceil((lastSyncMs + SYNC_COOLDOWN_SECONDS * 1000 - Date.now()) / 1000);
    return { onCooldown: true, remaining: Math.max(0, remaining) };
  }
  return { onCooldown: false };
}

async function setSyncCooldown(redisClient, userId) {
  const cooldownKey = `sync:cooldown:${userId}`;
  await redisClient.set(cooldownKey, Date.now().toString(), { ex: SYNC_COOLDOWN_SECONDS });
}

export default async function handleSync(payload, _options, res) {
  if (!isGuildAdmin(payload)) {
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: "Hanya admin yang bisa menjalankan sync.",
        flags: DISCORD_EPHEMERAL_FLAG,
      },
    });
  }

  // Check rate limit
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

  // Set cooldown before running
  await setSyncCooldown(redis, userId);

  res.json({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: DISCORD_EPHEMERAL_FLAG },
  });

  waitUntil(
    (async () => {
      const lockKey = "cron:run:lock";
      const lockTtl = 60;
      const lockToken = `${Date.now()}:manual:${userId}`;

      const start = Date.now();
      try {
        // Acquire global cron lock
        const acquired = await redis.set(lockKey, lockToken, { nx: true, ex: lockTtl });
        if (acquired !== "OK") {
          return editInteractionResponse(
            payload,
            "⚠️ Bot sedang menjalankan sinkronisasi otomatis atau manual lain. Silakan coba lagi sebentar lagi.",
          );
        }

        try {
          logger.info({ userId }, "Manual sync starting...");
          const out = await runCronJob({ redisClient: redis });
          const duration = ((Date.now() - start) / 1000).toFixed(1);
          const summary = out.body;

          const msg = `🚀 **Sync Selesai**\nSent: ${summary.sent}, Failed: ${summary.failed}, Duration: ${summary.duration}s\nCek channel <#${process.env.NOTIFICATION_CHANNEL_ID || ""}> atau dashboard.`;
          await editInteractionResponse(payload, msg);
        } finally {
          // Release lock
          const current = await redis.get(lockKey);
          if (current === lockToken) {
            await redis.del(lockKey);
          }
        }
      } catch (err) {
        logger.error({ err: err.message, userId }, "Manual sync failed");
        await editInteractionResponse(payload, `❌ Sync gagal: ${err.message}`);
      }
    })(),
  );
}
