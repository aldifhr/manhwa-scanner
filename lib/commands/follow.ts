import { InteractionResponseType } from "discord-interactions";
import { redis } from "../redis.js";
import { RedisClient } from "../types.js";
import { unfollowManga, getUserFollowsMembers } from "../services/notifications.js";
import {
  editInteractionResponse,
  editInteractionResponseWithComponents,
} from "../discord.js";
import { waitUntil } from "@vercel/functions";
import { chunkArray, compactArray } from "../utils.js";
import {
  DISCORD_EPHEMERAL_FLAG,
  DISCORD_BUTTON_STYLE,
  DISCORD_COMPONENT_TYPE,
} from "../config.js";
import { getLogger } from "../logger.js";
import { SubcommandOption } from "../types.js";

const logger = getLogger({ scope: "commands:follow" });

export default async function handleFollow(
  payload: any,
  options: SubcommandOption[],
  res: any,
  redisClient: RedisClient = redis,
) {
  const userId = payload.member?.user?.id ?? payload.user?.id;
  const subcommand = options?.[0]?.name;
  const subOptions = options?.[0]?.options || [];

  if (
    subcommand === "list" ||
    (subcommand === "button" && options?.[0]?.value?.startsWith("follow:list:"))
  ) {
    let page = 1;
    if (subcommand === "list") {
      const rawPage = parseInt(subOptions.find((o) => o.name === "page")?.value, 10);
      page = Number.isNaN(rawPage) || rawPage < 1 ? 1 : Math.min(rawPage, 100);
    } else {
      const rawValue = options[0].value as string;
      const rawPage = parseInt(rawValue.split(":")[2], 10);
      page = Number.isNaN(rawPage) || rawPage < 1 ? 1 : Math.min(rawPage, 100);
    }

    if (!res.headersSent) {
      res.json({
        type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
        data: { flags: DISCORD_EPHEMERAL_FLAG },
      });
    }

    waitUntil(
      (async () => {
        try {
          const titleKeys = await getUserFollowsMembers(userId);

          if (!titleKeys || titleKeys.length === 0) {
            return editInteractionResponse(
              payload,
              "Kamu belum mengikuti manga apa pun untuk notifikasi (ping).",
            );
          }

          const whitelistDataRaw = await redisClient.hmget(
            "whitelist:data",
            ...titleKeys,
          );

          let whitelistData: any[] = [];
          if (Array.isArray(whitelistDataRaw)) {
            whitelistData = whitelistDataRaw;
          } else if (whitelistDataRaw && typeof whitelistDataRaw === "object") {
            whitelistData = titleKeys.map((tk) => (whitelistDataRaw as any)[tk]);
          }

          const followData = compactArray(
            titleKeys.map((tk, i) => {
              const item = whitelistData[i];
              return item ? { key: tk, title: item.title } : null;
            }),
          );

          if (followData.length === 0) {
            return editInteractionResponse(
              payload,
              "Kamu belum mengikuti manga apa pun untuk notifikasi (ping).",
            );
          }

          const perPage = 10;
          const paginatedItems = chunkArray(followData, perPage);
          const totalPages = paginatedItems.length || 1;
          const safePage = Math.max(1, Math.min(page, totalPages));
          const pageItems = paginatedItems[safePage - 1] || [];
          const startIdx = (safePage - 1) * perPage;

          const lines = pageItems.map(
            (item, idx) =>
              `${startIdx + idx + 1}. **${item.title || item.key}**`,
          );

          const header = `📚 **Manga yang Kamu Ikuti** (Page ${safePage}/${totalPages})\n`;
          const body = lines.join("\n") || "_Tidak ada data._";
          const footer =
            totalPages > 1
              ? "\n\nGunakan `/follow list page:<number>` untuk navigasi."
              : "";

          const content = header + body + footer;

          const components: any[] = [];
          if (totalPages > 1) {
            const row: any = {
              type: DISCORD_COMPONENT_TYPE.ACTION_ROW,
              components: [],
            };
            if (safePage > 1) {
              row.components.push({
                type: DISCORD_COMPONENT_TYPE.BUTTON,
                style: DISCORD_BUTTON_STYLE.SECONDARY,
                label: "⬅️ Prev",
                custom_id: `follow:list:${safePage - 1}`,
              });
            }
            if (safePage < totalPages) {
              row.components.push({
                type: DISCORD_COMPONENT_TYPE.BUTTON,
                style: DISCORD_BUTTON_STYLE.SECONDARY,
                label: "Next ➡️",
                custom_id: `follow:list:${safePage + 1}`,
              });
            }
            if (row.components.length > 0) {
              components.push(row);
            }
          }

          return editInteractionResponseWithComponents(
            payload,
            content,
            components,
          );
        } catch (err: unknown) {
          logger.error({ err: (err as any).message }, "[handleFollow list] Error");
          return editInteractionResponse(
            payload,
            `❌ Gagal memuat daftar: ${(err as any).message}`,
          );
        }
      })(),
    );

    return;
  }

  if (subcommand === "unfollow" || subcommand === "remove") {
    const query =
      subOptions.find((o) => o.name === "title")?.value ||
      subOptions.find((o) => o.name === "judul")?.value;

    if (!query) {
      return res.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: "❌ Judul manga diperlukan.",
          flags: DISCORD_EPHEMERAL_FLAG,
        },
      });
    }

    if (!res.headersSent) {
      res.json({
        type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
        data: { flags: DISCORD_EPHEMERAL_FLAG },
      });
    }

    waitUntil(
      (async () => {
        try {
          await unfollowManga(userId, query);
          return editInteractionResponse(
            payload,
            `✅ Berhasil unfollow **${query}**. Kamu tidak akan di-ping lagi untuk judul ini.`,
          );
        } catch (err: unknown) {
          return editInteractionResponse(
            payload,
            `❌ Gagal unfollow: ${(err as any).message}`,
          );
        }
      })(),
    );

    return;
  }

  return res.json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content:
        "❌ Subcommand tidak dikenali. Gunakan `/follow list` atau `/follow unfollow`.",
      flags: DISCORD_EPHEMERAL_FLAG,
    },
  });
}
