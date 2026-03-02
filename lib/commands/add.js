import { waitUntil } from "@vercel/functions";
import { searchIkiru } from "../scraper.js";
import { editInteractionResponse } from "../discord.js";
import { loadWhitelist, saveWhitelist } from "../discord.js"

export default function handleAdd(payload, options, res) {
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
        const results = await searchIkiru(query);
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

        const updatedWhitelist = [...whitelist, { title, url }];
        await saveWhitelist(updatedWhitelist);

        await editInteractionResponse(
          payload.token,
          `✅ **"${title}"** ditambahkan!\n🔗 ${url}\n📋 Total: **${updatedWhitelist.length}** manga`,
        );
      } catch (err) {
        console.error("handleAdd error:", err);
        await editInteractionResponse(payload.token, `❌ ${err.message}`);
      }
    })(),
  );
}