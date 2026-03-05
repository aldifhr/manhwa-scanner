import { waitUntil } from "@vercel/functions";
import { editInteractionResponse } from "../discord.js";
import { InteractionResponseType } from "discord-interactions";
import { searchIkiru, fetchDescription } from "../scraper.js";
import { shortSynopsis } from "../discord.js";
export default function handleInfo(payload, options, res, redis) {
  const title = options?.[0]?.value;
  if (!title) {
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "❌ Please provide a manga title!" },
    });
  }

  res.json({ type: 5 });

  waitUntil(
    (async () => {
      try {
        const results = await searchIkiru(title, {}, redis);

        if (!results.length) {
          await editInteractionResponse(
            payload,
            `🔍 Manga **"${title}"** tidak ditemukan.`,
          );
          return;
        }

        const manga = results[0];
        const desc = await fetchDescription(manga.mangaUrl, redis);
        `📖 **[${manga.title}](${manga.mangaUrl})**\n\n`;
        const shortDesc = shortSynopsis(desc) ?? "No synopsis available";

        await editInteractionResponse(
          payload,
          `📖 **[${manga.title}](${manga.url})**\n\n` +
            `⭐ **Rating:** ${manga.rating || "N/A"}\n` +
            `📚 **Latest:** ${manga.chapter || "Unknown"}\n\n` +
            `📝 **Synopsis:**\n${shortDesc}\n\n` +
            `💡 Use \`/add "${manga.title}"\` to add to whitelist`,
        );
      } catch (err) {
        console.error("[handleInfo] Error:", err);
        await editInteractionResponse(payload, `❌ Error: ${err.message}`);
      }
    })(),
  );
}
