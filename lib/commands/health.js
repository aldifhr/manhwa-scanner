import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { InteractionResponseType } from "discord-interactions";
import { redis } from "../redis.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WHITELIST_PATH = path.resolve(__dirname, "../../whitelist.json");

export default async function handleHealth(payload, options, res) {
  try {
    if (!fs.existsSync(WHITELIST_PATH)) {
      return res.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: "❌ Error: Whitelist file not found.", flags: 64 },
      });
    }

    const data = JSON.parse(fs.readFileSync(WHITELIST_PATH, "utf8"));
    const total = data.length;

    // Count by source
    const sources = {};
    data.forEach(item => {
      sources[item.source] = (sources[item.source] || 0) + 1;
    });

    // Count by mark
    const marks = {};
    data.forEach(item => {
      const m = item.mark || "Active";
      marks[m] = (marks[m] || 0) + 1;
    });

    // Get broken links from Redis
    const brokenLinks = await redis.get("health:broken-links") || [];
    const brokenCount = Array.isArray(brokenLinks) ? brokenLinks.length : 0;

    // Count updates in last 24h
    const now = new Date();
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const updatedCount = data.filter(item => {
      if (!item.updatedTime) return false;
      return new Date(item.updatedTime) >= last24h;
    }).length;

    const sourceStats = Object.entries(sources)
      .map(([s, c]) => `• ${s}: \`${c}\``)
      .join("\n");
    
    const markStats = Object.entries(marks)
      .map(([m, c]) => `• ${m}: \`${c}\``)
      .join("\n");

    const content = [
      "## 📊 Bot Health & Statistics",
      `Total Manga: **${total}**`,
      `Broken Links: **${brokenCount}** ⚠️`,
      `Updated (24h): **${updatedCount}** ✨`,
      "",
      "### Sources",
      sourceStats,
      "",
      "### Status",
      markStats,
      "",
      `_Last updated: ${new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })} WIB_`
    ].join("\n");

    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content },
    });
  } catch (err) {
    console.error("[handleHealth] Error:", err);
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: `❌ Error: ${err.message}`, flags: 64 },
    });
  }
}
