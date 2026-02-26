import { waitUntil }                                from "@vercel/functions";
import { editInteractionResponse,
         editInteractionResponseWithComponents }    from "../discord.js";
import { searchIkiru }                              from "../scraper.js";
import { InteractionResponseType }                  from "discord-interactions";

export default function handleSearch(payload, options, res) {
  const keyword = options?.[0]?.value;
  if (!keyword) {
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "❌ Please provide a keyword!" },
    });
  }

  res.json({ type: 5 });

  waitUntil((async () => {
    try {
      const results = await searchIkiru(keyword);

      if (results.length === 0) {
        await editInteractionResponse(payload.token,
          `🔍 Tidak ada manga dengan keyword **"${keyword}"** di Ikiru.`
        );
        return;
      }

      // Pagination — ambil page dari options kalau ada, default 1
      const page     = 1;
      const perPage  = 5;
      const total    = results.length;
      const totalPage = Math.ceil(total / perPage);
      const slice    = results.slice((page - 1) * perPage, page * perPage);

      const content    = `🔍 **Hasil pencarian "${keyword}"** — ${total} ditemukan (hal. ${page}/${totalPage})`;
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

      // Tombol navigasi pagination
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
            custom_id: `noop_nav`,
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

      await editInteractionResponseWithComponents(
        payload.token,
        content,
        [...components, navRow]
      );
    } catch (err) {
      await editInteractionResponse(payload.token, `❌ Error: ${err.message}`);
    }
  })());
}
