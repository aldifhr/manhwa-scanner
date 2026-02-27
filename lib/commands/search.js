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

  // Defer response immediately — fetch semua halaman bisa makan waktu
  res.json({ type: 5 });

  waitUntil((async () => {
    try {
      const results = await searchIkiru(keyword, {}, redis);

      if (!results || results.length === 0) {
        await editInteractionResponse(
          payload.token,
          `🔍 Tidak ada manga dengan keyword **"${keyword}"** di Ikiru.`
        );
        return;
      }

      const page      = 1;
      const perPage   = 10;
      const total     = results.length;
      const totalPage = Math.ceil(total / perPage);
      const slice     = results.slice(0, perPage);

      const embed      = buildSearchEmbed(keyword, slice, page, totalPage, total);
      const components = buildSearchComponents(keyword, slice, page, totalPage);

      await editInteractionResponseWithComponents(payload.token, "", components, [embed]);
    } catch (err) {
      console.error("handleSearch error:", err);
      await editInteractionResponse(payload.token, `❌ Error: ${err.message}`);
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
    description: slice.map((item, i) =>
      `**${(page - 1) * 10 + i + 1}.** [${item.title}](${item.url})`
    ).join("\n"),
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
    components: [{
      type:        3,
      custom_id:   "select_add",
      placeholder: "➕ Pilih manga untuk di-Add...",
      options:     slice.map((item) => ({
        label: item.title.length > 100
          ? item.title.substring(0, 97) + "..."
          : item.title,
        value: item.url,  // pakai URL sebagai value biar unik & tidak ambigu
        description: item.chapter
          ? `${item.chapter}  •  ${item.status ?? ""}`.trim()
          : item.url.substring(0, 100),
      })),
    }],
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