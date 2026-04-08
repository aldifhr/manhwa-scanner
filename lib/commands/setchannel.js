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
  // Use the channel where the command was invoked
  const channelId = payload.channel_id;

  if (!guildId || !channelId) {
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "❌ Tidak dapat mengidentifikasi channel.", flags: 64 },
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
          await editInteractionResponse(
            payload.token,
            "❌ Channel tidak ditemukan.",
          );
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
          `✅ Channel notifikasi manhwa berhasil diset ke <#${channelId}>`,
        );
      } catch (err) {
        await editInteractionResponse(
          payload.token,
          `❌ Terjadi kesalahan: ${err.message}`,
        );
      }
    })(),
  );
}
