import { waitUntil } from "@vercel/functions";
import { searchIkiru } from "../lib/ikiru.js";
import { editInteractionResponse } from "../lib/discord.js";
import { loadWhitelist, saveWhitelist } from "../lib/redis.js";

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
        const results = await searchIkiru(query, {}, redis);
        if (!results.length) {
          await editInteractionResponse(
            payload.token,
            `🔍 Manga **"${query}"** tidak ditemukan.`,
          );
          return;
        }

        const { title, url } = results[0];
        
        // ✅ Load SEKALI saja
        const whitelist = await loadWhitelist(redis); // coba pass redis jika perlu

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
        
        // ✅ Pastikan save berhasil
        const saveResult = await saveWhitelist(updatedWhitelist, redis);
        console.log("Save result:", saveResult); // debug
        
        // ✅ Verify tersimpan
        const verify = await loadWhitelist(redis);
        console.log("After save, total:", verify.length); // debug

        await editInteractionResponse(
          payload.token,
          `✅ **"${title}"** ditambahkan!\n🔗 ${url}\n📋 Total: **${verify.length}** manga`,
        );
      } catch (err) {
        console.error("handleAdd error:", err); // debug
        await editInteractionResponse(payload.token, `❌ ${err.message}`);
      }
    })(),
  );
}