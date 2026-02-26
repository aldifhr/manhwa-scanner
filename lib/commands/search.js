import { waitUntil }                                          from "@vercel/functions";
import { editInteractionResponse,
         editInteractionResponseWithComponents }              from "../discord.js";
import { scrapeMangaUpdates }                                 from "../scraper.js";
import { redis }                                              from "../redis.js";
import { InteractionResponseType }                            from "discord-interactions";

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
      const allResults = await scrapeMangaUpdates(redis);
      const results    = allResults.filter((item) =>
        item.title.toLowerCase().includes(keyword.toLowerCase())
      );

      if (results.length === 0) {
        await editInteractionResponse(payload.token,
          `🔍 Tidak ada manga dengan keyword **"${keyword}"** di update terbaru.`
        );
        return;
      }

      const slice      = results.slice(0, 5);
      const content    = `🔍 **Hasil pencarian "${keyword}" (${results.length} ditemukan):**`;
      const components = slice.map((item) => ({
        type: 1,
        components: [
          {
            type:      2,
            style:     2,
            label:     item.title.length > 60
              ? item.title.substring(0, 57) + "..."
              : item.title,
            custom_id: "noop",
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

      await editInteractionResponseWithComponents(payload.token, content, components);
    } catch (err) {
      await editInteractionResponse(payload.token, `❌ Error: ${err.message}`);
    }
  })());
}
