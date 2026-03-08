import { waitUntil } from "@vercel/functions";
import { loadWhitelist, getAllGuildChannels, redis } from "../redis.js";
import { editInteractionResponse, sendDiscordEmbed } from "../discord.js";
import { scrapeMangaUpdates } from "../scraper.js";
import { createWhitelistMatcher } from "../domain/manga.js";
import { sendToChannelsLimited } from "../services/discordRateLimiter.js";
import { getLogger } from "../logger.js";

const CHAPTER_TTL = 60 * 60 * 24 * 3;
const logger = getLogger({ scope: "check" });

async function sendToAllGuilds(item, guildChannels, redisClient) {
  const channelIds = Object.values(guildChannels || {});
  return sendToChannelsLimited({
    sendFn: sendDiscordEmbed,
    item,
    channelIds,
    redis: redisClient,
    onError: (err, channelId) => {
      logger.warn({ err: err.message, channelId, title: item.title }, "send failed");
    },
  });
}

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

        const chapterKeys = matched.map((item) => `chapter:${item.url}`);
        const sentFlags = await redis.mget(...chapterKeys);

        const toSend = matched.filter((_, i) => !sentFlags[i]);
        const skippedCount = matched.length - toSend.length;
        let sentCount = 0;

        for (const item of toSend) {
          await sendToAllGuilds(item, guildChannels, redis);
          await redis.set(`chapter:${item.url}`, Date.now().toString(), {
            ex: CHAPTER_TTL,
          });
          sentCount++;
        }

        if (sentCount > 0) {
          await editInteractionResponse(
            payload,
            `**${sentCount}** chapter baru dikirim dari **${matched.length}** yang cocok\n` +
              `Skipped: **${skippedCount}** (sudah pernah dikirim)`,
          );
        } else {
          await editInteractionResponse(
            payload,
            `Semua **${skippedCount}** chapter sudah pernah dikirim.\n` +
              "Notifikasi otomatis saat chapter berikutnya rilis!",
          );
        }
      } catch (err) {
        logger.error({ err: err.message }, "fatal");
        await editInteractionResponse(payload, `Error: ${err.message}`);
      }
    })(),
  );
}
