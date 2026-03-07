import { getAllGuildChannels } from "../lib/redis.js";
import { isCronAuthorized } from "../lib/auth.js";
import { logApiHit } from "../lib/requestLog.js";

export default async function handler(req, res) {
  logApiHit("guilds", req);

  if (req.method !== "GET")
    return res.status(405).json({ error: "Method not allowed" });

  if (!isCronAuthorized(req))
    return res.status(401).json({ error: "Unauthorized" });

  res.setHeader("Cache-Control", "no-store");
  try {
    const channelMap = await getAllGuildChannels();
    const guilds = Object.entries(channelMap).map(([guildId, channelId]) => ({
      guildId,
      channelId: String(channelId),
    }));

    res.json({ guilds });
  } catch (error) {
    console.error("[guilds] Error:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}
