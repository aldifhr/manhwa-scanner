import { waitUntil } from "@vercel/functions";
import { redis } from "../redis.js";
import { editInteractionResponse } from "../discord.js";
import { runCronJob } from "../cronRuntime.js";
import { isGuildAdmin } from "../permissions.js";

export default function handleSync(payload, _options, res) {
  if (!isGuildAdmin(payload)) {
    return res.json({
      type: 4,
      data: { content: "Hanya admin yang bisa menjalankan sync.", flags: 64 },
    });
  }

  res.json({ type: 5, data: { flags: 64 } });

  waitUntil(
    (async () => {
      try {
        const out = await runCronJob({ redisClient: redis });
        const summary = out.body;
        const msg = `🚀 **Sync Selesai**\nSent: ${summary.sent}, Failed: ${summary.failed}, Duration: ${summary.duration}s\nCek channel <#${process.env.NOTIFICATION_CHANNEL_ID || ""}> atau dashboard.`;
        await editInteractionResponse(payload, msg);
      } catch (err) {
        await editInteractionResponse(
          payload,
          `❌ Sync gagal: ${err.message}`,
        );
      }
    })(),
  );
}
