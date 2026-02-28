import { redis } from "../lib/redis.js";

function auth(req) {
  return req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
}

async function getWhitelist() {
  const raw = await redis.get("whitelist:manga");
  const parsed = Array.isArray(raw) ? raw : raw ? JSON.parse(raw) : [];
  return parsed.map((w) => (typeof w === "string" ? { title: w, url: null } : w));
}

export default async function handler(req, res) {
  if (!auth(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // GET — ambil semua whitelist
  if (req.method === "GET") {
    try {
      const items = await getWhitelist();
      return res.status(200).json({ items });
    } catch (error) {
      console.error("Whitelist GET error:", error);
      return res.status(500).json({ error: "Internal error" });
    }
  }

  // POST — tambah manga ke whitelist
  if (req.method === "POST") {
    try {
      const { title, url } = req.body;

      if (!title?.trim()) {
        return res.status(400).json({ error: "Title wajib diisi" });
      }

      const items = await getWhitelist();

      // Cek duplikat
      const exists = items.some(
        (w) => w.title.toLowerCase() === title.trim().toLowerCase()
      );
      if (exists) {
        return res.status(409).json({ error: "Manga sudah ada di whitelist" });
      }

      items.push({ title: title.trim(), url: url?.trim() || null });
      await redis.set("whitelist:manga", JSON.stringify(items));

      return res.status(200).json({ ok: true, items });
    } catch (error) {
      console.error("Whitelist POST error:", error);
      return res.status(500).json({ error: "Internal error" });
    }
  }

  // DELETE — hapus manga dari whitelist by title
  if (req.method === "DELETE") {
    try {
      const { title } = req.body;

      if (!title?.trim()) {
        return res.status(400).json({ error: "Title wajib diisi" });
      }

      const items = await getWhitelist();
      const filtered = items.filter(
        (w) => w.title.toLowerCase() !== title.trim().toLowerCase()
      );

      if (filtered.length === items.length) {
        return res.status(404).json({ error: "Manga tidak ditemukan" });
      }

      await redis.set("whitelist:manga", JSON.stringify(filtered));

      return res.status(200).json({ ok: true, items: filtered });
    } catch (error) {
      console.error("Whitelist DELETE error:", error);
      return res.status(500).json({ error: "Internal error" });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}