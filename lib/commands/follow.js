import { InteractionResponseType } from "discord-interactions";
import { redis } from "../redis.js";

import { unfollowManga } from "../services/notifications.js";
import {
  editInteractionResponse,
  editInteractionResponseWithComponents,
} from "../discord.js";
import { waitUntil } from "@vercel/functions";

export default async function handleFollow(
  payload,
  options,
  res,
  redisClient = redis,
) {
  const userId = payload.member?.user?.id ?? payload.user?.id;
  const subcommand = options?.[0]?.name;
  const subOptions = options?.[0]?.options || [];

  // Handle list subcommand or button pagination
  if (
    subcommand === "list" ||
    (subcommand === "button" && options[0].value.startsWith("follow:list:"))
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
          const followsJson = await redisClient.hget("users:follows", userId);
          const titleKeys = followsJson ? JSON.parse(followsJson) : [];
          if (!titleKeys || titleKeys.length === 0) {
            return editInteractionResponse(
              payload,
              "Kamu belum mengikuti manga apa pun untuk notifikasi (ping).",
            );
          }

          // Fetch display titles from whitelist:data
          let whitelistDataRaw = await redisClient.hmget(
            "whitelist:data",
            ...titleKeys,
          );

          // Upstash hmget sometimes returns an object { field: value } instead of an array
          let whitelistData = [];
          if (Array.isArray(whitelistDataRaw)) {
            whitelistData = whitelistDataRaw;
          } else if (whitelistDataRaw && typeof whitelistDataRaw === "object") {
            whitelistData = titleKeys.map((tk) => whitelistDataRaw[tk]);
          }

          // Filter out nulls and format
          const followData = titleKeys
            .map((tk, i) => {
              const item = whitelistData[i];
              return item ? { key: tk, title: item.title } : null;
            })
            .filter(Boolean);

          if (followData.length === 0) {
            return editInteractionResponse(
              payload,
              "Kamu belum mengikuti manga apa pun untuk notifikasi (ping).",
            );
          }

          // Sort alphabetically by title
          followData.sort((a, b) => a.title.localeCompare(b.title));

          // Paginate (10 per page)
          const pageSize = 10;
          const totalPage = Math.ceil(followData.length / pageSize) || 1;
          const pageSafe = Math.min(Math.max(1, page), totalPage);
          const start = (pageSafe - 1) * pageSize;
          const slice = followData.slice(start, start + pageSize);

          if (slice.length === 0 && pageSafe > 1) {
            return editInteractionResponse(payload, "Halaman ini kosong.");
          }

          const lines = slice.map(
            (item, i) => `${start + i + 1}. **${item.title}**`,
          );
          const content = `⭐ **Manga yang Kamu Ikuti (Notifikasi):**\n\n${lines.join("\n")}\n\n*Halaman ${pageSafe}/${totalPage}*`;

          const components =
            totalPage > 1
              ? [
                  {
                    type: 1,
                    components: [
                      {
                        type: 2,
                        style: 1,
                        label: "Sebelumnya",
                        custom_id: `follow:list:${pageSafe - 1}`,
                        disabled: pageSafe <= 1,
                      },
                      {
                        type: 2,
                        style: 2,
                        label: `Hal ${pageSafe}`,
                        custom_id: "noop",
                        disabled: true,
                      },
                      {
                        type: 2,
                        style: 1,
                        label: "Berikutnya",
                        custom_id: `follow:list:${pageSafe + 1}`,
                        disabled: pageSafe >= totalPage,
                      },
                    ],
                  },
                ]
              : [];

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

  if (subcommand === "remove") {
    const query = subOptions.find((o) => o.name === "judul")?.value;
    if (!query)
      return res.json({
        type: 4,
        data: { content: "Masukkan judul manga.", flags: 64 },
      });

    res.json({
      type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      data: { flags: 64 },
    });

    waitUntil(
      (async () => {
        try {
          await unfollowManga(userId, query);
          return editInteractionResponse(
            payload,
            `✅ Berhasil unfollow **${query}**. Kamu tidak akan di-ping lagi untuk judul ini.`,
          );
        } catch (err) {
          return editInteractionResponse(payload, `❌ Gagal: ${err.message}`);
        }
      })(),
    );
    return;
  }

  return res.json({
    type: 4,
    data: { content: "Subcommand tidak valid.", flags: 64 },
  });
}
