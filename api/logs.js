import { redis }           from "../lib/redis.js";
import { isCronAuthorized } from "../lib/auth.js";

export default async function handler(req, res) {
  if (!isCronAuthorized(req))
    return res.status(401).json({ error: "Unauthorized" });

  res.setHeader("Cache-Control", "no-store");

  try {
    // Upstash auto-deserialize — tidak perlu JSON.parse manual
    const raw  = await redis.lrange("cron:logs", 0, 49);
    const logs = raw.filter(Boolean);

    return res.json({ logs });
  } catch (err) {
    console.error("[logs] Error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
}