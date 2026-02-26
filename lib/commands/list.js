import { waitUntil }               from "@vercel/functions";
import { loadWhitelist }           from "../redis.js";
import { editInteractionResponse } from "../discord.js";

export default function handleList(payload, options, res) {
  res.json({ type: 5 });

  waitUntil((async () => {
    try {
      const whitelist = await loadWhitelist();

      if (whitelist.length === 0) {
        await editInteractionResponse(payload.token, "📋 Whitelist kosong!");
        return;
      }

      const pageSize  = 20;
      const page      = Math.max(1, options?.[0]?.value || 1);
      const totalPage = Math.ceil(whitelist.length / pageSize);
      const start     = (page - 1) * pageSize;
      const slice     = whitelist.slice(start, start + pageSize);
      const list      = slice.map((t, i) => `${start + i + 1}. ${t}`).join("\n");

      await editInteractionResponse(payload.token,
        `📋 **Whitelisted Manga (${whitelist.length} total) — Page ${page}/${totalPage}:**\n\n${list}` +
        (totalPage > 1 ? `\n\n*Gunakan \`/list <page>\` untuk halaman lain*` : "")
      );
    } catch (err) {
      await editInteractionResponse(payload.token, `❌ Error: ${err.message}`);
    }
  })());
}
