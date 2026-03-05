import { waitUntil }                    from "@vercel/functions";
import { loadWhitelist, saveWhitelist } from "../redis.js";
import { editInteractionResponse }      from "../discord.js";
import { InteractionResponseType }      from "discord-interactions";

export default function handleRemove(payload, options, res) {
  const input = options?.[0]?.value;
  if (!input) {
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "❌ Please provide a manga title or number!" },
    });
  }

  res.json({ type: 5 });

  waitUntil((async () => {
    try {
      const whitelist = await loadWhitelist();
      let index = -1;

      const num = parseInt(input);
      if (!isNaN(num) && num >= 1 && num <= whitelist.length) {
        // Hapus by nomor urut
        index = num - 1;
      } else {
        const lower = input.toLowerCase();

        // 1. Exact match dulu
        index = whitelist.findIndex(
          (item) => item.title.toLowerCase() === lower,
        );

        // 2. Fallback ke partial match
        if (index === -1) {
          index = whitelist.findIndex((item) =>
            item.title.toLowerCase().includes(lower),
          );
        }
      }

      if (index === -1) {
        await editInteractionResponse(
          payload,
          `⚠️ **"${input}"** tidak ditemukan di whitelist!\n` +
          `Gunakan \`/list\` untuk lihat nomor urut manga.`,
        );
        return;
      }

      const removed = whitelist[index].title;
      whitelist.splice(index, 1);
      await saveWhitelist(whitelist);

      await editInteractionResponse(
        payload,
        `✅ Removed **"${removed}"** dari whitelist!\n📋 Total: **${whitelist.length}** manga`,
      );
    } catch (err) {
      console.error("[handleRemove] Error:", err);
      await editInteractionResponse(payload, `❌ Error: ${err.message}`);
    }
  })());
}