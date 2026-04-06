import { isMonitorAuthorized } from "../lib/auth.js";
import { redis } from "../lib/redis.js";
import { logApiError, logApiHit, logApiOk } from "../lib/logger.js";
import { WHITELIST_API_CACHE_KEY } from "../lib/cacheKeys.js";
import {
  addWhitelistEntry,
  removeWhitelistEntry,
  removeWhitelistEntryIdentity,
  markWhitelistEntry,
} from "../lib/services/whitelist.js";
import { buildWhitelistListResponse } from "../lib/services/whitelist.js";

const WHITELIST_CACHE_SEC = Number(process.env.WHITELIST_CACHE_SEC || 300);

// Allowed domains for URL validation
const ALLOWED_DOMAINS = [
  "ikiru.wtf",
  "shinigami.asia",
  "shngm.id",
  "shinigami-id.com",
  "shinigami.moe",
  "shinigami.ink",
  "komikcast.com",
  "komikcast.site",
];

// Standard API response helpers
function createSuccessResponse(data) {
  return {
    success: true,
    data,
    timestamp: new Date().toISOString(),
  };
}

function createErrorResponse(code, message, details = null) {
  const response = {
    success: false,
    error: {
      code,
      message,
    },
    timestamp: new Date().toISOString(),
  };
  if (details) {
    response.error.details = details;
  }
  return response;
}

function isValidDomain(url) {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    return ALLOWED_DOMAINS.some((domain) => hostname.includes(domain));
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  const reqLogger = logApiHit("whitelist", req);

  if (!isMonitorAuthorized(req)) {
    logApiOk(reqLogger, { status: 401, reason: "unauthorized" });
    return res
      .status(401)
      .json(createErrorResponse("UNAUTHORIZED", "Unauthorized"));
  }

  const cacheTtl =
    Number.isFinite(WHITELIST_CACHE_SEC) && WHITELIST_CACHE_SEC > 0
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
        logApiOk(reqLogger, {
          status: 200,
          method: "GET",
          count: cached.items?.length ?? 0,
          cache: "hit",
        });
        return res.status(200).json(cached);
      }

      const { items } = await buildWhitelistListResponse(1);
      const payload = { items };
      await redis
        .set(WHITELIST_API_CACHE_KEY, payload, { ex: cacheTtl })
        .catch(() => {});
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

      const cleanTitle = title?.trim();
      if (!cleanTitle) {
        logApiOk(reqLogger, {
          status: 400,
          method: "POST",
          reason: "title_required",
        });
        return res
          .status(400)
          .json(createErrorResponse("TITLE_REQUIRED", "Title wajib diisi"));
      }

      // Validate title length
      if (cleanTitle.length > 200) {
        logApiOk(reqLogger, {
          status: 400,
          method: "POST",
          reason: "title_too_long",
        });
        return res
          .status(400)
          .json(
            createErrorResponse(
              "TITLE_TOO_LONG",
              "Title terlalu panjang (maksimal 200 karakter)",
            ),
          );
      }

      const cleanUrl = url?.trim() || null;
      if (cleanUrl) {
        try {
          new URL(cleanUrl);
        } catch {
          logApiOk(reqLogger, {
            status: 400,
            method: "POST",
            reason: "invalid_url",
          });
          return res
            .status(400)
            .json(createErrorResponse("INVALID_URL", "URL tidak valid"));
        }

        // Validate domain whitelist
        if (!isValidDomain(cleanUrl)) {
          logApiOk(reqLogger, {
            status: 400,
            method: "POST",
            reason: "domain_not_allowed",
          });
          return res
            .status(400)
            .json(
              createErrorResponse(
                "DOMAIN_NOT_ALLOWED",
                "Domain URL tidak diizinkan",
                { allowedDomains: ALLOWED_DOMAINS },
              ),
            );
        }
      }

      const result = await addWhitelistEntry({
        title: title.trim(),
        url: cleanUrl,
        source,
      });

      if (result.status === "exists") {
        logApiOk(reqLogger, {
          status: 409,
          method: "POST",
          reason: "already_exists",
        });
        return res
          .status(409)
          .json(
            createErrorResponse(
              "ALREADY_EXISTS",
              "Manga sudah ada di whitelist",
            ),
          );
      }

      logApiOk(reqLogger, {
        status: 201,
        method: "POST",
        count: result.whitelist.length,
      });
      return res
        .status(201)
        .json(createSuccessResponse({ items: result.whitelist }));
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
      const cleanTitle = title?.trim();
      if (!cleanTitle) {
        logApiOk(reqLogger, {
          status: 400,
          method: "DELETE",
          reason: "title_required",
        });
        return res
          .status(400)
          .json(createErrorResponse("TITLE_REQUIRED", "Title wajib diisi"));
      }

      // Validate title length to prevent abuse
      if (cleanTitle.length > 200) {
        logApiOk(reqLogger, {
          status: 400,
          method: "DELETE",
          reason: "title_too_long",
        });
        return res
          .status(400)
          .json(
            createErrorResponse(
              "TITLE_TOO_LONG",
              "Title terlalu panjang (maksimal 200 karakter)",
            ),
          );
      }

      const result =
        source || url
          ? await removeWhitelistEntryIdentity({
              title: title.trim(),
              source,
              url,
            })
          : await removeWhitelistEntry(title.trim());
      if (result.status === "ambiguous") {
        logApiOk(reqLogger, {
          status: 409,
          method: "DELETE",
          reason: "ambiguous_title",
        });
        return res.status(409).json(
          createErrorResponse(
            "AMBIGUOUS_TITLE",
            "Title mengarah ke lebih dari satu manga. Kirim source atau url.",
            {
              matches:
                result.matches?.map(({ index, item }) => ({
                  index: index + 1,
                  title: item.title,
                  source: item.source,
                  url: item.url ?? null,
                })) ?? [],
            },
          ),
        );
      }
      if (result.status === "not_found") {
        logApiOk(reqLogger, {
          status: 404,
          method: "DELETE",
          reason: "not_found",
        });
        return res
          .status(404)
          .json(createErrorResponse("NOT_FOUND", "Manga tidak ditemukan"));
      }

      logApiOk(reqLogger, {
        status: 200,
        method: "DELETE",
        count: result.items.length,
      });
      return res
        .status(200)
        .json(createSuccessResponse({ items: result.items }));
    } catch (err) {
      logApiError(reqLogger, err, { status: 500, method: "DELETE" });
      return res.status(500).json({ error: "Internal error" });
    }
  }

  // PATCH: update mark status (e.g. mark as read)
  if (req.method === "PATCH") {
    try {
      const { title, mark } = req.body ?? {};
      const cleanTitle = title?.trim();
      if (!cleanTitle) {
        logApiOk(reqLogger, {
          status: 400,
          method: "PATCH",
          reason: "title_required",
        });
        return res
          .status(400)
          .json(createErrorResponse("TITLE_REQUIRED", "Title wajib diisi"));
      }

      // Validate title length
      if (cleanTitle.length > 200) {
        logApiOk(reqLogger, {
          status: 400,
          method: "PATCH",
          reason: "title_too_long",
        });
        return res
          .status(400)
          .json(
            createErrorResponse(
              "TITLE_TOO_LONG",
              "Title terlalu panjang (maksimal 200 karakter)",
            ),
          );
      }

      const result = await markWhitelistEntry(title.trim(), mark);

      if (result.status === "ambiguous") {
        logApiOk(reqLogger, {
          status: 409,
          method: "PATCH",
          reason: "ambiguous_title",
        });
        return res.status(409).json(
          createErrorResponse(
            "AMBIGUOUS_TITLE",
            "Title mengarah ke lebih dari satu manga.",
            {
              matches: result.matches?.map(({ item }) => item.title) ?? [],
            },
          ),
        );
      }

      if (result.status === "not_found") {
        logApiOk(reqLogger, {
          status: 404,
          method: "PATCH",
          reason: "not_found",
        });
        return res
          .status(404)
          .json(createErrorResponse("NOT_FOUND", "Manga tidak ditemukan"));
      }

      logApiOk(reqLogger, {
        status: 200,
        method: "PATCH",
        mark: result.reason,
      });
      return res
        .status(200)
        .json(
          createSuccessResponse({ items: result.items, mark: result.reason }),
        );
    } catch (err) {
      logApiError(reqLogger, err, { status: 500, method: "PATCH" });
      return res.status(500).json({ error: "Internal error" });
    }
  }

  logApiOk(reqLogger, { status: 405, reason: "method_not_allowed" });
  return res
    .status(405)
    .json(createErrorResponse("METHOD_NOT_ALLOWED", "Method not allowed"));
}
