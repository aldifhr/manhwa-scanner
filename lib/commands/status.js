import { waitUntil }                             from "@vercel/functions";
import { loadWhitelist, getNotificationChannel } from "../redis.js";
import { editInteractionResponse }               from "../discord.js";
import {
  CRON_INTERVAL_LABEL,
  CACHE_TTL_LABEL,
} from "../consts.js";

async function buildStatusMessage(payload) {
  // Guard: ensure payload has required fields before proceeding
  if (!payload?.token) throw new Error("Invalid payload: missing token");

  const whitelist  = await loadWhitelist();
  const guildId    = payload.guild_id ?? null;
  const channelId  = guildId ? await getNotificationChannel(guildId) : null;
  const channelText = channelId ? `<#${channelId}>` : "`Belum diset`";

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

  // Fix: named async function instead of IIFE for readability
  waitUntil(
    buildStatusMessage(payload).catch(async (err) => {
      // Guard: only attempt edit if token exists
      if (payload?.token) {
        await editInteractionResponse(
          payload.token,
          `❌ Error: ${err.message}`
        );
      }
    })
  );
}