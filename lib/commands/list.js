export default function handleList(payload, options, res) {
  res.json({ type: 5 });

  waitUntil(async () => {
    try {
      const whitelist = await loadWhitelist();
      if (!whitelist?.length) {
        await editInteractionResponse(payload.token, "📋 Whitelist kosong!");
        return;
      }

      // ✅ Ambil page dari custom_id tombol, fallback ke 1
      let page = 1;
      if (payload.data?.custom_id?.startsWith("list:")) {
        const p = parseInt(payload.data.custom_id.split(":")[1]);
        page = isNaN(p) || p < 1 ? 1 : p;
      }

      const pageSize  = 15;
      const totalPage = Math.ceil(whitelist.length / pageSize);
      if (page > totalPage) page = totalPage;

      const start = (page - 1) * pageSize;
      const slice = whitelist.slice(start, start + pageSize);

      const content = `📋 **Whitelist** (${whitelist.length} manga)\n*Page ${page}/${totalPage}*\n\n${slice
        .map((item, i) => `${start + i + 1}. ${item.title}`)
        .join("\n")}`;

      const components = [{
        type: 1,
        components: [
          { type: 2, style: 1, label: "◀ Prev",     custom_id: `list:${page - 1}`, disabled: page <= 1 },
          { type: 2, style: 2, label: `Page ${page}`, custom_id: "noop_list",       disabled: true },
          { type: 2, style: 1, label: "Next ▶",     custom_id: `list:${page + 1}`, disabled: page >= totalPage },
          { type: 2, style: 4, label: "🗑️ Clear All", custom_id: "clear_all" },
        ],
      }];

      await editWithComponents(payload, content, components);
    } catch (err) {
      console.error("handleList error:", err);
      await editInteractionResponse(payload.token, `❌ Error: ${err.message}`);
    }
  })();
}