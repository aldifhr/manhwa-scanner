import { waitUntil }                        from "@vercel/functions";
import { loadWhitelist, saveWhitelist }     from "../redis.js";
import { editInteractionResponse }          from "../discord.js";
import { InteractionResponseType }          from "discord-interactions";

export default function handleAdd(payload, options, res) {
  const title = options?.[0]?.value;
  if (!title) {
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "❌ Please provide a manga title!" },
    });
  }

  res.json({ type: 5 });

  waitUntil((async () => {
    try {
      const whitelist = await loadWhitelist();
      if (whitelist.some((t) => t.toLowerCase() === title.toLowerCase())) {
        await editInteractionResponse(payload.token, `⚠️ **"${title}"** sudah ada di whitelist!`);
        return;
      }
      whitelist.push(title);
      await saveWhitelist(whitelist);
      await editInteractionResponse(payload.token,
        `✅ **"${title}"** ditambahkan ke whitelist!\n🔔 Notifikasi otomatis saat chapter baru rilis!`
      );
    } catch (err) {
      await editInteractionResponse(payload.token, `❌ Error: ${err.message}`);
    }
  })());
}
