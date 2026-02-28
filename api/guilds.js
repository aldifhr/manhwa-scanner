import { getAllGuildChannels } from "../lib/redis.js";

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`)
    return res.status(401).json({ error: "Unauthorized" });

  const channelMap = await getAllGuildChannels();

  const guilds = Object.entries(channelMap).map(([guildId, channelId]) => ({
    guildId,
    channelId,
    valid: !!channelId,
  }));

  res.json({ guilds });
}