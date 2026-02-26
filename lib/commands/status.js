import { waitUntil }                              from "@vercel/functions";
import { loadWhitelist, getNotificationChannel }  from "../redis.js";
import { editInteractionResponse }                from "../discord.js";

export default function handleStatus(payload, options, res) {
  res.json({ type: 5 });

  waitUntil((async () => {
    try {
      const whitelist   = await loadWhitelist();
      const guildId     = payload.guild_id;
      const channelId   = guildId ? await getNotificationChannel(guildId) : null;
      const channelText = channelId ? `<#${channelId}>` : "`Belum diset`";

      await editInteractionResponse(payload.token,
        `📊 **Bot Status**\n\n` +
        `📋 Whitelisted : **${whitelist.length}** manga\n` +
        `📢 Channel     : ${channelText}\n` +
        `⏱️ Interval    : Every 5 minutes\n` +
        `🗑️ Cache TTL   : **3 hari**\n` +
        `🔔 Notifikasi  : Discord`
      );
    } catch (err) {
      await editInteractionResponse(payload.token, `❌ Error: ${err.message}`);
    }
  })());
}
