import { redis } from "../lib/redis.js";

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`)
    return res.status(401).json({ error: "Unauthorized" });

  res.setHeader("Cache-Control", "no-store");

  // Ambil 20 chapter terbaru dari list recent:chapters
  const raw = await redis.lrange("recent:chapters", 0, 19);

  const items = raw.map((entry) => {
    try { return typeof entry === "string" ? JSON.parse(entry) : entry; }
    catch { return null; }
  }).filter(Boolean);

  res.json({ items });
}