import { InteractionResponseType } from "discord-interactions";
import { redis, loadWhitelist } from "../redis.js";
import { sourceLabel } from "../domain/source.js";

export default async function handleHealth(payload, options, res) {
  try {
    const whitelist = await loadWhitelist();
    const total = whitelist.length;

    // Count statistics from multi-source structure
    const sourceCounts = {};
    const markCounts = {};
    let totalSources = 0;
    let updated24h = 0;
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    for (const item of whitelist) {
      if (Array.isArray(item.sources)) {
        for (const s of item.sources) {
          totalSources++;
          const src = s.source || "unknown";
          const mark = s.mark || "Active";
          sourceCounts[src] = (sourceCounts[src] || 0) + 1;
          markCounts[mark] = (markCounts[mark] || 0) + 1;
        }
      }

      // Check for recent updates using the Redis hibernation key or item metadata
      // Since item metadata might be old, we look at the hibernation timestamp if available
      // But for this stats command, we'll stick to item.updatedTime if present.
      if (item.updatedTime && (now - new Date(item.updatedTime).getTime() < dayMs)) {
        updated24h++;
      }
    }

    // Get broken links from Redis (populated by api/health.js)
    const brokenLinks = await redis.get("health:broken-links") || [];
    const brokenCount = Array.isArray(brokenLinks) ? brokenLinks.length : 0;

    const sourceStats = Object.entries(sourceCounts)
      .map(([s, c]) => `• ${sourceLabel(s)}: \`${c}\``)
      .join("\n") || "Tidak ada data sumber.";
    
    const markStats = Object.entries(markCounts)
      .map(([m, c]) => `• ${m}: \`${c}\``)
      .join("\n") || "Semua aktif.";

    const content = [
      "## 📊 Kesehatan & Statistik Bot",
      `Total Manga: **${total}**`,
      `Total Sumber: **${totalSources}**`,
      `Link Rusak  : **${brokenCount === 0 ? "0 ✅" : `**${brokenCount}** ⚠️`}**`,
      `Update (24j): **${updated24h}** ✨`,
      "",
      "### Sumber",
      sourceStats,
      "",
      "### Status",
      markStats,
      "",
      `_Audit Terakhir: ${new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })} WIB_`
    ].join("\n");

    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content },
    });
  } catch (err) {
    console.error("[handleHealth] Error:", err);
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: `❌ Kesalahan: ${err.message}`, flags: 64 },
    });
  }
}

