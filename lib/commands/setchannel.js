import { waitUntil } from "@vercel/functions";
import { setNotificationChannel } from "../redis.js";
import { editInteractionResponse } from "../discord.js";
import { InteractionResponseType } from "discord-interactions";

export default function handleSetchannel(payload, options, res) {
  const guildId = payload.guild_id;
  const rawValue = options?.[0]?.value;
  
  let channelId;
  if (typeof rawValue === 'string' && rawValue.startsWith('id:')) {
    channelId = rawValue.slice(3);
    console.log(`[JSON-PARSE] "${rawValue}" → "${channelId}"`);
  } else {
    channelId = String(rawValue);
  }

  if (!guildId || !channelId) {
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "❌ Invalid input!" },
    });
  }

  console.log(`[SETCHANNEL] "${channelId}" → guild:${guildId.slice(-4)}`);

  res.json({ type: 5 });

  waitUntil((async () => {
    try {
      await setNotificationChannel(guildId, channelId);
      await editInteractionResponse(payload.token, `✅ Set! <#${channelId}>`);
    } catch (err) {
      await editInteractionResponse(payload.token, `❌ ${err.message}`);
    }
  })());
}


