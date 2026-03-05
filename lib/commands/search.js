// ─── search.js ────────────────────────────────────────────────────────────────
import { waitUntil }                             from "@vercel/functions";
import { editInteractionResponse,
         editInteractionResponseWithComponents } from "../discord.js";
import { searchIkiru }                           from "../scraper.js";
import { InteractionResponseType }               from "discord-interactions";

export default function handleSearch(payload, options, res, redis = null) {
  const keyword = options?.[0]?.value;
  if (!keyword) {
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "❌ Please provide a keyword!" },
    });
  }

  res.json({ type: 5, data: { flags: 64 } });

  waitUntil((async () => {
    try {
      const results = await searchIkiru(keyword, {}, redis);

      if (!results || results.length === 0) {
        await editInteractionResponse(
          payload,
          `🔍 Tidak ada manga dengan keyword **"${keyword}"** di Ikiru.`,
        );
        return;
      }

      // Simpan ke Redis untuk lookup saat user pilih dropdown
      // Upstash auto-serialize — tidak perlu JSON.stringify
      if (redis) {
        await redis
          .set(`search:results:${keyword}`, results, { ex: 300 })
          .catch((err) =>
            console.warn("[handleSearch] Redis set failed:", err.message),
          );
      }

      const page      = 1;
      const perPage   = 10;
      const total     = results.length;
      const totalPage = Math.ceil(total / perPage);
      const slice     = results.slice(0, perPage);

      const embed      = buildSearchEmbed(keyword, slice, page, totalPage, total);
      const components = buildSearchComponents(keyword, slice, page, totalPage);

      await editInteractionResponseWithComponents(payload, "", components, [embed]);
    } catch (err) {
      console.error("[handleSearch] Error:", err);
      await editInteractionResponse(payload, `❌ Error: ${err.message}`);
    }
  })());
}

// ─── Build Embed ──────────────────────────────────────────────────────────────

export function buildSearchEmbed(keyword, slice, page, totalPage, total) {
  return {
    color:  0x5865f2,
    author: {
      name:     `🔍 Hasil pencarian "${keyword}"`,
      icon_url: "https://02.ikiru.wtf/wp-content/uploads/2025/06/logo-ikiru-264736-Qt7APF3i.png",
    },
    // Link ke halaman manga (mangaUrl), bukan chapter (url)
    description: slice
      .map(
        (item, i) =>
          `**${(page - 1) * 10 + i + 1}.** [${item.title}](${item.mangaUrl ?? item.url})`,
      )
      .join("\n"),
    thumbnail: slice[0]?.cover ? { url: slice[0].cover } : undefined,
    footer: {
      text: `ikiru.wtf  •  ${total} ditemukan  •  Hal. ${page}/${totalPage}`,
    },
    timestamp: new Date().toISOString(),
  };
}

// ─── Build Components ─────────────────────────────────────────────────────────

export function buildSearchComponents(keyword, slice, page, totalPage) {
  const selectRow = {
    type: 1,
    components: [
      {
        type:        3,
        custom_id:   "select_add",
        placeholder: "➕ Pilih manga untuk di-Add...",
        options: slice.map((item) => {
          const rawDesc = item.chapter
            ? `${item.chapter}${item.status ? "  •  " + item.status : ""}`
            : (item.status ?? "");
          const description = rawDesc.substring(0, 100) || "Tidak ada info";

          // Pakai slug sebagai identifier — lebih stabil dari index
          const value = `${keyword}|||${item.slug ?? item.mangaUrl ?? item.url}`;

          return {
            label:       item.title.length > 100
              ? item.title.substring(0, 97) + "..."
              : item.title,
            value:       value.substring(0, 100),
            description,
          };
        }),
      },
    ],
  };

  const navRow = {
    type: 1,
    components: [
      {
        type:      2,
        style:     2,
        label:     "◀ Prev",
        custom_id: `search:${keyword}:${page - 1}`,
        disabled:  page <= 1,
      },
      {
        type:      2,
        style:     2,
        label:     `${page} / ${totalPage}`,
        custom_id: "noop_nav",
        disabled:  true,
      },
      {
        type:      2,
        style:     2,
        label:     "Next ▶",
        custom_id: `search:${keyword}:${page + 1}`,
        disabled:  page >= totalPage,
      },
    ],
  };

  return [selectRow, navRow];
}