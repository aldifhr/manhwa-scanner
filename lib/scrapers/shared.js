import { z } from "zod";
import axios from "axios";
import http from "http";
import https from "https";
import {
  isSameNormalizedTitle,
  normalizeTitleKey,
  getShinigamiPublicBase,
  normalizeSource,
  normalizeSourceUrl,
  normalizeChapterIdentity,
} from "../domain.js";
import { requestWithRetry } from "../httpClient.js";
import { getLogger } from "../logger.js";
import { IKIRU_CONFIG, SECONDARY_CONFIG } from "../config.js";

const logger = getLogger({ scope: "cookie" });
const IKIRU_BASE_DEFAULT = "https://02.ikiru.wtf";
const httpKeepAliveAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });
const httpsKeepAliveAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 50,
});

const LOGIN_URL = `${(process.env.IKIRU_BASE_URL || IKIRU_BASE_DEFAULT).replace(/\/+$/, "")}/wp-login.php`;

async function refreshCookie() {
  const email = process.env.IKIRU_EMAIL;
  const password = process.env.IKIRU_PASSWORD;

  if (!email || !password) {
    logger.warn("IKIRU_EMAIL/PASSWORD tidak diset, skip cookie refresh");
    return null;
  }

  try {
    const params = new URLSearchParams({
      log: email,
      pwd: password,
      wp_submit: "Log In",
      redirect_to: "/wp-admin/",
      testcookie: "1",
    });

    const res = await axios.post(LOGIN_URL, params, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Cookie": "wordpress_test_cookie=WP%20Cookie%20check",
      },
      maxRedirects: 0,
      validateStatus: (s) => s === 302 || s === 200,
    });

    const location = res.headers["location"] ?? "";
    if (res.status === 302 && location.includes("login=failed")) {
      logger.error("Login gagal — kredensial salah");
      return null;
    }

    const rawCookies = res.headers["set-cookie"];
    if (!rawCookies?.length) {
      logger.error("Login gagal — tidak ada cookie di response");
      return null;
    }

    const hasAuthCookie = rawCookies.some((c) =>
      c.startsWith("wordpress_logged_in_"),
    );
    if (!hasAuthCookie) {
      logger.error("Login gagal — tidak ada wordpress_logged_in cookie");
      return null;
    }

    const cookieString = rawCookies
      .map((c) => c.split(";")[0])
      .join("; ");

    logger.info("Cookie berhasil diperbarui");
    return cookieString;
  } catch (err) {
    logger.error({ error: err.message }, "Gagal refresh cookie");
    return null;
  }
}

/**
 * Memory-efficient generator for lazy filtering and mapping
 * Processes items one at a time instead of creating intermediate arrays
 * @param {Array} items - Source array
 * @param {Function} filterFn - Filter predicate
 * @param {Function} mapFn - Map function
 * @yields {*}
 */
export function* lazyFilterMap(items, filterFn, mapFn) {
  for (const item of items) {
    if (filterFn(item)) {
      yield mapFn(item);
    }
  }
}

/**
 * Generator that yields items in chunks to control memory usage
 * @param {Array} items - Source array
 * @param {number} size - Chunk size
 * @yields {Array}
 */
export function* chunked(items, size) {
  for (let i = 0; i < items.length; i += size) {
    yield items.slice(i, i + size);
  }
}

const base = (process.env.IKIRU_BASE_URL || IKIRU_BASE_DEFAULT).trim();
export const SITE_URL = base.endsWith("/") ? base : base + "/";
const latestFallback = SITE_URL + "latest-update/";
export const LATEST_URL = process.env.IKIRU_LATEST_URL || latestFallback;
export const AJAX_PATH = "wp-admin/admin-ajax.php";
export const SECONDARY_SOURCE_URL =
  process.env.SECONDARY_SOURCE_URL || "https://api.shngm.io";
export const SECONDARY_PUBLIC_BASE = getShinigamiPublicBase();
export const SECONDARY_DETAIL_WINDOW_HOURS = Number(
  process.env.SECONDARY_DETAIL_WINDOW_HOURS || 2,
);
export const IKIRU_LATEST_MAX_PAGES = IKIRU_CONFIG.LATEST_MAX_PAGES;
export const IKIRU_EMPTY_PAGE_BREAK_STREAK = Number(
  process.env.IKIRU_EMPTY_PAGE_BREAK_STREAK || 1,
);
export const IKIRU_CHAPTER_LIST_MAX_PAGES = IKIRU_CONFIG.CHAPTER_LIST_MAX_PAGES;
export const SECONDARY_DETAIL_MAX_MANGA = SECONDARY_CONFIG.DETAIL_MAX_MANGA;
export const SECONDARY_DETAIL_THROTTLE_MS = Number(
  process.env.SECONDARY_DETAIL_THROTTLE_MS || 200,
);
export const SECONDARY_CHAPTER_LIST_MAX_PAGES = SECONDARY_CONFIG.CHAPTER_LIST_MAX_PAGES;
export const HTTP_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
export const IKIRU_COOKIE_CACHE_KEY = "ikiru:cookie";
export const IKIRU_COOKIE_REFRESHED_AT_KEY = "ikiru:cookie:refreshed_at";
export const IKIRU_COOKIE_MAX_AGE_SEC = Math.max(
  300,
  Number(process.env.IKIRU_COOKIE_MAX_AGE_SEC || 6 * 60 * 60),
);
export const IKIRU_COOKIE_REFRESH_BACKOFF_MS = Math.max(
  60 * 1000,
  Number(process.env.IKIRU_COOKIE_REFRESH_BACKOFF_MS || 5 * 60 * 1000),
);

// Cookie state is now managed exclusively through Redis to prevent memory leaks
// and ensure consistency across serverless instances
const COOKIE_LOCK_KEY = "ikiru:cookie:refresh:lock";
const COOKIE_LOCK_TTL = 30; // seconds

/**
 * Backward-compatible wrapper around requestWithRetry from httpClient.js.
 * Consolidates the duplicate retry logic that was previously in this file.
 */
export async function withRetry(fn, retries = 1, options = {}) {
  return requestWithRetry(fn, {
    retries,
    baseDelayMs: 1000,
    maxDelayMs: 5000,
    jitterMs: 250,
    adaptive: true,
    deadline: options.deadline,
    onRetry:
      typeof options?.onRetry === "function" ? options.onRetry : undefined,
  });
}

export function shouldReuseCachedCookie(
  refreshedAtRaw,
  maxAgeSec = IKIRU_COOKIE_MAX_AGE_SEC,
  nowMs = Date.now(),
) {
  const refreshedAtMs = Number(refreshedAtRaw);
  if (!Number.isFinite(refreshedAtMs) || refreshedAtMs <= 0) return false;

  const maxAgeMs =
    Math.max(300, Number(maxAgeSec) || IKIRU_COOKIE_MAX_AGE_SEC) * 1000;
  return nowMs - refreshedAtMs < maxAgeMs;
}

export function shouldBackoffCookieRefresh(
  backoffUntilRaw,
  nowMs = Date.now(),
) {
  const backoffUntilMs = Number(backoffUntilRaw);
  return Number.isFinite(backoffUntilMs) && backoffUntilMs > nowMs;
}

async function acquireCookieLock(redis) {
  const token = Date.now() + ":" + Math.random().toString(36).slice(2);
  const acquired = await redis.set(COOKIE_LOCK_KEY, token, {
    nx: true,
    ex: COOKIE_LOCK_TTL,
  });
  return acquired === "OK" ? token : null;
}

async function releaseCookieLock(redis, token) {
  if (!token) return;

  // Use atomic compare-and-delete if Redis eval is available.
  if (typeof redis.eval === "function") {
    try {
      await redis.eval(
        "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
        [COOKIE_LOCK_KEY],
        [token],
      );
      return;
    } catch (err) {
      logger.debug({ err: err.message }, "Atomic lock release unavailable");
    }
  }

  // Fallback: do not perform non-atomic GET+DEL to avoid deleting another process lock.
  // Lock will expire naturally via TTL.
}

export async function getCookie(redis = null) {
  // Fallback to env variable if Redis is not available
  if (!redis) {
    return process.env.IKIRU_COOKIE || "";
  }

  try {
    // Try to get cached cookie from Redis first
    const [cached, refreshedAt, backoffUntil] = await Promise.all([
      redis.get(IKIRU_COOKIE_CACHE_KEY),
      redis.get(IKIRU_COOKIE_REFRESHED_AT_KEY),
      redis.get(IKIRU_COOKIE_CACHE_KEY + ":backoff"),
    ]);

    // Check if we should use cached value
    if (cached && shouldReuseCachedCookie(refreshedAt)) {
      return cached;
    }

    // Check if we're in backoff period
    if (backoffUntil && shouldBackoffCookieRefresh(backoffUntil)) {
      return cached || process.env.IKIRU_COOKIE || "";
    }

    // Try to acquire lock for refresh
    const lockToken = await acquireCookieLock(redis);
    if (!lockToken) {
      // Another process is refreshing, wait a bit and return cached
      await new Promise((resolve) => setTimeout(resolve, 100));
      const fallback = await redis.get(IKIRU_COOKIE_CACHE_KEY);
      return fallback || process.env.IKIRU_COOKIE || "";
    }

    try {
      // Perform refresh
      const fresh = await refreshCookie();
      if (fresh) {
        const now = Date.now();
        await Promise.all([
          redis.set(IKIRU_COOKIE_CACHE_KEY, fresh, {
            ex: IKIRU_COOKIE_MAX_AGE_SEC,
          }),
          redis.set(IKIRU_COOKIE_REFRESHED_AT_KEY, String(now), {
            ex: IKIRU_COOKIE_MAX_AGE_SEC,
          }),
          redis.del(IKIRU_COOKIE_CACHE_KEY + ":backoff"),
        ]);
        return fresh;
      } else {
        // Refresh failed, set backoff and return fallback
        const backoffTime = Date.now() + IKIRU_COOKIE_REFRESH_BACKOFF_MS;
        await redis.set(
          IKIRU_COOKIE_CACHE_KEY + ":backoff",
          String(backoffTime),
          { ex: Math.ceil(IKIRU_COOKIE_REFRESH_BACKOFF_MS / 1000) },
        );
        return cached || process.env.IKIRU_COOKIE || "";
      }
    } catch (err) {
      logger.error({ err: err.message }, "[getCookie] refreshCookie failed");
      // Set backoff on error
      const backoffTime = Date.now() + IKIRU_COOKIE_REFRESH_BACKOFF_MS;
      await redis
        .set(IKIRU_COOKIE_CACHE_KEY + ":backoff", String(backoffTime), {
          ex: Math.ceil(IKIRU_COOKIE_REFRESH_BACKOFF_MS / 1000),
        })
        .catch(() => {});
      return cached || process.env.IKIRU_COOKIE || "";
    } finally {
      await releaseCookieLock(redis, lockToken);
    }
  } catch (err) {
    logger.warn({ err: err.message }, "[getCookie] Redis operation failed");
    return process.env.IKIRU_COOKIE || "";
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const toAbsoluteUrl = (url, base = SITE_URL) => {
  if (!url) return null;
  if (url.startsWith("http")) return url;
  if (url.startsWith("//")) return `https:${url}`;
  const path = url.startsWith("/") ? url.slice(1) : url;
  return base + path;
};

export const cleanImageUrl = (url) =>
  url?.replace(/-\d+x\d+(\.\w+)$/, "$1") ?? null;

export function normalizeText(value = "") {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

export function shouldPrioritizeSecondaryTitle(
  title = "",
  preferredTitleKeys = null,
) {
  if (!(preferredTitleKeys instanceof Set) || preferredTitleKeys.size === 0)
    return true;
  const titleKey = normalizeTitleKey(title);
  if (!titleKey) return false;
  for (const preferred of preferredTitleKeys) {
    if (!preferred) continue;
    if (isSameNormalizedTitle(titleKey, preferred)) {
      return true;
    }
  }
  return false;
}

export function shouldPrioritizeSecondaryEntry(
  item = {},
  preferredMatcher = null,
) {
  if (!preferredMatcher || typeof preferredMatcher !== "object") {
    return shouldPrioritizeSecondaryTitle(item?.title || "", preferredMatcher);
  }

  const titleKeys =
    preferredMatcher.titleKeys instanceof Set
      ? preferredMatcher.titleKeys
      : new Set();
  const urlKeys =
    preferredMatcher.urlKeys instanceof Set
      ? preferredMatcher.urlKeys
      : new Set();
  if (titleKeys.size === 0 && urlKeys.size === 0) return true;

  if (
    titleKeys.size > 0 &&
    shouldPrioritizeSecondaryTitle(item?.title || "", titleKeys)
  ) {
    return true;
  }

  const candidateUrl = normalizeSourceUrl(item?.mangaUrl || item?.url || "");
  return Boolean(candidateUrl) && urlKeys.has(candidateUrl);
}

export function pickSecondaryDescription(row = {}) {
  const raw =
    row?.description ||
    row?.synopsis ||
    row?.summary ||
    row?.short_description ||
    row?.excerpt ||
    row?.desc ||
    "";
  const text = normalizeText(raw);
  return text || null;
}

export function resolveChapterUrl(href, mangaUrl) {
  if (!href) return null;
  const raw = String(href).trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith("/")) return toAbsoluteUrl(raw, SITE_URL);

  const rootBased = toAbsoluteUrl("/" + raw, SITE_URL);
  if (rootBased) return rootBased;

  return toAbsoluteUrl(raw, mangaUrl || SITE_URL);
}

export async function baseHeaders(redis = null, extra = {}) {
  const cookie = await getCookie(redis);
  return {
    "User-Agent": HTTP_USER_AGENT,
    ...(cookie ? { Cookie: cookie } : {}),
    ...extra,
  };
}

export async function scrapeWithHeaders(url, redis = null, options = {}) {
  const headers = await baseHeaders(redis, options.extraHeaders || {});
  return withRetry(
    () =>
      axios.get(url, {
        headers,
        timeout: options.timeout || 15000, // Increased from 6s to 15s
        httpAgent: httpKeepAliveAgent,
        httpsAgent: httpsKeepAliveAgent,
      }),
    options.retries !== undefined ? options.retries : 2, // Increased default retries
    { deadline: options.deadline },
  );
}

export function parseLooseRelativeTime(raw) {
  if (!raw) return null;
  const text = String(raw).toLowerCase().trim();
  const m = text.match(
    /(\d+)\s*(minute|minutes|min|menit|hour|hours|jam|day|days|hari|week|weeks|minggu)/,
  );
  if (!m) return null;

  const amount = Number.parseInt(m[1], 10);
  if (Number.isNaN(amount)) return null;

  const unit = m[2];
  let minutes = amount;
  if (unit === "hour" || unit === "hours" || unit === "jam") {
    minutes = amount * 60;
  } else if (unit === "day" || unit === "days" || unit === "hari") {
    minutes = amount * 60 * 24;
  } else if (unit === "week" || unit === "weeks" || unit === "minggu") {
    minutes = amount * 60 * 24 * 7;
  }

  return new Date(Date.now() - minutes * 60 * 1000);
}

export const getStatusColor = (status) =>
  ({
    Ongoing: 0x22c55e,
    Completed: 0x3b82f6,
    Hiatus: 0xf59e0b,
    Unknown: 0x6b7280,
  })[status] ?? 0x6b7280;

export const ChapterScrapeSchema = z.object({
  title: z.string().min(1, "Judul kosong"),
  chapter: z.string().min(1, "Text chapter kosong"),
  url: z.string().min(1, "URL Chapter kosong"),
  cover: z.string().nullable().optional().or(z.literal("")),
  mangaUrl: z.string().min(1, "URL Manga kosong"),
  mangaId: z.union([z.string(), z.number()]).nullable().optional(),
  rating: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  updatedTime: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  source: z.string().min(1, "Source kosong"),
});

/**
 * Distributed deduplication: Try to 'claim' an update in Redis.
 * This prevents multiple scrapers from fetching expensive details for the same chapter.
 * @returns {Promise<boolean>} - True if claimed (first one), False if already claimed/sent.
 */
export async function checkUpdateClaim(redis, title, chapter) {
  if (!redis) return true;

  const titleKey = normalizeTitleKey(title);
  const chapterKey = normalizeChapterIdentity(chapter);
  if (!titleKey || !chapterKey) return true;

  const dedupeKey = `chapter:dedupe:${titleKey}:${chapterKey}`;

  // Check if already sent or pending
  const existing = await redis.get(dedupeKey);
  if (existing) return false;

  // Try to claim with 10-minute TTL
  // 'pending' status indicates a scraper is currently working on this
  const claimed = await redis.set(dedupeKey, "pending", { nx: true, ex: 600 });
  return claimed === "OK";
}

export function validateChapter(data, chapterLogger) {
  const result = ChapterScrapeSchema.safeParse(data);
  if (!result.success) {
    if (chapterLogger) {
      chapterLogger.warn(
        {
          err: result.error.errors,
          rawTitle: data?.title,
          rawUrl: data?.url,
        },
        "Zod validation failed, skipping corrupted chapter",
      );
    }
    return null;
  }
  return result.data;
}

export { normalizeSource, normalizeSourceUrl, normalizeTitleKey };
