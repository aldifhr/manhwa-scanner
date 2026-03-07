import { redis }           from "../lib/redis.js";
import { isCronAuthorized } from "../lib/auth.js";
import { logApiHit } from "../lib/requestLog.js";

export default async function handler(req, res) {
  logApiHit("uptime", req);

  if (req.method !== "GET")
    return res.status(405).json({ error: "Method not allowed" });

  if (!isCronAuthorized(req))
    return res.status(401).json({ error: "Unauthorized" });

  res.setHeader("Cache-Control", "no-store");

  try {
    // Ambil 1000 entry agar 7d data cukup terwakili
    const raw = await redis.lrange("cron:logs", 0, 999);
    const logs = raw.filter(Boolean);

    const uptime24h = calculateUptime(logs, 24);
    const uptime7d  = calculateUptime(logs, 168);

    res.json({
      uptime24h:   uptime24h ?? "insufficient_data",
      uptime7d:    uptime7d  ?? "insufficient_data",
      totalLogs:   logs.length,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[uptime] Error:", err);
    res.status(500).json({ error: "Internal error" });
  }
}

/**
 * Hitung uptime berdasarkan log dalam N jam terakhir.
 * "Success" = tag === 'sent' | 'ok' | 'no_updates'
 * Return null kalau tidak ada data dalam rentang waktu tersebut.
 */
function calculateUptime(logs, hours) {
  if (!logs.length) return null;

  const cutoff = Date.now() - hours * 60 * 60 * 1000;

  const recent = logs.filter((l) => {
    const t = l.time ? new Date(l.time).getTime() : NaN;
    return !isNaN(t) && t > cutoff;
  });

  if (!recent.length) return null;

  const SUCCESS_TAGS = new Set(["sent", "ok", "no_updates"]);
  const success = recent.filter((l) => SUCCESS_TAGS.has(l.tag)).length;

  return Math.round((success / recent.length) * 100);
}
