import { InteractionResponseType } from "discord-interactions";
import { redis } from "../redis.js";
import { unfollowManga } from "../services/notifications.js";
import {
  editInteractionResponse,
  editInteractionResponseWithComponents,
} from "../discord.js";
import { waitUntil } from "@vercel/functions";
import { chunkArray, compactArray } from "../utils.js";

export default async function handleFollow(
  payload,
  options,
  res,
  redisClient = redis,
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
      page =
        parseInt(subOptions.find((o) => o.name === "page")?.value, 10) || 1;
    } else {
      page = parseInt(options[0].value.split(":")[2], 10) || 1;
    }

    if (!res.headersSent) {
      res.json({
        type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
        data: { flags: 64 },
      });
    }

    waitUntil(
      (async () => {
        try {
          const followsData = await redisClient.hget("users:follows", userId);

          let titleKeys;
          if (!followsData) {
            titleKeys = [];
          } else if (Array.isArray(followsData)) {
            titleKeys = followsData;
          } else if (typeof followsData === "string") {
            try {
              titleKeys = JSON.parse(followsData);
            } catch {
              titleKeys = [];
            }
          } else {
            titleKeys = [];
          }

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

          let whitelistData = [];
          if (Array.isArray(whitelistDataRaw)) {
            whitelistData = whitelistDataRaw;
          } else if (whitelistDataRaw && typeof whitelistDataRaw === "object") {
            whitelistData = titleKeys.map((tk) => whitelistDataRaw[tk]);
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

          const components = [];
          if (totalPages > 1) {
            const row = {
              type: 1,
              components: [],
            };
            if (safePage > 1) {
              row.components.push({
                type: 2,
                style: 2,
                label: "⬅️ Prev",
                custom_id: `follow:list:${safePage - 1}`,
              });
            }
            if (safePage < totalPages) {
              row.components.push({
                type: 2,
                style: 2,
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
        } catch (err) {
          console.error("[handleFollow list] Error:", err);
          return editInteractionResponse(
            payload,
            `❌ Gagal memuat daftar: ${err.message}`,
          );
        }
      })(),
    );

    return;
  }

  if (subcommand === "unfollow") {
    const query = subOptions.find((o) => o.name === "title")?.value;

    if (!query) {
      return res.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: "❌ Judul manga diperlukan.",
          flags: 64,
        },
      });
    }

    if (!res.headersSent) {
      res.json({
        type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
        data: { flags: 64 },
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
        } catch (err) {
          return editInteractionResponse(
            payload,
            `❌ Gagal unfollow: ${err.message}`,
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
      flags: 64,
    },
  });
}
