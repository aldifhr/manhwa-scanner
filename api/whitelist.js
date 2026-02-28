import { loadWhitelist } from "../lib/redis.js";

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`)
    return res.status(401).json({ error: "Unauthorized" });
  res.setHeader("Cache-Control", "no-store");
  const items = await loadWhitelist();
  // loadWhitelist returns { title, url }[] — normalize to string[] for dashboard
  res.json({ items: items.map((i) => i.title ?? i) });
}
