import { editWithComponents }                        from "../discord.js";
import { searchIkiru }                               from "../scraper.js";

export default async function handleSearchPage(payload, keyword, page) {
  try {
    const results   = await searchIkiru(keyword);
    const perPage   = 5;
    const total     = results.length;
    const totalPage = Math.ceil(total / perPage);
    const safePage  = Math.max(1, Math.min(page, totalPage));
    const slice     = results.slice((safePage - 1) * perPage, safePage * perPage);

    const content    = `🔍 **Hasil pencarian "${keyword}"** — ${total} ditemukan (hal. ${safePage}/${totalPage})`;
    const components = slice.map((item, index) => ({
      type: 1,
      components: [
        {
          type:      2,
          style:     2,
          label:     item.title.length > 60
            ? item.title.substring(0, 57) + "..."
            : item.title,
          custom_id: `noop_${index}`,
          disabled:  true,
        },
        {
          type:      2,
          style:     3,
          label:     "➕ Add",
          custom_id: `add:${item.title.substring(0, 90)}`,
        },
        {
          type:  2,
          style: 5,
          label: "📖 Baca",
          url:   item.url,
        },
      ],
    }));

    const navRow = {
      type: 1,
      components: [
        {
          type:      2,
          style:     2,
          label:     "◀ Prev",
          custom_id: `search:${keyword}:${safePage - 1}`,
          disabled:  safePage <= 1,
        },
        {
          type:      2,
          style:     2,
          label:     `${safePage} / ${totalPage}`,
          custom_id: `noop_nav`,
          disabled:  true,
        },
        {
          type:      2,
          style:     2,
          label:     "Next ▶",
          custom_id: `search:${keyword}:${safePage + 1}`,
          disabled:  safePage >= totalPage,
        },
      ],
    };

    await editWithComponents(payload, content, [...components, navRow]);
  } catch (err) {
    await editWithComponents(payload, `❌ Error: ${err.message}`, []);
  }
}
