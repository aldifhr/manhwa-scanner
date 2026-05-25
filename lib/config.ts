import { env } from "./config/env.js";
export { env };

// --- Time Constants (Seconds) ---
export const CHAPTER_TTL_SEC = env.CHAPTER_TTL_SEC;
export const CHAPTER_PENDING_TTL_SEC = env.CHAPTER_PENDING_TTL_SEC;
export const CROSS_SOURCE_DEDUPE_TTL_SEC = env.CROSS_SOURCE_DEDUPE_TTL_SEC;
export const RECENT_LIST_TTL_SEC = env.RECENT_LIST_TTL_SEC;
export const RECENT_LIST_MAX_SIZE = 1000;
export const ONE_DAY_MS = 24 * 60 * 60 * 1000;
export const STATUS_CACHE_SEC = 300;

// --- QStash Config ---
export const QSTASH_ENABLED = env.QSTASH_ENABLED;
export const QSTASH_TOKEN = env.QSTASH_TOKEN;
export const QSTASH_WORKER_URL = env.QSTASH_WORKER_URL;
export const QSTASH_CURRENT_SIGNING_KEY = env.QSTASH_CURRENT_SIGNING_KEY;
export const QSTASH_NEXT_SIGNING_KEY = env.QSTASH_NEXT_SIGNING_KEY;
export const LOGS_CACHE_SEC = 600;
export const RECENT_CACHE_SEC = 1800;
export const HEALTH_CACHE_TTL_MS = 300_000;
export const INCIDENT_CACHE_TTL = 3600;
export const CLAIM_STATUS = {
  PENDING: "pending",
  ENQUEUED: "enqueued",
  SENT: "sent",
};

// --- Discord Constants ---
export const DISCORD_EPHEMERAL_FLAG = 64;
export const DISCORD_COMPONENT_TYPE = {
  ACTION_ROW: 1,
  BUTTON: 2,
  STRING_SELECT: 3,
};
export const DISCORD_BUTTON_STYLE = {
  PRIMARY: 1,
  SECONDARY: 2,
  SUCCESS: 3,
  DANGER: 4,
  LINK: 5,
};
export const DISCORD_EMBED_TITLE_LIMIT = 256;
export const DISCORD_EMBED_DESCRIPTION_LIMIT = 4096;

// --- Scraper Config ---
export const SCRAPER_LOOKBACK_HOURS = env.SCRAPER_LOOKBACK_HOURS;

export const IKIRU_CONFIG = {
  BASE_URL: env.IKIRU_BASE_URL,
  MAX_RETRIES: env.IKIRU_MAX_RETRIES,
  RETRY_DELAY: env.IKIRU_RETRY_DELAY,
  TOTAL_TIMEOUT: env.IKIRU_TOTAL_TIMEOUT,
  REQUEST_TIMEOUT: env.IKIRU_REQUEST_TIMEOUT,
  MAX_PAGES: env.IKIRU_MAX_PAGES,
  MAX_CHAPTERS: env.IKIRU_MAX_CHAPTERS,
  CHAPTER_LIST_MAX_PAGES: env.IKIRU_CHAPTER_LIST_MAX_PAGES,
  EMPTY_PAGE_BREAK_STREAK: 1,
};

export const SECONDARY_CONFIG = {
  API_BASE: env.SHINIGAMI_API_BASE,
  MAX_RETRIES: env.SHINIGAMI_MAX_RETRIES,
  RETRY_DELAY: env.SHINIGAMI_RETRY_DELAY,
  TIMEOUT: env.SHINIGAMI_TIMEOUT,
  REQUEST_TIMEOUT: env.SECONDARY_REQUEST_TIMEOUT,
  TOTAL_TIMEOUT: env.SECONDARY_TOTAL_TIMEOUT,
  LOOKBACK_HOURS: env.SHINIGAMI_LOOKBACK_HOURS,
  DIRECT_FALLBACK_MAX_URLS: env.SHINIGAMI_DIRECT_FALLBACK_MAX_URLS,
  DETAIL_MAX_MANGA: env.SHINIGAMI_DETAIL_MAX_MANGA,
  CHAPTER_LIST_MAX_PAGES: env.SHINIGAMI_CHAPTER_LIST_MAX_PAGES,
  MAX_ROWS: env.SHINIGAMI_MAX_ROWS || 20,
  MAX_CONCURRENCY: env.SHINIGAMI_MAX_CONCURRENCY || 5,
  MAX_EXPANSION_SEARCHES: env.SHINIGAMI_MAX_EXPANSION_SEARCHES || 5,
};

// --- Dispatch Config ---
export const DEFAULT_CHAPTER_DISPATCH_CONCURRENCY = env.CHAPTER_DISPATCH_CONCURRENCY;
export const DEFAULT_DISPATCH_WRITE_TASK_BATCH = env.DISPATCH_WRITE_TASK_BATCH;
export const ENQUEUED_EXPIRY_MS = env.ENQUEUED_EXPIRY_MS;

// --- Session Config ---
export const SESSION_TTL_SECONDS = env.SESSION_TTL_SECONDS || 43200; // Default 12 hours

// --- UI Labels ---
export const CACHE_TTL_LABEL = "3 Hari";
export const CRON_INTERVAL_LABEL = "5 - 30 Menit";

/**
 * Resolves a value to a positive integer, falling back to a default value if invalid.
 */
export function resolvePositiveInt(rawValue: unknown, fallback: number): number {
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
