/**
 * Redis Key Constants and Prefixes
 */

// --- Scrapers & Sources ---
export const SOURCE_KEYS = ["ikiru", "shinigami", "shinigami_mirror", "shinigami_project"];



// --- Whitelist ---
export const WHITELIST_DATA_KEY = "whitelist:data";
export const WHITELIST_INDEX_KEY = "whitelist:index";
export const WHITELIST_DB_CACHE_KEY = "whitelist:db_cache";


// --- Manga & Chapters ---
export const MANGA_METADATA_KEY = "manga:metadata";
export const DISPATCH_HISTORY_KEY = "dispatch:history";
export const RECENT_CHAPTERS_KEY = "dispatch:recent_list";
export const MANGA_METADATA_CACHE_PREFIX = "cache:manga:metadata:";
export const MANGA_LAST_UPDATES_KEY = "manga:last_updates";
export const MANGA_LAST_CHAPTERS_KEY = "manga:last_chapters";
export const MANGA_SUBSCRIBERS_KEY = "manga:subscribers";
export const MANGA_SUBSCRIBERS_SET_PREFIX = "manga:subscribers:set:";
export const MANGA_MUTES_KEY = "manga:mutes";
export const MANGA_MUTES_SET_PREFIX = "manga:mutes:set:";
export const MANGA_STALE_WARNED_KEY = "manga:stale_warned";

// --- Cron & Logs ---
export const CRON_LOG_LIST_KEY = "cron:logs";
export const CRON_LAST_RUN_KEY = "cron:last_run";
export const CRON_DAILY_STATS_MASTER_KEY = "cron:daily_stats";
export const CRON_LOG_THROTTLE_KEY_PREFIX = "cron:log:throttle";

// --- Health & Incidents ---
export const SOURCES_HEALTH_KEY = "sources:health";
export const DISCORD_NOTIFICATION_FAILURES_KEY = "discord:notification_failures";
export const INCIDENT_CACHE_KEY = "cache:api:incidents:v1";

export const DISCORD_GUILDS_COUNT_KEY = "discord:guilds:count";
export const HEALTH_RECOMMENDATIONS_KEY = "health:recommendations";
export const HEALTH_LAST_CHECK_KEY = "health:last-check";

// --- Dashboard & API Caches ---
export const LIVE_EVENTS_KEY = "dashboard:live_events";
export const WHITELIST_API_CACHE_KEY = "cache:api:whitelist:v1";
export const RECENT_API_CACHE_KEY = "cache:api:recent:v1";
export const LOGS_API_CACHE_KEY = "cache:api:logs:v1";

// --- Tracking & Prefixes ---
export const LAST_CHECK_HASH_PREFIX = "scrape:lastChecks";
export const NOTIFICATION_QUEUE_KEY = "queue:notifications";
export const NOTIFICATION_PROCESSING_QUEUE_KEY = "queue:notifications:processing";
export const CHANNEL_HASH_KEY = "channels:guild-map";
export const CHANNEL_KEY_PREFIX = "channel:";
export const CHANNEL_VALIDATION_STATE_KEY = "channels:validation-state";

// --- Fingerprints (ETags) ---
export const FINGERPRINT_HASH_KEY = "scrape:fingerprints";

// --- User Settings & Follows ---
export const USER_SETTINGS_KEY = "users:settings";
export const USER_FOLLOWS_SET_PREFIX = "user:follows:set:";
export const USER_ALL_MODE_SET_KEY = "users:mode:all";
export const MANGA_POPULARITY_KEY = "manga:popularity_index";
