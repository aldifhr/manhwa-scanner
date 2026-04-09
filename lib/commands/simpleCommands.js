import { waitUntil } from "@vercel/functions";
import { InteractionResponseType } from "discord-interactions";
import { redis, setNotificationChannel } from "../redis.js";
import {
  editInteractionResponse,
  editInteractionResponseWithComponents,
} from "../discord.js";
import { ensureGuildAdminResponse, isGuildAdmin } from "../permissions.js";
import { sourceLabel } from "../domain.js";
import {
  buildWhitelistListResponse,
} from "../services/whitelist.js";

import { fetchDiscordChannel } from "../services/channelValidation.js";
import { DISCORD_EPHEMERAL_FLAG, DISCORD_RESPONSE_TYPE } from "../config.js";
import { getLogger } from "../logger.js";

const logger = getLogger({ scope: "commands:simple" });

// ============ /list ============
export async function handleList(payload, options, res) {
  const page = Number(options?.find((o) => o.name === "page")?.value || 1);
  const search = options?.find((o) => o.name === "search")?.value || null;
  const filter = options?.find((o) => o.name === "filter")?.value || null;

  res.json({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: DISCORD_EPHEMERAL_FLAG },
  });

  waitUntil(
    (async () => {
      try {
        const { content, components } = await buildWhitelistListResponse(
          page,
          10,
          { search, filter },
        );
        await editInteractionResponseWithComponents(payload, content, components);
      } catch (err) {
        logger.error({ err: err.message }, "[handleList] Error");
        await editInteractionResponse(
          payload,
          `❌ Gagal memuat daftar: ${err.message}`,
        );
      }
    })(),
  );
}

// ============ /setchannel ============
export function handleSetchannel(payload, options, res) {
  const denied = ensureGuildAdminResponse(payload);
  if (denied) return res.json(denied);

  const guildId = payload.guild_id;
  // Get channel from option (type 7 - CHANNEL)
  const channelId = options?.find((o) => o.name === "channel")?.value;

  if (!guildId || !channelId) {
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: "❌ Silakan pilih channel untuk notifikasi.",
        flags: DISCORD_EPHEMERAL_FLAG,
      },
    });
  }

  res.json({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: DISCORD_EPHEMERAL_FLAG },
  });

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
