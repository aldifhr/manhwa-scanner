import { waitUntil }                    from "@vercel/functions";
import { searchIkiru }                  from "../scraper.js";
import { editInteractionResponse }      from "../discord.js";
import { loadWhitelist, saveWhitelist } from "../redis.js";

export default function handleAdd(payload, options, res, redis = null) {
  const query = options?.[0]?.value;
  if (!query) {
    return res.json({
      type: 4,
      data: { content: "❌ Please provide a manga title!", flags: 64 },
    });
  }

  res.json({ type: 5, data: { flags: 64 } });

  waitUntil((async () => {
    try {
      // Pass redis agar pakai cache, tidak re-fetch setiap kali
      const results = await searchIkiru(query, {}, redis);

      if (!results.length) {
        await editInteractionResponse(
          payload,
          `🔍 Manga **"${query}"** tidak ditemukan.`,
        );
        return;
      }

      // Pakai mangaUrl (halaman manga), bukan url (chapter link)
      const { title, mangaUrl } = results[0];
      const whitelist = await loadWhitelist();

      // Whitelist selalu { title, url }[] — tidak perlu legacy string check
      const exists = whitelist.some(
        (item) =>
          item.title?.toLowerCase() === title.toLowerCase() ||
          (mangaUrl && item.url === mangaUrl),
      );

      if (exists) {
        await editInteractionResponse(
          payload,
          `⚠️ **"${title}"** sudah ada di whitelist!`,
        );
        return;
      }

      const updated = [...whitelist, { title, url: mangaUrl ?? null }];
      await saveWhitelist(updated);

      await editInteractionResponse(
        payload,
        `✅ **"${title}"** ditambahkan!\n` +
        `🔗 ${mangaUrl}\n` +
        `📋 Total: **${updated.length}** manga`,
      );
    } catch (err) {
      console.error("[handleAdd] Error:", err);
      await editInteractionResponse(payload, `❌ Error: ${err.message}`);
    }
  })());
}