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

  const uptime24h = calculateUptime(logs, 24);
  const uptime7d = calculateUptime(logs, 168); // 7*24 jam

  res.json({
    uptime24h,
    uptime7d,
    totalLogs: logs.length
  });
}

function calculateUptime(logs, hours) {
  if (!logs.length) return null;
  const now = Date.now();
  const cutoff = now - (hours * 60 * 60 * 1000);
  
  const recent = logs.filter(l => new Date(l.time) > cutoff);
  if (!recent.length) return null;
  
  const success = recent.filter(l => l.tag === 'sent').length;
  return Math.round((success / recent.length) * 100);
}
