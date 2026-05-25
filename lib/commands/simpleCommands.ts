import { waitUntil } from "@vercel/functions";
import { InteractionResponseType } from "discord-interactions";
import { setNotificationChannel } from "../services/storage.js";
import {
  editInteractionResponse,
  editInteractionResponseWithComponents,
} from "../discord.js";
import { ensureGuildAdminResponse } from "../permissions.js";
import {
  buildWhitelistListResponse,
} from "../services/whitelist.js";

import { fetchDiscordChannel } from "../services/channelValidation.js";
import { env } from "../config/env.js";
import { DISCORD_EPHEMERAL_FLAG } from "../config.js";
import { getLogger } from "../logger.js";
import { TypedCommandOption } from "../types.js";

const logger = getLogger({ scope: "commands:simple" });


export async function handleList(payload: any, options: TypedCommandOption[], res: any) {
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
      } catch (err: unknown) {
        logger.error({ err: (err as any).message }, "[handleList] Error");
        await editInteractionResponse(
          payload,
          `❌ Gagal memuat daftar: ${(err as any).message}`,
        );
      }
    })(),
  );
}


export function handleSetchannel(payload: any, options: TypedCommandOption[], res: any) {
  const denied = ensureGuildAdminResponse(payload);
  if (denied) return res.json(denied);

  const guildId = payload.guild_id;
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
        // Check if channel is already set
        const { getNotificationChannel } = await import("../services/storage.js");
        const currentChannelId = await getNotificationChannel(guildId);
        
        if (currentChannelId === channelId) {
          await editInteractionResponse(
            payload.token,
            `ℹ️ Channel <#${channelId}> sudah diset sebagai channel notifikasi.`,
          );
          return;
        }

        const channel = await fetchDiscordChannel({
          channelId,
          botToken: env.DISCORD_BOT_TOKEN,
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
        
        if (currentChannelId) {
          await editInteractionResponse(
            payload.token,
            `✅ Channel notifikasi manhwa berhasil diubah dari <#${currentChannelId}> ke <#${channelId}>`,
          );
        } else {
          await editInteractionResponse(
            payload.token,
            `✅ Channel notifikasi manhwa berhasil diset ke <#${channelId}>`,
          );
        }
      } catch (err: unknown) {
        await editInteractionResponse(
          payload.token,
          `❌ Terjadi kesalahan: ${(err as any).message}`,
        );
      }
    })(),
  );
}
