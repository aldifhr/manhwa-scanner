import { redis }           from "../lib/redis.js";
import { isCronAuthorized } from "../lib/auth.js";
import { logApiHit } from "../lib/requestLog.js";

export default async function handler(req, res) {
  logApiHit("top", req);

  if (req.method !== "GET")
    return res.status(405).json({ error: "Method not allowed" });

  if (!isCronAuthorized(req))
    return res.status(401).json({ error: "Unauthorized" });

  res.setHeader("Cache-Control", "no-store");

  try {
    // Ambil 1000 entry untuk data yang lebih akurat
    const raw = await redis.lrange("cron:logs", 0, 999);
    const logs = raw.filter(Boolean);

    const top       = getTopManhwa(logs);
    const totalSent = logs.filter((l) => l.tag === "sent").length;

    res.json({
      top,
      totalSent,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[top] Error:", err);
    res.status(500).json({ error: "Internal error" });
  }
}

/**
 * Hitung top 5 manga paling sering dikirim notifikasinya.
 * Mengharapkan log entry dengan struktur: { tag, title, chapter, time }
 * Fallback ke parse dari message string kalau title tidak ada.
 */
function getTopManhwa(logs) {
  const counter = {};

  logs
    .filter((l) => l.tag === "sent")
    .forEach((l) => {
      // Prioritas: field title langsung, fallback parse dari message
      let title = l.title?.trim();

      if (!title && l.message?.includes(" — ")) {
        const parts = l.message.split(" — ");
        if (parts.length >= 2) {
          title = parts[0].trim();
        }
      }

      if (!title) return;
      counter[title] = (counter[title] || 0) + 1;
    });

  return Object.entries(counter)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([title, count]) => ({ title, count }));
}
