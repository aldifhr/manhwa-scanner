import { redis }           from "../lib/redis.js";
import { isCronAuthorized } from "../lib/auth.js";

export default async function handler(req, res) {
  if (!isCronAuthorized(req))
    return res.status(401).json({ error: "Unauthorized" });

  res.setHeader("Cache-Control", "no-store");

  try {
    // Ambil lebih banyak dulu agar aman kalau ada entry corrupt
    const raw = await redis.lrange("recent:chapters", 0, 49);

    const items = raw
      // Upstash auto-deserialize — tidak perlu JSON.parse manual
      .filter((item) => item && item.sentAt)
      // Guard invalid date agar sort tetap deterministic
      .sort((a, b) => {
        const ta = new Date(a.sentAt).getTime();
        const tb = new Date(b.sentAt).getTime();
        if (isNaN(ta) || isNaN(tb)) return 0;
        return tb - ta;
      })
      .slice(0, 20);

    return res.status(200).json({ items });
  } catch (err) {
    console.error("[recent] Error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
}