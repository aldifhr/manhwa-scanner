import { InteractionResponseType } from "discord-interactions";
import { redis }                   from "../redis.js";

export default async function handlePing(payload, options, res) {
  const start = Date.now();

  let redisStatus = "✅ Online";
  try {
    await redis.ping();
  } catch {
    redisStatus = "❌ Offline";
  }

  const latency = Date.now() - start;

  return res.json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content:
        `🏓 **Pong!**\n\n` +
        `⚡ Latency  : \`${latency}ms\`\n` +
        `🗄️ Redis    : ${redisStatus}\n` +
        `🤖 Bot      : \`Online\``,
    },
  });
}
