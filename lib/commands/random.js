import { editInteractionResponse, editInteractionResponseWithComponents, ratingStars } from "../discord.js";
import { waitUntil } from "@vercel/functions";
import { fetchRandomIkiruManga } from "../scrapers/ikiru.js";
import { fetchRandomShinigamiManga } from "../scrapers/secondary.js";
import { getStatusColor } from "../scrapers/shared.js";

export default async function handleRandom(payload, options = [], res, redis) {
  // Acknowledge the interaction, letting the user know the bot is thinking.
  // flags: 0 means it's visible to everyone in the channel.
  if (!res.headersSent) {
    res.json({ type: 5, data: { flags: 0 } });
  }

  waitUntil(
    (async () => {
      try {
        const sourceOpt = options.find((o) => o.name === "source")?.value;
        const source = sourceOpt || "ikiru";
        let manga = null;

        if (source === "shinigami" || source === "shinigami_project") {
          manga = await fetchRandomShinigamiManga("shinigami_project");
        } else if (source === "shinigami_mirror") {
          manga = await fetchRandomShinigamiManga("shinigami_mirror");
        } else {
          manga = await fetchRandomIkiruManga(redis);
        }

        if (!manga) {
          return editInteractionResponse(payload, "Gagal mendapatkan komik acak. Server sumber mungkin sedang sibuk atau sedang down, coba lagi nanti!");
        }

        const statusColor = getStatusColor(manga.status);
        const titleLine = manga.mangaUrl
          ? `**[${manga.title}](${manga.mangaUrl})**`
          : `**${manga.title}**`;

        let sourceName = "Ikiru";
        if (source.includes("shinigami")) {
          sourceName = source === "shinigami_mirror" ? "Shinigami (Mirror)" : "Shinigami";
        }

        const embeds = [
          {
            color: statusColor,
            description: [
              titleLine,
              "",
              `Pilihan acak spesial dari **${sourceName}**!`,
            ].join("\n"),
            fields: [
              {
                name: "Status",
                value: `\`${manga.status}\``,
                inline: true,
              },
              {
                name: "Rating",
                value: ratingStars(manga.rating),
                inline: true,
              },
            ],
            thumbnail: manga.cover?.startsWith("http") ? { url: manga.cover } : undefined,
          }
        ];

        const content = `🎲 **Random Komik Gacha!**`;
        return editInteractionResponseWithComponents(payload, content, [], embeds);
      } catch (err) {
        console.error("[handleRandom] Error:", err);
        return editInteractionResponse(payload, `Terjadi kesalahan: ${err.message}`);
      }
    })()
  );
}

