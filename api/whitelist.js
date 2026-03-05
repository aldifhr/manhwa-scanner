import { loadWhitelist, saveWhitelist } from "../lib/redis.js";
import { isCronAuthorized }             from "../lib/auth.js";

export default async function handler(req, res) {
  if (!isCronAuthorized(req))
    return res.status(401).json({ error: "Unauthorized" });

  res.setHeader("Cache-Control", "no-store");

  // GET — ambil semua whitelist
  if (req.method === "GET") {
    try {
      const items = await loadWhitelist();
      return res.status(200).json({ items });
    } catch (err) {
      console.error("[whitelist GET] Error:", err);
      return res.status(500).json({ error: "Internal error" });
    }
  }

  // POST — tambah manga ke whitelist
  if (req.method === "POST") {
    try {
      const { title, url } = req.body ?? {};

      if (!title?.trim()) {
        return res.status(400).json({ error: "Title wajib diisi" });
      }

      // Validasi URL kalau ada
      const cleanUrl = url?.trim() || null;
      if (cleanUrl) {
        try { new URL(cleanUrl); }
        catch { return res.status(400).json({ error: "URL tidak valid" }); }
      }

      const items  = await loadWhitelist();
      const exists = items.some(
        (w) => w.title.toLowerCase() === title.trim().toLowerCase(),
      );

      if (exists) {
        return res.status(409).json({ error: "Manga sudah ada di whitelist" });
      }

      items.push({ title: title.trim(), url: cleanUrl });
      await saveWhitelist(items);

      return res.status(201).json({ ok: true, items });
    } catch (err) {
      console.error("[whitelist POST] Error:", err);
      return res.status(500).json({ error: "Internal error" });
    }
  }

  // DELETE — hapus manga dari whitelist by title
  if (req.method === "DELETE") {
    try {
      // Support body dan query param untuk kompatibilitas client
      const title = req.query?.title || req.body?.title;

      if (!title?.trim()) {
        return res.status(400).json({ error: "Title wajib diisi" });
      }

      const items    = await loadWhitelist();
      const filtered = items.filter(
        (w) => w.title.toLowerCase() !== title.trim().toLowerCase(),
      );

      if (filtered.length === items.length) {
        return res.status(404).json({ error: "Manga tidak ditemukan" });
      }

      await saveWhitelist(filtered);
      return res.status(200).json({ ok: true, items: filtered });
    } catch (err) {
      console.error("[whitelist DELETE] Error:", err);
      return res.status(500).json({ error: "Internal error" });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}