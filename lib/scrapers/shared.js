import axios from "axios";
import { normalizeTitleKey } from "../domain/manga.js";
import { normalizeSource, normalizeSourceUrl } from "../domain/source.js";
import { refreshCookie } from "../cookie.js";

export const SITE_URL = "https://02.ikiru.wtf/";
export const LATEST_URL = "https://02.ikiru.wtf/latest-update/";
export const AJAX_PATH = "wp-admin/admin-ajax.php";
export const SECONDARY_SOURCE_URL =
  process.env.SECONDARY_SOURCE_URL || "https://api.shngm.io";
export const SECONDARY_PUBLIC_BASE =
  (process.env.SECONDARY_PUBLIC_BASE || "https://a.shinigami.asia")
    .replace(/\/+$/, "")
    .replace(/^https?:\/\/(?:www\.)?shngm\.id\b/i, "https://a.shinigami.asia")
    .replace(/^https?:\/\/(?:www\.)?shinigami\.asia\b/i, "https://a.shinigami.asia");
export const SECONDARY_DETAIL_WINDOW_HOURS = Number(
  process.env.SECONDARY_DETAIL_WINDOW_HOURS || 2,
);
export const IKIRU_LATEST_MAX_PAGES = Number(
  process.env.IKIRU_LATEST_MAX_PAGES || 5,
);
export const IKIRU_EMPTY_PAGE_BREAK_STREAK = Number(
  process.env.IKIRU_EMPTY_PAGE_BREAK_STREAK || 1,
);
export const IKIRU_CHAPTER_LIST_MAX_PAGES = Number(
  process.env.IKIRU_CHAPTER_LIST_MAX_PAGES || 4,
);
export const SECONDARY_DETAIL_MAX_MANGA = Number(
  process.env.SECONDARY_DETAIL_MAX_MANGA || 6,
);
export const SECONDARY_DETAIL_THROTTLE_MS = Number(
  process.env.SECONDARY_DETAIL_THROTTLE_MS || 200,
);
export const SECONDARY_CHAPTER_LIST_MAX_PAGES = Number(
  process.env.SECONDARY_CHAPTER_LIST_MAX_PAGES || 2,
);
export const HTTP_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
export const IKIRU_COOKIE_CACHE_KEY = "ikiru:cookie";
export const IKIRU_COOKIE_REFRESHED_AT_KEY = "ikiru:cookie:refreshed_at";
export const IKIRU_COOKIE_MAX_AGE_SEC = Math.max(
  300,
  Number(process.env.IKIRU_COOKIE_MAX_AGE_SEC || 6 * 60 * 60),
);

let cookieValue = process.env.IKIRU_COOKIE || "";
let cookieLoadedAtMs = cookieValue ? Date.now() : 0;
let cookiePromise = null;

function parseRetryAfterMs(retryAfterHeader) {
  if (!retryAfterHeader) return null;
  const raw = String(retryAfterHeader).trim();
  const asSeconds = Number(raw);
  if (Number.isFinite(asSeconds)) return Math.max(0, asSeconds * 1000);
  const asDate = Date.parse(raw);
  if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());
  return null;
}

export async function withRetry(fn, retries = 3, options = {}) {
  const onRetry = typeof options?.onRetry === "function" ? options.onRetry : null;

  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      const status = err?.response?.status;
      if (status >= 400 && status < 500 && status !== 429) {
        throw err;
      }
      if (i === retries - 1) throw err;
      const retryAfterMs = parseRetryAfterMs(err?.response?.headers?.["retry-after"]);
      const baseDelay = status === 429
        ? Math.min(1500 * Math.pow(2, i), 12000)
        : Math.min(1000 * Math.pow(2, i), 5000);
      const jitter = Math.floor(Math.random() * 250);
      const delay = Math.max(retryAfterMs ?? 0, baseDelay) + jitter;
      if (onRetry) onRetry(err, i + 1, delay);
      console.log(`[retry] ${i + 1}/${retries} in ${delay}ms... (${err.message})`);
      await sleep(delay);
    }
  }
}

export function shouldReuseCachedCookie(
  refreshedAtRaw,
  maxAgeSec = IKIRU_COOKIE_MAX_AGE_SEC,
  nowMs = Date.now(),
) {
  const refreshedAtMs = Number(refreshedAtRaw);
  if (!Number.isFinite(refreshedAtMs) || refreshedAtMs <= 0) return false;

  const maxAgeMs = Math.max(300, Number(maxAgeSec) || IKIRU_COOKIE_MAX_AGE_SEC) * 1000;
  return nowMs - refreshedAtMs < maxAgeMs;
}

export async function getCookie(redis = null) {
  if (cookieValue && shouldReuseCachedCookie(cookieLoadedAtMs)) return cookieValue;
  if (cookiePromise) return cookiePromise;

  cookiePromise = (async () => {
    if (redis) {
      try {
        const [cached, refreshedAt] = await Promise.all([
          redis.get(IKIRU_COOKIE_CACHE_KEY),
          redis.get(IKIRU_COOKIE_REFRESHED_AT_KEY),
        ]);
        if (cached && shouldReuseCachedCookie(refreshedAt)) {
          cookieValue = cached;
          cookieLoadedAtMs = Number(refreshedAt);
          console.log("Cookie loaded from Redis");
          return cookieValue;
        }
      } catch (err) {
        console.warn("[getCookie] Redis fetch failed:", err.message);
      }
    }

    try {
      const fresh = await refreshCookie();
      if (fresh) {
        cookieValue = fresh;
        cookieLoadedAtMs = Date.now();
        if (redis) {
          await Promise.all([
            redis.set(IKIRU_COOKIE_CACHE_KEY, fresh, { ex: IKIRU_COOKIE_MAX_AGE_SEC }),
            redis.set(IKIRU_COOKIE_REFRESHED_AT_KEY, String(cookieLoadedAtMs), {
              ex: IKIRU_COOKIE_MAX_AGE_SEC,
            }),
          ]).catch((err) => console.warn("[getCookie] Redis set failed:", err.message));
        }
      } else if (redis) {
        try {
          const fallback = await redis.get(IKIRU_COOKIE_CACHE_KEY);
          if (fallback) {
            cookieValue = fallback;
            cookieLoadedAtMs = 0;
          }
        } catch (err) {
          console.warn("[getCookie] Redis fallback failed:", err.message);
        }
      }
    } catch (err) {
      console.error("[getCookie] refreshCookie failed:", err.message);
    }

    return cookieValue || "";
  })();

  try {
    return await cookiePromise;
  } finally {
    cookiePromise = null;
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const toAbsoluteUrl = (url, base = SITE_URL) => {
  if (!url) return null;
  if (url.startsWith("http")) return url;
  return `${base}${url.startsWith("/") ? url.slice(1) : url}`;
};

export const cleanImageUrl = (url) => url?.replace(/-\d+x\d+(\.\w+)$/, "$1") ?? null;

export function normalizeText(value = "") {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

export function shouldPrioritizeSecondaryTitle(title = "", preferredTitleKeys = null) {
  if (!(preferredTitleKeys instanceof Set) || preferredTitleKeys.size === 0) return true;
  const titleKey = normalizeTitleKey(title);
  if (!titleKey) return false;
  for (const preferred of preferredTitleKeys) {
    if (!preferred) continue;
    if (titleKey === preferred || titleKey.includes(preferred) || preferred.includes(titleKey)) {
      return true;
    }
  }
  return false;
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

  const rootBased = toAbsoluteUrl(`/${raw}`, SITE_URL);
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
        timeout: options.timeout || 10000,
      }),
    options.retries,
  );
}

export const formatTimeAgo = (datetime) => {
  const parsed = parseIkiruDatetime(datetime);
  if (!parsed) return "Unknown";

  const diffMs = Date.now() - parsed.getTime();
  if (diffMs < -5 * 60 * 1000) {
    return new Intl.DateTimeFormat("id-ID", {
      hour: "2-digit",
      minute: "2-digit",
      day: "2-digit",
      month: "short",
      timeZone: "Asia/Jakarta",
    }).format(parsed);
  }

  try {
    const mins = Math.floor(diffMs / 60000);
    const hours = Math.floor(diffMs / 3600000);
    const days = Math.floor(diffMs / 86400000);

    return mins < 1
      ? "Just now"
      : mins < 60
        ? `${mins} min ago`
        : hours < 24
          ? `${hours} hour${hours > 1 ? "s" : ""} ago`
          : `${days} day${days > 1 ? "s" : ""} ago`;
  } catch {
    return "Unknown";
  }
};

export function parseIkiruDatetime(datetime) {
  if (!datetime) return null;
  const raw = String(datetime).trim();
  if (!raw) return null;

  const normalizedBase = raw.replace(
    /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}(?::\d{2})?)$/,
    "$1T$2",
  );
  const hasTimezone = /([zZ]|[+-]\d{2}:\d{2})$/.test(normalizedBase);
  const candidates = hasTimezone
    ? [new Date(normalizedBase)]
    : [new Date(normalizedBase), new Date(`${normalizedBase}+07:00`)];

  const valid = candidates.filter((d) => !Number.isNaN(d.getTime()));
  if (!valid.length) return null;
  if (valid.length === 1) return valid[0];

  const now = Date.now();
  const notTooFuture = valid.filter((d) => d.getTime() <= now + 10 * 60 * 1000);
  const pool = notTooFuture.length ? notTooFuture : valid;

  return pool.sort(
    (a, b) => Math.abs(now - a.getTime()) - Math.abs(now - b.getTime()),
  )[0];
}

export function parseRelativeTimeText(raw) {
  if (!raw) return null;
  const text = String(raw).toLowerCase().trim();
  const m = text.match(/(\d+)\s*(hour|hours|day|days|jam|hari)/);
  if (!m) return null;

  const amount = Number.parseInt(m[1], 10);
  if (Number.isNaN(amount)) return null;

  const unit = m[2];
  const hours = unit.startsWith("day") || unit === "hari" ? amount * 24 : amount;
  return new Date(Date.now() - hours * 3600 * 1000);
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

export function isValidDate(value) {
  return value instanceof Date && Number.isFinite(value.getTime());
}

export const STATUS_EMOJI = {
  Ongoing: "O",
  Completed: "C",
  Hiatus: "H",
  Unknown: "?",
};

export const getStatusColor = (status) =>
  ({
    Ongoing: 0x22c55e,
    Completed: 0x3b82f6,
    Hiatus: 0xf59e0b,
    Unknown: 0x6b7280,
  })[status] ?? 0x6b7280;

export {
  normalizeSource,
  normalizeSourceUrl,
  normalizeTitleKey,
};

