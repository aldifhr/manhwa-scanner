import { redis } from "../lib/redis.js";

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`)
    return res.status(401).json({ error: "Unauthorized" });

  res.setHeader("Cache-Control", "no-store");

  const raw = await redis.lrange("cron:logs", 0, 49);

  const logs = raw.map((entry) => {
    try { return typeof entry === "string" ? JSON.parse(entry) : entry; }
    catch { return { time: new Date().toISOString(), message: String(entry), tag: "info" }; }
  });

  res.json({ logs });
}