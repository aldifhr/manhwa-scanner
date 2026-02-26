import { waitUntil }                        from "@vercel/functions";
import { loadWhitelist, saveWhitelist }     from "../redis.js";
import { editInteractionResponse }          from "../discord.js";
import { InteractionResponseType }          from "discord-interactions";

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
      let index       = -1;

      const num = parseInt(input);
      if (!isNaN(num) && num >= 1 && num <= whitelist.length) {
        index = num - 1;
      } else {
        index = whitelist.findIndex((t) => t.toLowerCase() === input.toLowerCase());
      }

      if (index === -1) {
        await editInteractionResponse(payload.token,
          `⚠️ **"${input}"** tidak ditemukan di whitelist!\n` +
          `Gunakan \`/list\` untuk lihat nomor urut manga.`
        );
        return;
      }

      const removed = whitelist[index];
      whitelist.splice(index, 1);
      await saveWhitelist(whitelist);

      await editInteractionResponse(payload.token,
        `✅ Removed **"${removed}"** dari whitelist!\n📋 Total: **${whitelist.length}** manga`
      );
    } catch (err) {
      await editInteractionResponse(payload.token, `❌ Error: ${err.message}`);
    }
  })());
}
