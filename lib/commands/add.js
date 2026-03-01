import { waitUntil } from "@vercel/functions";
import { loadWhitelist, saveWhitelist } from "../redis.js";
import { editInteractionResponse } from "../discord.js";
import { searchIkiru } from "../scraper.js";

export default function handleAdd(payload, options, res, redis) {
  const query = options?.[0]?.value;
  if (!query) {
    return res.json({
      type: 4,
      data: { content: "❌ Please provide a manga title!", flags: 64 },
    });
  }

  res.json({ type: 5, data: { flags: 64 } });

  waitUntil(
    (async () => {
      try {
        // Search dulu biar dapat URL yang valid
        const results = await searchIkiru(query, {}, redis);
        if (!results.length) {
          await editInteractionResponse(
            payload.token,
            `🔍 Manga **"${query}"** tidak ditemukan.`,
          );
          return;
        }

        const { title, url } = results[0];
        const whitelist = await loadWhitelist();

        const exists = whitelist.some(
          (item) =>
            (typeof item === "string" ? item : item.title)?.toLowerCase() ===
              title.toLowerCase() || item?.url === url,
        );

        if (exists) {
          await editInteractionResponse(
            payload.token,
            `⚠️ **"${title}"** sudah ada di whitelist!`,
          );
          return;
        }

        const currentWhitelist = await loadWhitelist();
        const updatedWhitelist = [...currentWhitelist, { title, url }]; // ✅ IMMUTABLE
        await saveWhitelist(updatedWhitelist);

        await editInteractionResponse(
          payload.token,
          `✅ **"${title}"** ditambahkan!\n🔗 ${url}\n📋 Total: **${updatedWhitelist.length}** manga`, // ✅ FIX
        );
      } catch (err) {
        await editInteractionResponse(payload.token, `❌ ${err.message}`);
      }
    })(),
  );
}
