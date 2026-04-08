import { waitUntil } from "@vercel/functions";
import { redis } from "../redis.js";
import { editInteractionResponse } from "../discord.js";
import { runCronJob } from "../cronRuntime.js";
import { isGuildAdmin } from "../permissions.js";
import { getLogger } from "../logger.js";

const logger = getLogger({ scope: "commands:sync" });

const SYNC_COOLDOWN_SECONDS = 60; // 1 minute cooldown between manual syncs

async function checkSyncCooldown(redisClient, userId) {
  const cooldownKey = `sync:cooldown:${userId}`;
  const lastSync = await redisClient.get(cooldownKey);
  if (lastSync) {
    const remaining = Math.ceil((parseInt(lastSync, 10) + SYNC_COOLDOWN_SECONDS * 1000 - Date.now()) / 1000);
    return { onCooldown: true, remaining };
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
      type: 4,
      data: { content: "Hanya admin yang bisa menjalankan sync.", flags: 64 },
    });
  }

  // Check rate limit
  const userId = payload.member?.user?.id ?? payload.user?.id;
  const cooldown = await checkSyncCooldown(redis, userId);
  if (cooldown.onCooldown) {
    return res.json({
      type: 4,
      data: {
        content: `⏳ Sync sedang cooldown. Tunggu ${cooldown.remaining} detik lagi.`,
        flags: 64,
      },
    });
  }

  // Set cooldown before running
  await setSyncCooldown(redis, userId);

  res.json({ type: 5, data: { flags: 64 } });

  waitUntil(
    (async () => {
      const start = Date.now();
      try {
        logger.info({ userId }, "Manual sync starting...");
        const out = await runCronJob({ redisClient: redis });
        const duration = ((Date.now() - start) / 1000).toFixed(1);
        const summary = out.body;
        logger.info({ sent: summary.sent, failed: summary.failed, duration }, "Manual sync completed");
        const msg = `🚀 **Sync Selesai**\nSent: ${summary.sent}, Failed: ${summary.failed}, Duration: ${summary.duration}s\nCek channel <#${process.env.NOTIFICATION_CHANNEL_ID || ""}> atau dashboard.`;
        await editInteractionResponse(payload, msg);
      } catch (err) {
        const duration = ((Date.now() - start) / 1000).toFixed(1);
        logger.error({ err: err.message, userId, duration }, "Manual sync failed");
        await editInteractionResponse(
          payload,
          `❌ Sync gagal: ${err.message}`,
        );
      }
    })(),
  );
}
