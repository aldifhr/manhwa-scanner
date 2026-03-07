import { redis, loadWhitelist, saveWhitelist } from "../lib/redis.js";
import { isCronAuthorized }                    from "../lib/auth.js";
import { logApiHit } from "../lib/requestLog.js";

const SNAPSHOT_LIST_KEY = "snapshots:list";
const MAX_SNAPSHOTS     = 10;

// ─── HELPERS ──────────────────────────────────────────────────────────────────

/**
 * Ambil semua snapshot dari Redis.
 * Upstash auto-deserialize — tidak perlu JSON.parse manual.
 */
async function getSnapshots() {
  const raw = await redis.get(SNAPSHOT_LIST_KEY);
  return Array.isArray(raw) ? raw : [];
}

/**
 * Generate unique snapshot ID dengan timestamp + random suffix
 * untuk menghindari collision kalau dua request masuk bersamaan.
 */
function generateId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

// ─── HANDLER ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  logApiHit("snapshot", req);

  if (!isCronAuthorized(req))
    return res.status(401).json({ error: "Unauthorized" });

  res.setHeader("Cache-Control", "no-store");

  // GET — ambil semua snapshot
  if (req.method === "GET") {
    try {
      const snapshots = await getSnapshots();
      return res.status(200).json({ snapshots });
    } catch (err) {
      console.error("[snapshot GET] Error:", err);
      return res.status(500).json({ error: "Internal error" });
    }
  }

  // POST — simpan snapshot baru dari whitelist aktif
  if (req.method === "POST") {
    try {
      const whitelist = await loadWhitelist();

      if (!whitelist.length) {
        return res.status(400).json({ error: "Whitelist kosong, tidak ada yang di-snapshot" });
      }

      const { label } = req.body ?? {};

      const snapshot = {
        id:      generateId(),
        label:   label?.trim() || null,
        savedAt: new Date().toISOString(),
        count:   whitelist.length,
        data:    whitelist,
      };

      const snapshots = await getSnapshots();
      const updated   = [snapshot, ...snapshots].slice(0, MAX_SNAPSHOTS);

      // Upstash auto-serialize — tidak perlu JSON.stringify
      await redis.set(SNAPSHOT_LIST_KEY, updated);

      return res.status(201).json({ ok: true, snapshot });
    } catch (err) {
      console.error("[snapshot POST] Error:", err);
      return res.status(500).json({ error: "Internal error" });
    }
  }

  // PUT — restore whitelist dari snapshot by id
  if (req.method === "PUT") {
    try {
      const { id } = req.body ?? {};

      if (!id) {
        return res.status(400).json({ error: "id snapshot wajib diisi" });
      }

      const snapshots = await getSnapshots();
      const snapshot  = snapshots.find((s) => s.id === id);

      if (!snapshot) {
        return res.status(404).json({ error: "Snapshot tidak ditemukan" });
      }

      // Auto-backup whitelist aktif sebelum restore
      const current = await loadWhitelist();
      const backup  = {
        id:      generateId(),
        label:   `[auto-backup sebelum restore "${snapshot.label || snapshot.id}"]`,
        savedAt: new Date().toISOString(),
        count:   current.length,
        data:    current,
      };

      const updatedSnapshots = [backup, ...snapshots].slice(0, MAX_SNAPSHOTS);
      await redis.set(SNAPSHOT_LIST_KEY, updatedSnapshots);

      // Restore whitelist via saveWhitelist — tidak bypass dengan key hardcode
      await saveWhitelist(snapshot.data);

      return res.status(200).json({
        ok:       true,
        restored: snapshot.count,
        message:  `Whitelist berhasil direstore ke snapshot "${snapshot.label || snapshot.id}"`,
      });
    } catch (err) {
      console.error("[snapshot PUT] Error:", err);
      return res.status(500).json({ error: "Internal error" });
    }
  }

  // DELETE — hapus snapshot by id
  if (req.method === "DELETE") {
    try {
      const id = req.query?.id || req.body?.id;

      if (!id) {
        return res.status(400).json({ error: "id snapshot wajib diisi" });
      }

      const snapshots = await getSnapshots();
      const filtered  = snapshots.filter((s) => s.id !== id);

      if (filtered.length === snapshots.length) {
        return res.status(404).json({ error: "Snapshot tidak ditemukan" });
      }

      await redis.set(SNAPSHOT_LIST_KEY, filtered);
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error("[snapshot DELETE] Error:", err);
      return res.status(500).json({ error: "Internal error" });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
