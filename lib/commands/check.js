import { waitUntil } from "@vercel/functions";
import { loadWhitelist, getAllGuildChannels, redis } from "../redis.js";
import { editInteractionResponse, sendDiscordEmbed } from "../discord.js";
import { scrapeMangaUpdates } from "../scraper.js";
import { createWhitelistMatcher } from "../domain/manga.js";
import { dispatchChapters } from "../services/dispatch.js";
import { getLogger } from "../logger.js";

const CHAPTER_TTL = 60 * 60 * 24 * 3;
const logger = getLogger({ scope: "check" });

export default function handleCheck(payload, options, res) {
  void options;
  res.json({ type: 5 });

  waitUntil(
    (async () => {
      try {
        const whitelist = await loadWhitelist();
        if (whitelist.length === 0) {
          await editInteractionResponse(
            payload,
            "Whitelist kosong! Tambahkan manga dulu dengan `/add`",
          );
          return;
        }

        const allResults = await scrapeMangaUpdates(redis);
        const isMatched = createWhitelistMatcher(whitelist);
        const matched = allResults.filter(isMatched);

        if (matched.length === 0) {
          await editInteractionResponse(payload, "Tidak ada chapter baru saat ini.");
          return;
        }

        const guildChannels = await getAllGuildChannels();
        if (Object.keys(guildChannels).length === 0) {
          await editInteractionResponse(
            payload,
            "Belum ada notification channel. Gunakan `/setchannel #channel` dulu.",
          );
          return;
        }

        const { sent, skipped, failed } = await dispatchChapters({
          redis,
          matched,
          channelIds: Object.values(guildChannels),
          sendEmbed: sendDiscordEmbed,
          chapterTtl: CHAPTER_TTL,
          log: (msg) => logger.debug({ msg }, "dispatch"),
          warn: (msg) => logger.warn({ msg }, "dispatch"),
        });

        if (sent > 0) {
          await editInteractionResponse(
            payload,
            `**${sent}** chapter baru dikirim dari **${matched.length}** yang cocok\n` +
              `Skipped: **${skipped}**\n` +
              `Failed: **${failed}**`,
          );
        } else {
          await editInteractionResponse(
            payload,
            `Tidak ada chapter terkirim.\n` +
              `Skipped: **${skipped}**\n` +
              `Failed: **${failed}**`,
          );
        }
      } catch (err) {
        logger.error({ err: err.message }, "fatal");
        await editInteractionResponse(payload, `Error: ${err.message}`);
      }
    })(),
  );
}
