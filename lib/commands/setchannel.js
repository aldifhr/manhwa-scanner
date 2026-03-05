import { waitUntil } from "@vercel/functions";
import { setNotificationChannel } from "../redis.js";
import { editInteractionResponse } from "../discord.js";
import { InteractionResponseType } from "discord-interactions";

export default function handleSetchannel(payload, options, res) {
  const guildId = payload.guild_id;
  const channelId = options?.[0]?.value;

  if (!guildId) {
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "❌ This command only works in servers!" },
    });
  }
  if (!channelId) {
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "❌ Please provide a channel!" },
    });
  }

  res.json({ type: 5 });

  waitUntil(
    (async () => {
      try {
        console.log(
          `[SETCHANNEL] Guild: ${guildId}, Input Channel: "${channelId}" (len=${channelId?.length}, type=${typeof channelId})`,
        );
        await setNotificationChannel(guildId, channelId);
        await editInteractionResponse(
          payload.token,
          `✅ **Notification channel set!**\nManga updates akan dikirim ke <#${channelId}>`,
        );
      } catch (err) {
        await editInteractionResponse(
          payload.token,
          `❌ Error: ${err.message}`,
        );
      }
    })(),
  );
}
