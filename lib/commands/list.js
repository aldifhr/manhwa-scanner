import { waitUntil } from "@vercel/functions";
import { loadWhitelist } from "../redis.js";
import { editWithComponents, editInteractionResponse } from "../discord.js";

export default function handleList(payload, options, res) {
  res.json({ type: 5 });

  waitUntil((async () => {
    try {
      const whitelist = await loadWhitelist();
      if (!whitelist?.length) {
        await editInteractionResponse(payload.token, "📋 Whitelist kosong!");
        return;
      }

      const pageSize  = 15;
      const page      = Math.max(1, parseInt(options?.[0]?.value) || 1);
      const totalPage = Math.ceil(whitelist.length / pageSize);
      const start     = (page - 1) * pageSize;
      const slice     = whitelist.slice(start, start + pageSize);

      const content = `📋 **Whitelist** (${whitelist.length} manga)\n*Page ${page}/${totalPage}*\n\n${slice.map((title, i) => `${start + i + 1}. ${title}`).join("\n")}`;

      const components = [{
        type: 1,
        components: [
          { type: 2, style: 1, label: "◀ Prev",     custom_id: `list:${page - 1}`, disabled: page <= 1 },
          { type: 2, style: 2, label: `Page ${page}`, custom_id: "noop_list",       disabled: true },
          { type: 2, style: 1, label: "Next ▶",     custom_id: `list:${page + 1}`, disabled: page >= totalPage },
          { type: 2, style: 4, label: "🗑️ Clear All", custom_id: "clear_all" },
        ],
      }];

      await editWithComponents(payload, content, components); // ← payload object, bukan payload.token
    } catch (err) {
      await editInteractionResponse(payload.token, `❌ Error: ${err.message}`);
    }
  })());
}