import { z } from "zod";
import axios from "axios";
import {
  isSameNormalizedTitle,
  normalizeTitleKey,
  getShinigamiPublicBase,
  normalizeSource,
  normalizeSourceUrl,
  normalizeChapterIdentity,
  compactTitleKey,
  fuzzyTitleSimilarity,
} from "../domain.js";
import { httpGet, httpPost, requestWithRetry } from "../httpClient.js";
import { detectAndHealRedirect } from "../services/url/healing.js";
import { getLogger } from "../logger.js";
import { IKIRU_CONFIG, SECONDARY_CONFIG } from "../config.js";
import { env } from "../config/env.js";
import { FINGERPRINT_HASH_KEY } from "../constants/redis.js";
import { AppError } from "../errors.js";
import { RedisClient, ProviderErrorCode, HttpScrapeOptions, RetryOptions } from "../types.js";
import { redis } from "../redis.js";

const logger = getLogger({ scope: "cookie" });
const IKIRU_BASE_DEFAULT = "https://05.ikiru.wtf";

const LOGIN_URL = `${(env.IKIRU_BASE_URL || IKIRU_BASE_DEFAULT).replace(/\/+$/, "")}/wp-login.php`;

async function refreshCookie(): Promise<string | null> {
  const email = env.IKIRU_EMAIL;
  const password = env.IKIRU_PASSWORD;

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

    const res = await httpPost(LOGIN_URL, params, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Cookie": "wordpress_test_cookie=WP%20Cookie%20check",
      },
      maxRedirects: 0,
      validateStatus: (s) => s === 302 || s === 200,
    });

    const location = (res.headers["location"] as string) ?? "";
    if (res.status === 302 && location.includes("login=failed")) {
      logger.error({ url: LOGIN_URL }, "Login gagal — kredensial salah");
      return null;
    }

    const rawCookies = res.headers["set-cookie"];
    if (!rawCookies?.length) {
      logger.error({ url: LOGIN_URL }, "Login gagal — tidak ada cookie di response");
      return null;
    }

    const hasAuthCookie = rawCookies.some((c) =>
      c.startsWith("wordpress_logged_in_"),
    );
    if (!hasAuthCookie) {
      logger.error({ url: LOGIN_URL, foundCookies: rawCookies.map(c => c.split('=')[0]).join(', ') }, "Login gagal — tidak ada wordpress_logged_in cookie");
      return null;
    }

    const cookieString = rawCookies
      .map((c) => c.split(";")[0])
      .join("; ");

    logger.info("Cookie berhasil diperbarui");
    return cookieString;
  } catch (err: unknown) {
    logger.error({ error: err instanceof Error ? err.message : String(err) }, "Gagal refresh cookie");
    return null;
  }
}

/**
 * Memory-efficient generator for lazy filtering and mapping
 */
export function* lazyFilterMap<T, R>(
  items: T[],
  filterFn: (item: T) => boolean,
  mapFn: (item: T) => R,
): Generator<R> {
  for (const item of items) {
    if (filterFn(item)) {
      yield mapFn(item);
    }
  }
}

/**
 * Generator that yields items in chunks to control memory usage
 */
export function* chunked<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) {
    yield items.slice(i, i + size);
  }
}

const base = (env.IKIRU_BASE_URL || IKIRU_BASE_DEFAULT).trim();
export const SITE_URL = base.endsWith("/") ? base : base + "/";
export const LATEST_URL = env.IKIRU_LATEST_URL || SITE_URL;
export const AJAX_PATH = "wp-admin/admin-ajax.php";
export const SECONDARY_SOURCE_URL = env.SECONDARY_SOURCE_URL;
export const SECONDARY_PUBLIC_BASE = getShinigamiPublicBase();
export const SECONDARY_DETAIL_WINDOW_HOURS = env.SECONDARY_DETAIL_WINDOW_HOURS;
export const IKIRU_EMPTY_PAGE_BREAK_STREAK = env.IKIRU_EMPTY_PAGE_BREAK_STREAK;
export const IKIRU_CHAPTER_LIST_MAX_PAGES = IKIRU_CONFIG.CHAPTER_LIST_MAX_PAGES;
export const SECONDARY_DETAIL_MAX_MANGA = SECONDARY_CONFIG.DETAIL_MAX_MANGA;
export const SECONDARY_DETAIL_THROTTLE_MS = env.SECONDARY_DETAIL_THROTTLE_MS;
export const SECONDARY_CHAPTER_LIST_MAX_PAGES = SECONDARY_CONFIG.CHAPTER_LIST_MAX_PAGES;
export const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:125.0) Gecko/20100101 Firefox/125.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0",
];

export const ACCEPT_LANGUAGES = [
  "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
  "en-US,en;q=0.9,id;q=0.8",
  "id,en;q=0.9",
];

export function getFingerprintForSource(source = "generic"): { userAgent: string; acceptLanguage: string } {
  // Gunakan User-Agent utama yang stabil untuk Ikiru agar cookienya tidak lekas mati/invalid
  if (source === "ikiru") {
    return {
      userAgent: USER_AGENTS[0],
      acceptLanguage: ACCEPT_LANGUAGES[0],
    };
  }
  
  // Rotasikan secara acak untuk source lain (seperti shinigami) agar menyerupai traffic manusia yang beragam
  const index = Math.floor(Math.random() * USER_AGENTS.length);
  const langIndex = Math.floor(Math.random() * ACCEPT_LANGUAGES.length);
  return {
    userAgent: USER_AGENTS[index],
    acceptLanguage: ACCEPT_LANGUAGES[langIndex],
  };
}

export const HTTP_USER_AGENT = USER_AGENTS[0];
export const IKIRU_COOKIE_CACHE_KEY = "ikiru:cookie";
export const IKIRU_COOKIE_REFRESHED_AT_KEY = "ikiru:cookie:refreshed_at";
export const IKIRU_COOKIE_MAX_AGE_SEC = env.IKIRU_COOKIE_MAX_AGE_SEC;
export const IKIRU_COOKIE_REFRESH_BACKOFF_MS = env.IKIRU_COOKIE_REFRESH_BACKOFF_MS;

const COOKIE_LOCK_KEY = "ikiru:cookie:refresh:lock";
const COOKIE_LOCK_TTL = 30; // seconds

/**
 * Maps a raw error (like from Axios) to a structured ProviderErrorCode.
 */
export function classifyScraperError(err: Error | { code?: string; response?: { status?: number; data?: unknown; headers?: Record<string, string> } } | unknown): ProviderErrorCode {
  if (!err) return "UNKNOWN";

  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const body = String(err.response?.data || "").toLowerCase();
    const isCloudflare =
      body.includes("cloudflare") ||
      String(err.response?.headers?.["server"] || "").toLowerCase().includes("cloudflare");

    if (status === 429) return "RATE_LIMIT";
    if (status === 403 && isCloudflare) return "CLOUDFLARE_BLOCK";
    if (status === 401 || status === 403) return "AUTH_FAILURE";
    if (status && status >= 500) return "UPSTREAM_ERROR";

    if (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT") return "TIMEOUT";
  }

  const errCode = (err as { code?: string }).code;
  if (errCode === "ETIMEDOUT" || errCode === "ECONNABORTED") return "TIMEOUT";

  return "UNKNOWN";
}

/**
 * Backward-compatible wrapper around requestWithRetry.
 */
export async function withRetry<T>(fn: () => Promise<T>, retries = 1, options: RetryOptions = {}): Promise<T> {
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
  refreshedAtRaw: unknown,
  maxAgeSec = IKIRU_COOKIE_MAX_AGE_SEC,
  nowMs = Date.now(),
): boolean {
  const refreshedAtMs = Number(refreshedAtRaw);
  if (!Number.isFinite(refreshedAtMs) || refreshedAtMs <= 0) return false;

  const maxAgeMs =
    Math.max(300, Number(maxAgeSec) || IKIRU_COOKIE_MAX_AGE_SEC) * 1000;
  return nowMs - refreshedAtMs < maxAgeMs;
}

export function shouldBackoffCookieRefresh(
  backoffUntilRaw: unknown,
  nowMs = Date.now(),
): boolean {
  const backoffUntilMs = Number(backoffUntilRaw);
  return Number.isFinite(backoffUntilMs) && backoffUntilMs > nowMs;
}

async function acquireCookieLock(redis: RedisClient): Promise<string | null> {
  const token = Date.now() + ":" + Math.random().toString(36).slice(2);
  const acquired = await redis.set(COOKIE_LOCK_KEY, token, {
    nx: true,
    ex: COOKIE_LOCK_TTL,
  });
  return acquired === "OK" ? token : null;
}

async function releaseCookieLock(redis: RedisClient, token: string | null): Promise<void> {
  if (!token) return;

  if (typeof redis.eval === "function") {
    try {
      await redis.eval(
        "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
        [COOKIE_LOCK_KEY],
        [token],
      );
      return;
    } catch (err: unknown) {
      logger.debug({ err: err instanceof Error ? err.message : String(err) }, "Atomic lock release unavailable");
    }
  }
}

export async function getCookie(redis: RedisClient | null = null): Promise<string> {
  if (!redis) {
    return env.IKIRU_COOKIE || "";
  }

  try {
    const [cached, refreshedAt, backoffUntil] = await Promise.all([
      redis.get(IKIRU_COOKIE_CACHE_KEY),
      redis.get(IKIRU_COOKIE_REFRESHED_AT_KEY),
      redis.get(IKIRU_COOKIE_CACHE_KEY + ":backoff"),
    ]);

    if (cached && shouldReuseCachedCookie(refreshedAt)) {
      return cached;
    }

    if (backoffUntil && shouldBackoffCookieRefresh(backoffUntil)) {
      return cached || env.IKIRU_COOKIE || "";
    }

    const lockToken = await acquireCookieLock(redis);
    if (!lockToken) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const fallback = await redis.get(IKIRU_COOKIE_CACHE_KEY);
      return fallback || env.IKIRU_COOKIE || "";
    }

    try {
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
        const backoffTime = Date.now() + IKIRU_COOKIE_REFRESH_BACKOFF_MS;
        await redis.set(
          IKIRU_COOKIE_CACHE_KEY + ":backoff",
          String(backoffTime),
          { ex: Math.ceil(IKIRU_COOKIE_REFRESH_BACKOFF_MS / 1000) },
        );
        return cached || env.IKIRU_COOKIE || ""
      }
    } catch (err: unknown) {
      const errMessage = err instanceof Error ? err.message : String(err);
      logger.error({ err: errMessage }, "[getCookie] refreshCookie failed");
      const backoffTime = Date.now() + IKIRU_COOKIE_REFRESH_BACKOFF_MS;
      await redis.set(IKIRU_COOKIE_CACHE_KEY + ":backoff", String(backoffTime), {
        ex: Math.ceil(IKIRU_COOKIE_REFRESH_BACKOFF_MS / 1000),
      });
      return cached || env.IKIRU_COOKIE || "";
    } finally {
      await releaseCookieLock(redis, lockToken);
    }
  } catch (err: unknown) {
    const errMessage = err instanceof Error ? err.message : String(err);
    logger.warn({ err: errMessage }, "[getCookie] Redis operation failed");
    return env.IKIRU_COOKIE || "";
  }
}

export const toAbsoluteUrl = (url: string | null | undefined, base = SITE_URL): string | null => {
  if (!url) return null;
  if (url.startsWith("http")) return url;
  if (url.startsWith("//")) return `https:${url}`;
  const path = url.startsWith("/") ? url.slice(1) : url;
  return base + path;
};

export const cleanImageUrl = (url: string | null | undefined): string | null =>
  url ? url.replace(/-\d+x\d+(\.\w+)$/, "$1") : null;

export function normalizeText(value: string | null | undefined = ""): string {
  let val = String(value || "").trim();
  
  if (val.length > 3) {
    // 1. Handle double-spaced word separators (obfuscation style A)
    const hasDoubleSpaces = val.includes("  ");
    const spaces = (val.match(/ /g) || []).length;
    
    if (hasDoubleSpaces || spaces > val.length / 3) {
      // Step A: Protect double spaces (which likely represent real word gaps)
      val = val.replace(/\s{2,}/g, "[[SPACE]]");
      // Step B: Remove all other single spaces (letter gaps)
      val = val.replace(/ /g, "");
      // Step C: Restore word gaps
      val = val.replace(/\[\[SPACE\]\]/g, " ");
    }

    // 2. Fallback for single-spaced obfuscation (style B: "J a k s a")
    if (!hasDoubleSpaces && spaces > val.length / 3) {
       // Join all characters, but try to preserve spaces before Capital letters
       // or other heuristics if possible. For now, join and then fix CamelCase
       val = val.replace(/(\b\w)\s+(?=\w\b)/g, "$1");
       
       // If we accidentally joined words like "InvincibleWith", split them
       // Match lowercase followed by uppercase: "eW" -> "e W"
       val = val.replace(/([a-z])([A-Z])/g, "$1 $2");
    }
  }

  return val.replace(/\s+/g, " ").trim();
}

export function shouldPrioritizeSecondaryTitle(
  title = "",
  preferredTitleKeys: Set<string | null> | null = null,
): boolean {
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
  item: { title?: string; mangaUrl?: string; url?: string } = {},
  preferredMatcher: { titleKeys?: Set<string>; urlKeys?: Set<string> } | null = null,
): boolean {
  if (!preferredMatcher || typeof preferredMatcher !== "object") {
    return shouldPrioritizeSecondaryTitle(item?.title || "", preferredMatcher);
  }

  const titleKeys =
    preferredMatcher.titleKeys instanceof Set
      ? preferredMatcher.titleKeys
      : new Set<string>();
  const urlKeys =
    preferredMatcher.urlKeys instanceof Set
      ? preferredMatcher.urlKeys
      : new Set<string>();
  if (titleKeys.size === 0 && urlKeys.size === 0) return true;

  if (
    titleKeys.size > 0 &&
    shouldPrioritizeSecondaryTitle(item?.title || "", titleKeys)
  ) {
    return true;
  }

  const candidateUrl = normalizeSourceUrl(item?.mangaUrl || item?.url || "");
  return Boolean(candidateUrl) && urlKeys.has(candidateUrl!);
}

export function pickSecondaryDescription(row: Partial<{
  description: string;
  synopsis: string;
  summary: string;
  short_description: string;
  excerpt: string;
  desc: string;
}> = {}): string | null {
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

export function resolveChapterUrl(href: string | null | undefined, mangaUrl: string | null): string | null {
  if (!href) return null;
  const raw = String(href).trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith("/")) return toAbsoluteUrl(raw, SITE_URL);

  const rootBased = toAbsoluteUrl("/" + raw, SITE_URL);
  if (rootBased) return rootBased;

  return toAbsoluteUrl(raw, mangaUrl || SITE_URL);
}

export async function baseHeaders(
  redis: RedisClient | null = null,
  extra: Record<string, string> = {},
  source = "generic"
): Promise<Record<string, string>> {
  const cookie = await getCookie(redis);
  const fingerprint = getFingerprintForSource(source);
  return {
    "User-Agent": fingerprint.userAgent,
    "Accept-Language": fingerprint.acceptLanguage,
    ...(cookie ? { Cookie: cookie } : {}),
    ...extra,
  };
}

export async function scrapeWithHeaders(
  url: string,
  redis: RedisClient | null = null,
  options: HttpScrapeOptions = {},
): Promise<{ data: string; status: number; headers: Record<string, string> }> {
  const source = options.source || "external-site";
  const headers = await baseHeaders(redis, options.extraHeaders || {}, source);

  try {
    const res = await withRetry(
      () =>
        httpGet(url, {
          headers,
          timeout: options.timeout || 15000,
        }),
      options.retries !== undefined ? options.retries : 2,
      { deadline: options.deadline },
    );

    // Auto-healing: detect redirects
    await detectAndHealRedirect(url, res);

    return {
      data: res.data,
      status: res.status,
      headers: res.headers as Record<string, string>,
    };
  } catch (err: unknown) {
    const statusCode = (err as any)?.response?.status || 500;
    const message = err instanceof Error ? err.message : String(err);
    throw new AppError(message, {
      code: "EXTERNAL_ERROR",
      statusCode,
      details: { url, method: "GET", source }
    });
  }
}

export async function getFingerprintHeaders(redis: RedisClient | null, url: string): Promise<Record<string, string>> {
  if (!redis || !url) return {};
  try {
    const raw = await redis.hget(FINGERPRINT_HASH_KEY, url);
    if (!raw) return {};
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const headers: Record<string, string> = {};
    if (parsed.etag) headers["If-None-Match"] = parsed.etag;
    if (parsed.lastModified) headers["If-Modified-Since"] = parsed.lastModified;
    return headers;
  } catch (err) {
    logger.debug({ err: (err as Error).message, url }, "Fingerprint headers fetch failed");
    return {};
  }
}

export async function saveFingerprint(redis: RedisClient | null, url: string, response: any): Promise<void> {
  if (!redis || !url || !response?.headers) return;

  const etag = response.headers["etag"];
  const lastModified = response.headers["last-modified"];

  if (!etag && !lastModified) return;

  try {
    const pipeline = redis.pipeline();
    pipeline.hset(FINGERPRINT_HASH_KEY, {
      [url]: JSON.stringify({
        etag: etag || null,
        lastModified: lastModified || null,
        capturedAt: new Date().toISOString()
      })
    });
    pipeline.eval(
      "return redis.call('HPEXPIRE', KEYS[1], ARGV[1], 'FIELDS', 1, ARGV[2])",
      [FINGERPRINT_HASH_KEY],
      [7 * 24 * 3600 * 1000, url]
    );
    await pipeline.exec();
  } catch (err: unknown) {
    const errMessage = err instanceof Error ? err.message : String(err);
    logger.debug({ err: errMessage, url }, "Fingerprint save failed");
  }
}

export const getStatusColor = (status: string | null | undefined): number =>
(
  ({
    Ongoing: 0x22c55e,
    Completed: 0x3b82f6,
    Hiatus: 0xf59e0b,
    Unknown: 0x6b7280,
  } as Record<string, number>)[status || "Unknown"] ?? 0x6b7280
);

import { ChapterItemSchema } from "../schemas.js";

export function validateChapter(data: unknown, chapterLogger?: { warn: (obj: Record<string, unknown>, msg: string) => void }): z.infer<typeof ChapterItemSchema> | null {
  const result = ChapterItemSchema.safeParse(data);
  if (!result.success) {
    if (chapterLogger) {
      chapterLogger.warn(
        {
          err: result.error.issues,
          rawTitle: (data as { title?: string })?.title,
          rawUrl: (data as { url?: string })?.url,
        },
        "Zod validation failed, skipping corrupted chapter",
      );
    }
    return null;
  }
  return result.data;
}

export function formatChapterText(num: string | number | null | undefined): string {
  const t = String(num ?? "").trim();
  return t ? (/chapter/i.test(t) ? t : `Chapter ${t}`) : "";
}

export { isWithinLastHours } from "../dateUtils.js";

export { normalizeSource, normalizeSourceUrl, normalizeTitleKey, compactTitleKey, fuzzyTitleSimilarity };
export { ChapterItemSchema as ChapterScrapeSchema };
export { parseLooseRelativeTime } from "../dateUtils.js";

