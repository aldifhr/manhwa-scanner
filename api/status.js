import { redis } from "../lib/redis.js";
import { isCronAuthorized } from "../lib/auth.js";
import { logApiHit } from "../lib/requestLog.js";

const SOURCE_KEYS = ["ikiru", "shinigami_project", "shinigami_mirror"];

export default async function handler(req, res) {
  logApiHit("status", req);

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!isCronAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  res.setHeader("Cache-Control", "no-store");

  try {
    const data = await redis.get("cron:last_run");
    if (!data) return res.json(null);
    if (data.sourceHealth) return res.json(data);

    const sourceHealthPairs = await Promise.all(
      SOURCE_KEYS.map(async (source) => {
        const raw = await redis.get(`source:health:${source}`);
        return [source, raw ?? null];
      }),
    );

    return res.json({
      ...data,
      sourceHealth: Object.fromEntries(sourceHealthPairs),
    });
  } catch (err) {
    console.error("[last-run] Error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
}
