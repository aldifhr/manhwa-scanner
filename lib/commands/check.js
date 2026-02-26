import { waitUntil }                                                    from "@vercel/functions";
import { loadWhitelist, getAllGuildChannels, redis }                     from "../redis.js";
import { editInteractionResponse, sendDiscordEmbed }                    from "../discord.js";
import { matchTitle }                                                    from "../permissions.js";
import { scrapeMangaUpdates }                                            from "../scraper.js";

const CHAPTER_TTL = 60 * 60 * 24 * 3;

export default function handleCheck(payload, options, res) {
  res.json({ type: 5 });

  waitUntil((async () => {
    try {
      const whitelist = await loadWhitelist();
      if (whitelist.length === 0) {
        await editInteractionResponse(payload.token,
          "⚠️ Whitelist kosong! Tambahkan manga dulu dengan `/add`"
        );
        return;
      }

      const allResults = await scrapeMangaUpdates(redis);
      const matched    = allResults.filter((item) =>
        whitelist.some((title) => matchTitle(item.title, title))
      );

      if (matched.length === 0) {
        await editInteractionResponse(payload.token, "📭 Tidak ada chapter baru saat ini.");
        return;
      }

      const guildChannels = await getAllGuildChannels();
      if (Object.keys(guildChannels).length === 0) {
        await editInteractionResponse(payload.token,
          "⚠️ Belum ada notification channel. Gunakan `/setchannel #channel` dulu."
        );
        return;
      }

      let sentCount    = 0;
      let skippedCount = 0;

      for (const item of matched) {
        const key         = `chapter:${item.url}`;
        const alreadySent = await redis.get(key);

        if (alreadySent) {
          skippedCount++;
          continue;
        }

        for (const [guildId, channelId] of Object.entries(guildChannels)) {
          try {
            await sendDiscordEmbed(item, channelId);
          } catch (err) {
            console.error(`❌ [check] Failed guild ${guildId}: ${err.message}`);
          }
        }

        await redis.set(key, Date.now().toString(), { ex: CHAPTER_TTL });
        sentCount++;
      }

      if (sentCount > 0) {
        await editInteractionResponse(payload.token,
          `✅ Selesai! Ditemukan **${sentCount}** chapter baru — notifikasi dikirim!\n` +
          `⏭️ Skipped: **${skippedCount}** (sudah pernah dikirim)`
        );
      } else {
        await editInteractionResponse(payload.token,
          `📭 Semua chapter sudah pernah dikirim (**${skippedCount}** skipped).\n` +
          `Notifikasi otomatis saat chapter berikutnya rilis!`
        );
      }
    } catch (err) {
      console.error(`❌ [check] Fatal: ${err.message}`);
      await editInteractionResponse(payload.token, `❌ Error: ${err.message}`);
    }
  })());
}
