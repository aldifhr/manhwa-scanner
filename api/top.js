import { redis } from "../lib/redis.js";

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`)
    return res.status(401).json({ error: "Unauthorized" });

  res.setHeader("Cache-Control", "no-store");

  const raw = await redis.lrange("cron:logs", 0, 199);
  const logs = raw.map(entry => {
    try { return typeof entry === "string" ? JSON.parse(entry) : entry; }
    catch { return null; }
  }).filter(Boolean);

  const top = getTopManhwa(logs);

  res.json({ top });
}

function getTopManhwa(logs) {
  const counter = {};
  logs
    ?.filter(l => l.tag === 'sent' && l.message?.includes('Chapter'))
    .forEach(l => {
      // Parse: "Solo Leveling — Chapter 123" → "Solo Leveling"
      const title = l.message.split(' — ')[0].trim();
      if (title) counter[title] = (counter[title] || 0) + 1;
    });
  
  return Object.entries(counter)
    .sort(([,a], [,b]) => b - a)
    .slice(0, 5)
    .map(([title, count]) => ({ title, count }));
}
