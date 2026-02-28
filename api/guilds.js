import { Redis } from "@upstash/redis";
const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`)
    return res.status(401).json({ error: "Unauthorized" });

  let cursor = 0;
  const keys = [];
  do {
    const result = await redis.scan(cursor, { match: "channel:*", count: 100 });
    keys.push(...result.keys);
    cursor = result.cursor;
  } while (cursor !== 0);

  if (!keys.length) return res.json({ guilds: [] });

  const channels = await redis.mget(...keys);
  const guilds = keys.map((key, i) => ({
    guildId:   key.replace("channel:", ""),
    channelId: channels[i],
    valid:     !!channels[i],
  }));
  res.json({ guilds });
}