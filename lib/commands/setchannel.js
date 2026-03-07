import { waitUntil } from "@vercel/functions";
import { InteractionResponseType } from "discord-interactions";
import { editInteractionResponse } from "../discord.js";
import { setNotificationChannel } from "../redis.js";

export default function handleSetchannel(payload, options, res) {
  const guildId = payload.guild_id;
  const rawValue = options?.[0]?.value;
  const channelId =
    typeof rawValue === "string" && rawValue.startsWith("id:")
      ? rawValue.slice(3)
      : String(rawValue ?? "").trim();

  if (!guildId || !/^\d+$/.test(channelId)) {
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "? Invalid input!" },
    });
  }

  res.json({ type: 5 });

  waitUntil(
    (async () => {
      try {
        await setNotificationChannel(guildId, channelId);
        await editInteractionResponse(payload.token, `? Set! <#${channelId}>`);
      } catch (err) {
        await editInteractionResponse(payload.token, `? ${err.message}`);
      }
    })(),
  );
}
