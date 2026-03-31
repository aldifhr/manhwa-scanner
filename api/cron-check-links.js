import { isCronAuthorized } from "../lib/auth.js";
import { loadWhitelist, getAllGuildChannels, redis } from "../lib/redis.js";
import { checkWhitelistLinks } from "../lib/services/linkCheckService.js";
import { sendDiscordEmbed } from "../lib/discord.js";
import { getLogger } from "../lib/logger.js";

export const config = { maxDuration: 300 }; // Mengizinkan running hingga 5 menit
const logger = getLogger({ scope: "cron-check-links" });

export default async function handler(req, res) {
  // Hanya izinkan jika authorized (Vercel Cron Secret atau Dashboard Session)
  if (!isCronAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const start = Date.now();
  logger.info("Starting scheduled bi-weekly link check...");

  try {
    const whitelist = await loadWhitelist();
    if (!whitelist || whitelist.length === 0) {
      return res.status(200).json({ ok: true, message: "Whitelist empty" });
    }

    const report = await checkWhitelistLinks(whitelist);
    const duration = ((Date.now() - start) / 1000).toFixed(1);

    logger.info({ 
        total: report.total, 
        dead: report.dead.length,
        duration 
    }, "Link check complete");

    // Jika ditemukan link mati, kirim notifikasi ke semua channel yang terdaftar
    if (report.dead.length > 0) {
      const guildChannels = await getAllGuildChannels().catch(() => ({}));
      const channelIds = Object.values(guildChannels || {}).filter(Boolean);
      
      if (channelIds.length > 0) {
        const deadListStr = report.dead
          .slice(0, 15)
          .map(d => `• **${d.title}** (${d.source}): ${d.url}`)
          .join("\n");
        
        const suffix = report.dead.length > 15 
          ? `\n...dan ${report.dead.length - 15} lainnya.` 
          : "";
        
        const embed = {
          title: "⚠️ Laporan Link Mati (Bi-Weekly)",
          description: `Ditemukan **${report.dead.length}** link yang tidak aktif dari total **${report.total}** link.\n\n${deadListStr}${suffix}`,
          color: 0xe74c3c,
          footer: { text: "Hapus link mati menggunakan /remove <URL>." },
          timestamp: new Date().toISOString()
        };

        // Kirim ke semua channel (biasanya hanya 1 per guild)
        await Promise.all(
          channelIds.map(channelId => 
            sendDiscordEmbed(channelId, embed).catch(err => 
              logger.warn({ channelId, err: err.message }, "Failed to send dead link alert")
            )
          )
        );
      }
    }

    return res.status(200).json({ 
      ok: true, 
      total: report.total, 
      dead: report.dead.length,
      duration: `${duration}s`
    });
  } catch (err) {
    logger.error({ err: err.message }, "Scheduled link check failed");
    return res.status(500).json({ error: err.message });
  }
}
