import { isCronAuthorized } from "../lib/auth.js";
import { performHealthCheck } from "../lib/services/healthCheck.js";
import { logApiHit, logApiOk, logApiError } from "../lib/requestLog.js";
import { getAllGuildChannels } from "../lib/redis.js";
import { sendDiscordEmbed } from "../lib/discord.js";

export const config = { maxDuration: 300 }; // 5 minutes for deep health check

export default async function handler(req, res) {
  const reqLogger = logApiHit("health", req);

  if (!isCronAuthorized(req)) {
    logApiOk(reqLogger, { status: 401, reason: "unauthorized" });
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const brokenLinks = await performHealthCheck();
    
    if (brokenLinks.length > 0) {
      const guildChannels = await getAllGuildChannels();
      const msg = `⚠️ **Daily Health Audit**\nFound **${brokenLinks.length}** broken links in your whitelist.\nUse \`/health\` for details.`;
      
      for (const channelId of Object.values(guildChannels)) {
        await sendDiscordEmbed({ 
          title: "Broken Link Alert",
          description: msg,
          color: 0xff0000 
        }, channelId).catch(() => {});
      }
    }

    logApiOk(reqLogger, { status: 200, brokenCount: brokenLinks.length });
    return res.status(200).json({ 
      ok: true, 
      brokenCount: brokenLinks.length,
      brokenLinks: brokenLinks,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    logApiError(reqLogger, err, { status: 500 });
    return res.status(500).json({ error: err.message, ok: false });
  }
}
