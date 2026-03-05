import { getAllGuildChannels } from "../lib/redis.js"; // ✅ import path dilengkapi
import { isCronAuthorized } from "../lib/auth.js"; // ✅ import path dilengkapi
export default async function handler(req, res) {
  if (!isCronAuthorized(req))
    return res.status(401).json({ error: "Unauthorized" });

  res.setHeader("Cache-Control", "no-store");
  try {
    const channelMap = await getAllGuildChannels();
    const guilds = Object.entries(channelMap).map(([guildId, channelId]) => ({
      guildId,
      channelId,
    }));

    res.json({ guilds });
  } catch (error) {
    console.error("[guilds] Error:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}
