import { isCronAuthorized } from "../lib/auth.js";
import { redis } from "../lib/redis.js";
import { logApiError, logApiHit, logApiOk } from "../lib/requestLog.js";
import { WHITELIST_API_CACHE_KEY } from "../lib/cacheKeys.js";
import {
  addWhitelistEntry,
  buildWhitelistListResponse,
  removeWhitelistEntry,
  removeWhitelistEntryIdentity,
} from "../lib/services/whitelist.js";

const WHITELIST_CACHE_SEC = Number(process.env.WHITELIST_CACHE_SEC || 300);

export default async function handler(req, res) {
  const reqLogger = logApiHit("whitelist", req);

  if (!isCronAuthorized(req)) {
    logApiOk(reqLogger, { status: 401, reason: "unauthorized" });
    return res.status(401).json({ error: "Unauthorized" });
  }

  const cacheTtl = Number.isFinite(WHITELIST_CACHE_SEC) && WHITELIST_CACHE_SEC > 0
    ? Math.floor(WHITELIST_CACHE_SEC)
    : 180;
  res.setHeader(
    "Cache-Control",
    `private, max-age=${Math.min(cacheTtl, 60)}, stale-while-revalidate=${cacheTtl}`,
  );

  // GET: ambil semua whitelist
  if (req.method === "GET") {
    try {
      const cached = await redis.get(WHITELIST_API_CACHE_KEY);
      if (cached && typeof cached === "object") {
        logApiOk(reqLogger, { status: 200, method: "GET", count: cached.items?.length ?? 0, cache: "hit" });
        return res.status(200).json(cached);
      }

      const { items } = await buildWhitelistListResponse(1);
      const payload = { items };
      await redis.set(WHITELIST_API_CACHE_KEY, payload, { ex: cacheTtl }).catch(() => {});
      logApiOk(reqLogger, { status: 200, method: "GET", count: items.length });
      return res.status(200).json(payload);
    } catch (err) {
      logApiError(reqLogger, err, { status: 500, method: "GET" });
      return res.status(500).json({ error: "Internal error" });
    }
  }

  // POST: tambah manga ke whitelist
  if (req.method === "POST") {
    try {
      const { title, url, source } = req.body ?? {};

      if (!title?.trim()) {
        logApiOk(reqLogger, { status: 400, method: "POST", reason: "title_required" });
        return res.status(400).json({ error: "Title wajib diisi" });
      }

      const cleanUrl = url?.trim() || null;
      if (cleanUrl) {
        try {
          new URL(cleanUrl);
        } catch {
          logApiOk(reqLogger, { status: 400, method: "POST", reason: "invalid_url" });
          return res.status(400).json({ error: "URL tidak valid" });
        }
      }

      const result = await addWhitelistEntry({
        title: title.trim(),
        url: cleanUrl,
        source,
      });

      if (result.status === "exists") {
        logApiOk(reqLogger, { status: 409, method: "POST", reason: "already_exists" });
        return res.status(409).json({ error: "Manga sudah ada di whitelist" });
      }

      logApiOk(reqLogger, { status: 201, method: "POST", count: result.whitelist.length });
      return res.status(201).json({ ok: true, items: result.whitelist });
    } catch (err) {
      logApiError(reqLogger, err, { status: 500, method: "POST" });
      return res.status(500).json({ error: "Internal error" });
    }
  }

  // DELETE: hapus manga dari whitelist by title
  if (req.method === "DELETE") {
    try {
      const title = req.query?.title || req.body?.title;
      const source = req.query?.source || req.body?.source || null;
      const url = req.query?.url || req.body?.url || null;
      if (!title?.trim()) {
        logApiOk(reqLogger, { status: 400, method: "DELETE", reason: "title_required" });
        return res.status(400).json({ error: "Title wajib diisi" });
      }

      const result = source || url
        ? await removeWhitelistEntryIdentity({
            title: title.trim(),
            source,
            url,
          })
        : await removeWhitelistEntry(title.trim());
      if (result.status === "ambiguous") {
        logApiOk(reqLogger, { status: 409, method: "DELETE", reason: "ambiguous_title" });
        return res.status(409).json({
          error: "Title mengarah ke lebih dari satu manga. Kirim source atau url.",
          matches: result.matches?.map(({ index, item }) => ({
            index: index + 1,
            title: item.title,
            source: item.source,
            url: item.url ?? null,
          })) ?? [],
        });
      }
      if (result.status === "not_found") {
        logApiOk(reqLogger, { status: 404, method: "DELETE", reason: "not_found" });
        return res.status(404).json({ error: "Manga tidak ditemukan" });
      }

      logApiOk(reqLogger, { status: 200, method: "DELETE", count: result.items.length });
      return res.status(200).json({ ok: true, items: result.items });
    } catch (err) {
      logApiError(reqLogger, err, { status: 500, method: "DELETE" });
      return res.status(500).json({ error: "Internal error" });
    }
  }

  logApiOk(reqLogger, { status: 405, reason: "method_not_allowed" });
  return res.status(405).json({ error: "Method not allowed" });
}
