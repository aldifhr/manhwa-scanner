import { waitUntil }                                from "@vercel/functions";
import { getAllGuildChannels, redis }                from "../redis.js";
import { editInteractionResponse, sendDiscordEmbed } from "../discord.js";
import { matchTitle }                               from "../permissions.js";
import { scrapeMangaUpdates }                       from "../scraper.js";
import { InteractionResponseType }                  from "discord-interactions";

const CHAPTER_TTL = 60 * 60 * 24 * 3;

export default function handleForcescrape(payload, options, res) {
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
      const allResults = await scrapeMangaUpdates(redis);

      const exact   = allResults.filter((item) =>
        item.title.toLowerCase() === title.toLowerCase()
      );
      const matched = exact.length > 0
        ? exact
        : allResults.filter((item) => matchTitle(item.title, title));

      if (matched.length === 0) {
        await editInteractionResponse(payload.token,
          `🔍 **"${title}"** tidak ditemukan di update terbaru.\n` +
          `Kemungkinan belum ada chapter baru atau judul tidak cocok.`
        );
        return;
      }

      const guildChannels = await getAllGuildChannels();
      if (Object.keys(guildChannels).length === 0) {
        await editInteractionResponse(payload.token,
          "⚠️ Belum ada notification channel. Gunakan `/setchannel #channel` dulu."
        );
        return;
      }

      for (const item of matched) {
        for (const [guildId, channelId] of Object.entries(guildChannels)) {
          try {
            await sendDiscordEmbed(item, channelId);
          } catch (err) {
            console.error(`❌ [forcescrape] Failed guild ${guildId}: ${err.message}`);
          }
        }
        await redis.set(`chapter:${item.url}`, Date.now().toString(), { ex: CHAPTER_TTL });
      }

      await editInteractionResponse(payload.token,
        `✅ **Force scrape selesai!**\n` +
        `📖 Ditemukan **${matched.length}** result untuk **"${title}"** — notifikasi dikirim!`
      );
    } catch (err) {
      await editInteractionResponse(payload.token, `❌ Error: ${err.message}`);
    }
  })());
}
