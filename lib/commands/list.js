import { loadWhitelist } from "../redis.js"
import { editInteractionResponseWithComponents, editWithComponents } from "../discord.js";

export default async function handleList(payload, options, isComponent = false) {
  try {
    const whitelist = await loadWhitelist();

    if (!whitelist.length) {
      return isComponent
        ? editWithComponents(payload, "📋 Whitelist kosong!", [])
        : editInteractionResponseWithComponents(payload.token, "📋 Whitelist kosong!", []);
    }

    const pageSize = 15;
    const page = Math.max(1, parseInt(options?.[0]?.value) || 1);
    const totalPage = Math.ceil(whitelist.length / pageSize);
    const safePage = Math.min(page, totalPage);
    const start = (safePage - 1) * pageSize;
    const slice = whitelist.slice(start, start + pageSize);

    const content =
      `📋 **Whitelist** (${whitelist.length} manga)\n` +
      `*Page ${safePage}/${totalPage}*\n\n` +
      slice.map((item, i) => `${start + i + 1}. ${item.title}`).join("\n");

    const components = [
      {
        type: 1,
        components: [
          {
            type: 2, style: 1, label: "◀ Prev",
            custom_id: `list:${safePage - 1}`,
            disabled: safePage <= 1,
          },
          {
            type: 2, style: 2, label: `Page ${safePage}`,
            custom_id: "noop", disabled: true,
          },
          {
            type: 2, style: 1, label: "Next ▶",
            custom_id: `list:${safePage + 1}`,
            disabled: safePage >= totalPage,
          },
        ],
      },
    ];

    // ✅ Both paths now send components
    if (isComponent) {
      return editWithComponents(payload, content, components);
    }
    return editInteractionResponseWithComponents(payload.token, content, components);

  } catch (err) {
    console.error("handleList error:", err);
    return isComponent
      ? editWithComponents(payload, `❌ ${err.message}`, [])
      : editInteractionResponseWithComponents(payload.token, `❌ ${err.message}`, []);
  }
}