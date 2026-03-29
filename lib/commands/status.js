import { waitUntil }                             from "@vercel/functions";
import { InteractionResponseType } from "discord-interactions";
import { loadWhitelist, getNotificationChannel, redis } from "../redis.js";
import { editInteractionResponse }               from "../discord.js";
import { isGuildAdmin } from "../permissions.js";
import {
  CRON_INTERVAL_LABEL,
  CACHE_TTL_LABEL,
} from "../consts.js";
import { validateDiscordChannel } from "../services/channelValidation.js";

async function checkChannelValid(channelId) {
  return validateDiscordChannel({
    redis,
    channelId,
    botToken: process.env.DISCORD_BOT_TOKEN,
    writeCache: false,
  });
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
    `📊 **Status Bot**\n\n` +
    `📋 Whitelist  : **${whitelist.length}** manga\n` +
    `📢 Channel    : ${channelText}\n` +
    `⏱️ Interval   : ${CRON_INTERVAL_LABEL}\n` +
    `🗑️ Cache TTL  : **${CACHE_TTL_LABEL}**\n` +
    `🔔 Notifikasi : Discord`
  );
}

export default function handleStatus(payload, options, res) {
  void options;
  if (!isGuildAdmin(payload)) {
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "Command ini hanya untuk admin server.", flags: 64 },
    });
  }

  res.json({ type: 5, data: { flags: 64 } });

  waitUntil(
    buildStatusMessage(payload).catch(async (err) => {
      if (payload?.token) {
        await editInteractionResponse(
          payload.token,
          `❌ Terjadi kesalahan: ${err.message}`
        );
      }
    })
  );
}

