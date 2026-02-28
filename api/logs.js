import { Redis } from "@upstash/redis";
const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`)
    return res.status(401).json({ error: "Unauthorized" });

  const raw = await redis.lrange("cron:logs", 0, 49);
  const logs = raw.map((entry) => {
    try { return typeof entry === "string" ? JSON.parse(entry) : entry; }
    catch { return { time: new Date().toISOString(), message: String(entry), tag: "info" }; }
  });
  res.json({ logs });
}