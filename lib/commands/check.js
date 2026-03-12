import { waitUntil } from "@vercel/functions";
import { redis } from "../redis.js";
import { editInteractionResponse, sendDiscordEmbed } from "../discord.js";
import { scrapeMangaUpdates } from "../scraper.js";
import { dispatchChapters } from "../services/dispatch.js";
import { loadMatchedDispatchContext } from "../services/commandDispatchFlow.js";
import { getLogger } from "../logger.js";
import { CHAPTER_TTL_SEC } from "../runtimeConfig.js";

const logger = getLogger({ scope: "check" });

export default function handleCheck(payload, options, res) {
  void options;
  res.json({ type: 5 });

  waitUntil(
    (async () => {
      try {
        const context = await loadMatchedDispatchContext({
          scrapeUpdates: () => scrapeMangaUpdates(redis),
        });

        if (context.status === "empty_whitelist") {
          await editInteractionResponse(
            payload,
            "Whitelist kosong! Tambahkan manga dulu dengan `/add`",
          );
          return;
        }
        if (context.status === "no_channels") {
          await editInteractionResponse(
            payload,
            "Belum ada notification channel. Gunakan `/setchannel #channel` dulu.",
          );
          return;
        }
        if (context.status === "no_matches") {
          await editInteractionResponse(payload, "Tidak ada chapter baru saat ini.");
          return;
        }

        const { sent, skipped, failed } = await dispatchChapters({
          redis,
          matched: context.matched,
          channelIds: context.channelIds,
          sendEmbed: sendDiscordEmbed,
          chapterTtl: CHAPTER_TTL_SEC,
          log: (msg) => logger.debug({ msg }, "dispatch"),
          warn: (msg) => logger.warn({ msg }, "dispatch"),
        });

        if (sent > 0) {
          await editInteractionResponse(
            payload,
            `**${sent}** chapter baru dikirim dari **${context.matched.length}** yang cocok\n` +
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
