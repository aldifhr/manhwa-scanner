import { waitUntil } from "@vercel/functions";
import { setNotificationChannel } from "../redis.js";
import { editInteractionResponse } from "../discord.js";
import { InteractionResponseType } from "discord-interactions";

export default function handleSetchannel(payload, options, res) {
  const guildId = payload.guild_id;
  const rawValue = options?.[0]?.value;
  
  let channelId;
  if (rawValue?.startsWith('id:')) {
    channelId = rawValue.slice(3);
    console.log(`Parsed: "${rawValue}" → "${channelId}"`);
  } else {
    channelId = String(rawValue);
  }

  // Validasi
  if (!guildId) return res.json({ type: 4, data: { content: "❌ Server only!" } });
  if (!channelId || channelId.length < 17) return res.json({ type: 4, data: { content: "❌ Invalid channel!" } });

  console.log(`[SETCHANNEL] Guild:${guildId.slice(-4)} Channel:"${channelId}"`);

  res.json({ type: 5 });

  waitUntil((async () => {
    try {
      await setNotificationChannel(guildId, channelId);
      await editInteractionResponse(payload.token, `✅ Channel set! <#${channelId}>`);
    } catch (err) {
      await editInteractionResponse(payload.token, `❌ ${err.message}`);
    }
  })());
}

