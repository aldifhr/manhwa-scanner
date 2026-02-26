// lib/commands/list.js (update)
import { waitUntil } from "@vercel/functions";
import { editWithComponents, editInteractionResponse } from "../discord.js"

export default function handleList(payload, options, res) {
  res.json({ type: 5 });

  waitUntil((async () => {
    try {
      const whitelist = await loadWhitelist();
      if (whitelist.length === 0) {
        await editInteractionResponse(payload.token, "📋 Whitelist kosong!");
        return;
      }

      const pageSize = 20;
      const page = Math.max(1, options?.[0]?.value || 1);
      const totalPage = Math.ceil(whitelist.length / pageSize);
      const start = (page - 1) * pageSize;
      const slice = whitelist.slice(start, start + pageSize);
      const list = slice.map((t, i) => `${start + i + 1}. ${t}`).join("\n");

      const content = `📋 **Whitelisted Manga (${whitelist.length} total) — Page ${page}/${totalPage}:**\n\n${list}`;

      // Tambah components: tombol next/prev + select page
      const components = [
        {
          type: 1,  // ActionRow
          components: [
            { type: 2, label: "◀️ Prev", style: 1, custom_id: `list:${page - 1}`, disabled: page <= 1 },
            { type: 2, label: `Page ${page}`, style: 2, disabled: true },
            { type: 2, label: "▶️ Next", style: 1, custom_id: `list:${page + 1}`, disabled: page >= totalPage }
          ]
        }
      ];

      await editWithComponents(payload.token, content, components);
    } catch (err) {
      await editInteractionResponse(payload.token, `❌ Error: ${err.message}`);
    }
  })());
}
