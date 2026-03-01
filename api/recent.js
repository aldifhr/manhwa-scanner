import { redis } from "../lib/redis.js";

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Jangan cache response
  res.setHeader("Cache-Control", "no-store");

  try {
    const raw = await redis.lrange("recent:chapters", 0, 49); 
    // Ambil lebih banyak dulu supaya aman kalau ada data kacau

    const items = raw
      .map((entry) => {
        try {
          return typeof entry === "string"
            ? JSON.parse(entry)
            : entry;
        } catch {
          return null;
        }
      })
      .filter((item) => item && item.sentAt)
      .sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt)) // 🔥 FORCE SORT
      .slice(0, 20); // limit final 20 terbaru

    return res.status(200).json({ items });
  } catch (err) {
    console.error("Recent API Error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}