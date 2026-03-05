import { redis }           from "../lib/redis.js";
import { isCronAuthorized } from "../lib/auth.js";

export default async function handler(req, res) {
  if (!isCronAuthorized(req))
    return res.status(401).json({ error: "Unauthorized" });

  res.setHeader("Cache-Control", "no-store");

  try {
    // Upstash auto-deserialize — tidak perlu JSON.parse manual
    const data = await redis.get("cron:last_run");
    return res.json(data ?? null);
  } catch (err) {
    console.error("[last-run] Error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
}