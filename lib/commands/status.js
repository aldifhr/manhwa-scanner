import { waitUntil }                             from "@vercel/functions";
import { loadWhitelist, getNotificationChannel, redis } from "../redis.js";
import { editInteractionResponse }               from "../discord.js";
import {
  CRON_INTERVAL_LABEL,
  CACHE_TTL_LABEL,
} from "../consts.js";
import { httpGet } from "../httpClient.js";

const CHANNEL_VALIDATION_CACHE_SEC = 60 * 10;

async function checkChannelValid(channelId) {
  const cacheKey = `cache:channel-valid:${channelId}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached === true) return true;
    if (cached === false) return false;
  } catch {
    // ignore cache read errors
  }

  try {
    await httpGet(
      `https://discord.com/api/v10/channels/${channelId}`,
      {
        headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` },
        timeout: 10000,
      },
      {
        retries: 2,
      },
    );
    await redis.set(cacheKey, true, { ex: CHANNEL_VALIDATION_CACHE_SEC }).catch(() => {});
    return true;
  } catch (err) {
    const status = err?.response?.status;
    if (status === 404 || status === 403) {
      await redis.set(cacheKey, false, { ex: CHANNEL_VALIDATION_CACHE_SEC }).catch(() => {});
    }
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
