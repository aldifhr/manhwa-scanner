import { waitUntil }                             from "@vercel/functions";
import { loadWhitelist, getNotificationChannel } from "../redis.js";
import { editInteractionResponse }               from "../discord.js";
import axios                                     from "axios";
import {
  CRON_INTERVAL_LABEL,
  CACHE_TTL_LABEL,
} from "../consts.js";

async function checkChannelValid(channelId) {
  try {
    await axios.get(`https://discord.com/api/v10/channels/${channelId}`, {
      headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` },
    });
    return true;
  } catch {
    return false;
  }
}

async function buildStatusMessage(payload) {
  if (!payload?.token) throw new Error("Invalid payload: missing token");

  const whitelist   = await loadWhitelist();
  const guildId     = payload.guild_id ?? null;
  const channelId   = guildId ? await getNotificationChannel(guildId) : null;

  let channelText;
  if (!channelId) {
    channelText = "`Belum diset`";
  } else {
    const valid = await checkChannelValid(channelId);
    channelText = valid
      ? `<#${channelId}> ✅`
      : `<#${channelId}> ⚠️ *(channel tidak valid / bot tidak punya akses)*`;
  }

  await editInteractionResponse(
    payload.token,
    `📊 **Bot Status**\n\n` +
    `📋 Whitelisted : **${whitelist.length}** manga\n` +
    `📢 Channel     : ${channelText}\n` +
    `⏱️ Interval    : ${CRON_INTERVAL_LABEL}\n` +
    `🗑️ Cache TTL   : **${CACHE_TTL_LABEL}**\n` +
    `🔔 Notifikasi  : Discord`
  );
}

export default function handleStatus(payload, options, res) {
  res.json({ type: 5 });

  waitUntil(
    buildStatusMessage(payload).catch(async (err) => {
      if (payload?.token) {
        await editInteractionResponse(
          payload.token,
          `❌ Error: ${err.message}`
        );
      }
    })
  );
}