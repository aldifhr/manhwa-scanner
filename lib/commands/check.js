import { waitUntil }                                 from "@vercel/functions";
import { loadWhitelist, getAllGuildChannels, redis }  from "../redis.js";
import { editInteractionResponse, sendDiscordEmbed } from "../discord.js";
import { matchTitle }                                from "../permissions.js";
import { scrapeMangaUpdates }                        from "../scraper.js";

// TTL 3 hari — cukup panjang untuk hindari re-notif,
// tapi tidak terlalu lama agar key tidak numpuk di Redis
const CHAPTER_TTL = 60 * 60 * 24 * 3;

// Max concurrent embed sends per chapter agar tidak kena Discord rate limit
const GUILD_CONCURRENCY = 3;

/**
 * Kirim embed ke semua guild dengan concurrency limit.
 * Gagal di satu guild tidak menghentikan guild lain.
 */
async function sendToAllGuilds(item, guildChannels, redis) {
  const entries = Object.entries(guildChannels);
  const results = { success: 0, failed: 0 };

  // Proses dalam batch sesuai GUILD_CONCURRENCY
  for (let i = 0; i < entries.length; i += GUILD_CONCURRENCY) {
    const batch = entries.slice(i, i + GUILD_CONCURRENCY);
    await Promise.all(
      batch.map(async ([guildId, channelId]) => {
        try {
          await sendDiscordEmbed(item, channelId, redis);
          results.success++;
        } catch (err) {
          results.failed++;
          console.error(`[check] Failed guild ${guildId} ch ${channelId}: ${err.message}`);
        }
      }),
    );
  }

  return results;
}

export default function handleCheck(payload, options, res) {
  res.json({ type: 5 });

  waitUntil((async () => {
    try {
      const whitelist = await loadWhitelist();
      if (whitelist.length === 0) {
        await editInteractionResponse(
          payload,
          "⚠️ Whitelist kosong! Tambahkan manga dulu dengan `/add`",
        );
        return;
      }

      const allResults = await scrapeMangaUpdates(redis);

      // ✅ Fix type mismatch — whitelist adalah { title, url }[], akses .title
      const matched = allResults.filter((item) =>
        whitelist.some((entry) => matchTitle(item.title, entry.title)),
      );

      if (matched.length === 0) {
        await editInteractionResponse(
          payload,
          "📭 Tidak ada chapter baru saat ini.",
        );
        return;
      }

      const guildChannels = await getAllGuildChannels();
      if (Object.keys(guildChannels).length === 0) {
        await editInteractionResponse(
          payload,
          "⚠️ Belum ada notification channel. Gunakan `/setchannel #channel` dulu.",
        );
        return;
      }

      // ✅ Batch check semua chapter sekaligus — 1 Redis round trip
      const chapterKeys  = matched.map((item) => `chapter:${item.url}`);
      const sentFlags    = await redis.mget(...chapterKeys);

      const toSend       = matched.filter((_, i) => !sentFlags[i]);
      const skippedCount = matched.length - toSend.length;
      let sentCount      = 0;

      for (const item of toSend) {
        await sendToAllGuilds(item, guildChannels, redis);
        // Mark sebagai sudah dikirim
        await redis.set(`chapter:${item.url}`, Date.now().toString(), {
          ex: CHAPTER_TTL,
        });
        sentCount++;
      }

      if (sentCount > 0) {
        await editInteractionResponse(
          payload,
          `✅ **${sentCount}** chapter baru dikirim dari **${matched.length}** yang cocok\n` +
          `⏭️ Skipped: **${skippedCount}** (sudah pernah dikirim)`,
        );
      } else {
        await editInteractionResponse(
          payload,
          `📭 Semua **${skippedCount}** chapter sudah pernah dikirim.\n` +
          `Notifikasi otomatis saat chapter berikutnya rilis!`,
        );
      }
    } catch (err) {
      console.error("[check] Fatal:", err);
      await editInteractionResponse(payload, `❌ Error: ${err.message}`);
    }
  })());
}