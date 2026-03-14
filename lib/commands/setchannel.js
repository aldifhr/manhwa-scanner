import { waitUntil } from "@vercel/functions";
import { InteractionResponseType } from "discord-interactions";
import { editInteractionResponse } from "../discord.js";
import { setNotificationChannel } from "../redis.js";
import { ensureGuildAdminResponse } from "../permissions.js";
import { fetchDiscordChannel } from "../services/channelValidation.js";

export default function handleSetchannel(payload, options, res) {
  const denied = ensureGuildAdminResponse(payload);
  if (denied) {
    return res.json(denied);
  }

  const guildId = payload.guild_id;
  const rawValue = options?.[0]?.value;
  const channelId =
    typeof rawValue === "string" && rawValue.startsWith("id:")
      ? rawValue.slice(3)
      : String(rawValue ?? "").trim();

  if (!guildId || !/^\d+$/.test(channelId)) {
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "❌ Invalid input!", flags: 64 },
    });
  }

  res.json({ type: 5, data: { flags: 64 } });

  waitUntil(
    (async () => {
      try {
        const channel = await fetchDiscordChannel({
          channelId,
          botToken: process.env.DISCORD_BOT_TOKEN,
        });
        if (!channel) {
          await editInteractionResponse(payload.token, "❌ Channel tidak ditemukan.");
          return;
        }
        if (String(channel.guild_id || "") !== String(guildId)) {
          await editInteractionResponse(
            payload.token,
            "❌ Channel harus berasal dari server yang sama.",
          );
          return;
        }

        await setNotificationChannel(guildId, channelId);
        await editInteractionResponse(
          payload.token,
          `✅ Channel notifikasi manhwa diset ke <#${channelId}>`,
        );
      } catch (err) {
        await editInteractionResponse(payload.token, `❌ ${err.message}`);
      }
    })(),
  );
}
