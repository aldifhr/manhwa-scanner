import { redis } from "../redis.js";
import { editWithComponents, editInteractionResponse } from "../discord.js";

export default async function handleList(
  payload,
  options,
  res,
  isComponent = false // ← penting!
) {
  try {
    // ✅ Kalau dari slash command → kirim defer dulu
    if (!isComponent) {
      res.json({ type: 5 }); // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
    }

    // ✅ Ambil data langsung dari Redis (hindari cache Vercel)
    const raw = await redis.get("whitelist:manga");
    const data = raw ? JSON.parse(raw) : [];

    const whitelist = data.map((item) =>
      typeof item === "string"
        ? { title: item, url: null }
        : item
    );

    if (!whitelist.length) {
      await editInteractionResponse(payload.token, "📋 Whitelist kosong!");
      return;
    }

    const pageSize = 15;
    const page = Math.max(1, parseInt(options?.[0]?.value) || 1);
    const totalPage = Math.ceil(whitelist.length / pageSize);

    const safePage = Math.min(page, totalPage); // biar gak overflow
    const start = (safePage - 1) * pageSize;
    const slice = whitelist.slice(start, start + pageSize);

    const content =
      `📋 **Whitelist** (${whitelist.length} manga)\n` +
      `*Page ${safePage}/${totalPage}*\n\n` +
      slice
        .map((item, i) => `${start + i + 1}. ${item.title}`)
        .join("\n");

    const components = [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 1,
            label: "◀ Prev",
            custom_id: `list:${safePage - 1}`,
            disabled: safePage <= 1,
          },
          {
            type: 2,
            style: 2,
            label: `Page ${safePage}`,
            custom_id: "noop_list",
            disabled: true,
          },
          {
            type: 2,
            style: 1,
            label: "Next ▶",
            custom_id: `list:${safePage + 1}`,
            disabled: safePage >= totalPage,
          },
        ],
      },
    ];

    // ✅ Edit original interaction (baik slash maupun button)
    await editWithComponents(payload, content, components);
  } catch (err) {
    console.error("❌ handleList error:", err);

    await editInteractionResponse(
      payload.token,
      `❌ Error: ${err.message}`
    );
  }
}