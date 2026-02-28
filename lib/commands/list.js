import { redis, loadWhitelist } from "../redis.js"
import { editWithComponents, editInteractionResponse } from "../discord.js";

export default async function handleList(payload, options, res) {

  res.json({ type: 5 });
  
  try {
    // ✅ Fetch langsung dari Redis untuk bypass cache antar Vercel instance
    const raw = await redis.get("whitelist:manga");
    const data = Array.isArray(raw) ? raw : raw ? JSON.parse(raw) : [];
    const whitelist = data.map((item) =>
      typeof item === "string" ? { title: item, url: null } : item,
    );

    if (!whitelist.length) {
      await editInteractionResponse(payload.token, "📋 Whitelist kosong!");
      return;
    }

    const pageSize = 15;
    const page = Math.max(1, parseInt(options?.[0]?.value) || 1);
    const totalPage = Math.ceil(whitelist.length / pageSize);
    const start = (page - 1) * pageSize;
    const slice = whitelist.slice(start, start + pageSize);

    const content =
      `📋 **Whitelist** (${whitelist.length} manga)\n*Page ${page}/${totalPage}*\n\n` +
      slice.map((item, i) => `${start + i + 1}. ${item.title}`).join("\n");

    const components = [
      {
        type: 1,
        components: [
          { type: 2, style: 1, label: "◀ Prev",      custom_id: `list:${page - 1}`, disabled: page <= 1 },
          { type: 2, style: 2, label: `Page ${page}`, custom_id: "noop_list",        disabled: true },
          { type: 2, style: 1, label: "Next ▶",      custom_id: `list:${page + 1}`, disabled: page >= totalPage },
        ],
      },
    ];

    await editWithComponents(payload, content, components);
  } catch (err) {
    console.error(err);
    await editInteractionResponse(payload.token, `❌ Error: ${err.message}`);
  }
}