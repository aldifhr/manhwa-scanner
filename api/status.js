import { redis } from "../lib/redis.js";

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`)
    return res.status(401).json({ error: "Unauthorized" });

  res.setHeader("Cache-Control", "no-store");

  const raw = await redis.get("cron:last_run");
  if (!raw) return res.json(null);

  const data = typeof raw === "string" ? JSON.parse(raw) : raw;
  res.json(data);
}