import { redis } from "../lib/redis.js";

const WHITELIST_KEY = "whitelist:manga";
const SNAPSHOT_LIST_KEY = "snapshots:list";
const MAX_SNAPSHOTS = 10;

function auth(req) {
  return req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
}

async function getWhitelist() {
  const raw = await redis.get(WHITELIST_KEY);
  const parsed = Array.isArray(raw) ? raw : raw ? JSON.parse(raw) : [];
  return parsed.map((w) => (typeof w === "string" ? { title: w, url: null } : w));
}

export default async function handler(req, res) {
  if (!auth(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // GET — ambil semua snapshot
  if (req.method === "GET") {
    try {
      const raw = await redis.get(SNAPSHOT_LIST_KEY);
      const snapshots = raw ? (Array.isArray(raw) ? raw : JSON.parse(raw)) : [];
      return res.status(200).json({ snapshots });
    } catch (err) {
      console.error("Snapshot GET error:", err);
      return res.status(500).json({ error: err.message });
    }
  }

  // POST — save snapshot baru
  if (req.method === "POST") {
    try {
      const whitelist = await getWhitelist();

      if (!whitelist.length) {
        return res.status(400).json({ error: "Whitelist kosong, tidak ada yang di-snapshot" });
      }

      const { label } = req.body ?? {};

      const snapshot = {
        id: Date.now().toString(),
        label: label?.trim() || null,
        savedAt: new Date().toISOString(),
        count: whitelist.length,
        data: whitelist,
      };

      // Ambil list snapshot lama
      const raw = await redis.get(SNAPSHOT_LIST_KEY);
      const snapshots = raw ? (Array.isArray(raw) ? raw : JSON.parse(raw)) : [];

      // Prepend snapshot baru, cap MAX_SNAPSHOTS
      const updated = [snapshot, ...snapshots].slice(0, MAX_SNAPSHOTS);
      await redis.set(SNAPSHOT_LIST_KEY, JSON.stringify(updated));

      return res.status(200).json({ ok: true, snapshot });
    } catch (err) {
      console.error("Snapshot POST error:", err);
      return res.status(500).json({ error: err.message });
    }
  }

  // PUT — restore snapshot by id
  if (req.method === "PUT") {
    try {
      const { id } = req.body ?? {};

      if (!id) {
        return res.status(400).json({ error: "id snapshot wajib diisi" });
      }

      const raw = await redis.get(SNAPSHOT_LIST_KEY);
      const snapshots = raw ? (Array.isArray(raw) ? raw : JSON.parse(raw)) : [];

      const snapshot = snapshots.find((s) => s.id === id);
      if (!snapshot) {
        return res.status(404).json({ error: "Snapshot tidak ditemukan" });
      }

      // Backup whitelist aktif sebelum restore
      const current = await getWhitelist();
      const backupSnapshot = {
        id: Date.now().toString(),
        label: `[auto-backup sebelum restore ${snapshot.label || snapshot.id}]`,
        savedAt: new Date().toISOString(),
        count: current.length,
        data: current,
      };
      const updatedSnapshots = [backupSnapshot, ...snapshots].slice(0, MAX_SNAPSHOTS);
      await redis.set(SNAPSHOT_LIST_KEY, JSON.stringify(updatedSnapshots));

      // Restore whitelist
      await redis.set(WHITELIST_KEY, JSON.stringify(snapshot.data));

      return res.status(200).json({
        ok: true,
        restored: snapshot.count,
        message: `Whitelist berhasil direstore ke snapshot "${snapshot.label || snapshot.id}"`,
      });
    } catch (err) {
      console.error("Snapshot PUT error:", err);
      return res.status(500).json({ error: err.message });
    }
  }

  // DELETE — hapus snapshot by id
  if (req.method === "DELETE") {
    try {
      const { id } = req.body ?? {};

      if (!id) {
        return res.status(400).json({ error: "id snapshot wajib diisi" });
      }

      const raw = await redis.get(SNAPSHOT_LIST_KEY);
      const snapshots = raw ? (Array.isArray(raw) ? raw : JSON.parse(raw)) : [];

      const filtered = snapshots.filter((s) => s.id !== id);
      if (filtered.length === snapshots.length) {
        return res.status(404).json({ error: "Snapshot tidak ditemukan" });
      }

      await redis.set(SNAPSHOT_LIST_KEY, JSON.stringify(filtered));
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error("Snapshot DELETE error:", err);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}