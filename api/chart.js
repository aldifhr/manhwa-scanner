import { redis }           from "../lib/redis.js";
import { isCronAuthorized } from "../lib/auth.js";

export default async function handler(req, res) {
  if (!isCronAuthorized(req))
    return res.status(401).json({ error: "Unauthorized" });

  if (req.method !== "GET")
    return res.status(405).json({ error: "Method not allowed" });

  try {
    // Ambil 1000 entry agar 7 hari data cukup terwakili
    const raw = await redis.lrange("cron:logs", 0, 999);

    // Buat struktur 7 hari terakhir
    const days = {};
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const label = d.toLocaleDateString("id-ID", {
        weekday: "short",
        day:     "numeric",
        month:   "short",
      });
      days[label] = { sent: 0, failed: 0 };
    }

    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;

    for (const entry of raw) {
      // Upstash auto-deserialize — tidak perlu JSON.parse manual
      if (!entry) continue;

      // Guard invalid date
      const time = entry.time ? new Date(entry.time) : null;
      if (!time || isNaN(time.getTime())) continue;
      if (time.getTime() < cutoff) continue;
      if (!["sent", "failed"].includes(entry.tag)) continue;

      const label = time.toLocaleDateString("id-ID", {
        weekday: "short",
        day:     "numeric",
        month:   "short",
      });

      if (!days[label]) continue;
      days[label][entry.tag]++;
    }

    const labels = Object.keys(days);
    const sent   = labels.map((l) => days[l].sent);
    const failed = labels.map((l) => days[l].failed);

    return res.status(200).json({ labels, sent, failed });
  } catch (err) {
    console.error("[chart] Error:", err);
    return res.status(500).json({ error: "Internal error", labels: [], sent: [], failed: [] });
  }
}