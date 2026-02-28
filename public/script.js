import { redis } from "../lib/redis.js"

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // Ambil semua logs (max 200 entry)
    const raw = await redis.lrange("cron:logs", 0, 199);

    // Buat struktur 7 hari terakhir
    const days = {};
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const label = d.toLocaleDateString("id-ID", {
        weekday: "short",
        day: "numeric",
        month: "short",
      });
      days[label] = { sent: 0, failed: 0 };
    }

    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;

    for (const entry of raw) {
      try {
        const data = typeof entry === "string" ? JSON.parse(entry) : entry;
        const time = new Date(data.time);

        if (time < cutoff) continue;
        if (!["sent", "failed"].includes(data.tag)) continue;

        const label = time.toLocaleDateString("id-ID", {
          weekday: "short",
          day: "numeric",
          month: "short",
        });

        if (!days[label]) continue;
        days[label][data.tag]++;
      } catch {
        continue;
      }
    }

    const labels = Object.keys(days);
    const sent = labels.map((l) => days[l].sent);
    const failed = labels.map((l) => days[l].failed);

    return res.status(200).json({ labels, sent, failed });
  } catch (error) {
    console.error("Chart API error:", error);
    return res.status(500).json({ error: "Internal error", labels: [], sent: [], failed: [] });
  }
}