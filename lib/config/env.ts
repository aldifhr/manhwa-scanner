// dotenv/config removed to support Edge Runtime. For local dev, use tsx --env-file or similar.
import { z } from "zod";

const envSchema = z.object({
    // Required
    UPSTASH_REDIS_REST_URL: z.string().url(),
    UPSTASH_REDIS_REST_TOKEN: z.string().min(1),
    DISCORD_BOT_TOKEN: z.string().min(1),
    DISCORD_APPLICATION_ID: z.string().optional(),
    HEALTH_ALERT_CHANNEL_ID: z.string().optional(),
    ALLOWED_USER_IDS: z.string().optional(),

    // QStash (optional - uses same Upstash credentials)
    QSTASH_ENABLED: z.preprocess((v) => v === "true" || v === "1", z.boolean()).default(false),
    QSTASH_TOKEN: z.string().optional(),
    QSTASH_WORKER_URL: z.string().url().optional(),
    QSTASH_CURRENT_SIGNING_KEY: z.string().optional(),
    QSTASH_NEXT_SIGNING_KEY: z.string().optional(),

    // Auth & Security
    DASHBOARD_PASSWORD: z.string().default("").or(z.string().nullable()).transform(v => v || ""),
    CRON_SECRET: z.string().default(""),
    DISCORD_OWNER_ID: z.string().optional(),
    DISCORD_PUBLIC_KEY: z.string().optional(),
    DASHBOARD_SESSION_SECRET: z.string().optional(),
    DASHBOARD_LOGIN_WINDOW_SECONDS: z.preprocess((v) => Number(v) || 600, z.number()).default(600),
    DASHBOARD_LOGIN_MAX_ATTEMPTS: z.preprocess((v) => Number(v) || 5, z.number()).default(5),
    ALLOW_DASHBOARD_CRON: z.preprocess((v) => v === "true" || v === "1", z.boolean()).default(false),
    CRON_ALLOWED_IPS: z.string().optional(), // Comma-separated list of IPs
    CRON_MAX_DAILY_RUNS: z.preprocess((v) => Number(v) || 144, z.number()).default(144),
    TRUST_PROXY: z.preprocess((v) => v === "true" || v === "1", z.boolean()).optional(),
    VERCEL: z.preprocess((v) => v === "true" || v === "1", z.boolean()).default(false),
    WORKER_TOKEN: z.string().optional(),
    FASTCRON_API_TOKEN: z.string().optional(),
    VERCEL_PROTECTION_BYPASS: z.string().optional(),


    // URLs
    BASE_URL: z.string().optional(),
    IKIRU_BASE_URL: z.string().url().default("https://05.ikiru.wtf"),
    SHINIGAMI_BASE_URL: z.string().url().optional(),
    SECONDARY_PUBLIC_BASE: z.string().url().optional(),

    // Runtime Tuning
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    CRON_DEBUG: z.preprocess((v) => v === "true" || v === "1", z.boolean()).default(false),
    CHANNEL_VALIDATION_REFRESH_SECONDS: z.preprocess((v) => Number(v) || 21600, z.number()).default(21600),
    SOURCE_FAIL_THRESHOLD: z.preprocess((v) => Number(v) || 3, z.number()).default(3),
    SOURCE_COOLDOWN_SECONDS: z.preprocess((v) => Number(v) || 1800, z.number()).default(1800),
    CRON_INFO_LOG_THROTTLE_SEC: z.preprocess((v) => Number(v) || 1800, z.number()).default(1800),
    CRON_FAST_SECONDARY_LIMIT: z.preprocess((v) => Number(v) || 0, z.number()).default(0),
    CHANNEL_VALIDATION_CONCURRENCY: z.preprocess((v) => Number(v) || 8, z.number()).default(8),
    CHANNEL_VALIDATION_CACHE_SEC: z.preprocess((v) => Number(v) || 21600, z.number()).default(21600),

    // Feature Toggles
    CRON_INCREMENTAL: z.preprocess((v) => v === "true" || v === "1" || v === undefined, z.boolean()).default(true),
    CRON_DEDUPLICATE: z.preprocess((v) => v === "true" || v === "1" || v === undefined, z.boolean()).default(true),

    // Constraints & Timeouts
    IKIRU_TOTAL_TIMEOUT: z.preprocess((v) => Number(v) || 17000, z.number()).default(17000),
    IKIRU_REQUEST_TIMEOUT: z.preprocess((v) => Number(v) || 5000, z.number()).default(5000),
    IKIRU_MAX_RETRIES: z.preprocess((v) => Number(v) || 2, z.number()).default(2),
    IKIRU_RETRY_DELAY: z.preprocess((v) => Number(v) || 1000, z.number()).default(1000),
    IKIRU_MAX_CHAPTERS: z.preprocess((v) => Number(v) || 10, z.number()).default(10),
    IKIRU_MAX_PAGES: z.preprocess((v) => Number(v) || 3, z.number()).default(3),
    IKIRU_CHAPTER_LIST_MAX_PAGES: z.preprocess((v) => Number(v) || 2, z.number()).default(2),

    SECONDARY_TOTAL_TIMEOUT: z.preprocess((v) => Number(v) || 22000, z.number()).default(22000),
    SECONDARY_REQUEST_TIMEOUT: z.preprocess((v) => Number(v) || 8000, z.number()).default(8000),
    SECONDARY_MAX_RETRIES: z.preprocess((v) => Number(v) || 2, z.number()).default(2),
    SECONDARY_RETRY_DELAY: z.preprocess((v) => Number(v) || 1000, z.number()).default(1000),
    SHINIGAMI_CHAPTER_LIST_MAX_PAGES: z.preprocess((v) => Number(v) || 2, z.number()).default(2),

    // Session & TTL Settings (Seconds)
    SESSION_TTL_SECONDS: z.preprocess((v) => Number(v) || 43200, z.number()).default(43200),
    CHAPTER_TTL_SEC: z.preprocess((v) => Number(v) || 604800, z.number()).default(604800),
    CHAPTER_PENDING_TTL_SEC: z.preprocess((v) => Number(v) || 600, z.number()).default(600),
    CROSS_SOURCE_DEDUPE_TTL_SEC: z.preprocess((v) => Number(v) || 604800, z.number()).default(604800),
    RECENT_LIST_TTL_SEC: z.preprocess((v) => Number(v) || 604800, z.number()).default(604800),
    SCRAPER_LOOKBACK_HOURS: z.preprocess((v) => Number(v) || 24, z.number()).default(24),

    // Concurrency & Batching
    CHAPTER_DISPATCH_CONCURRENCY: z.preprocess((v) => Number(v) || 10, z.number()).default(10),
    DISPATCH_WRITE_TASK_BATCH: z.preprocess((v) => Number(v) || 50, z.number()).default(50),
    DISPATCH_MAX_ITEMS: z.preprocess((v) => Number(v) || 1000, z.number()).default(1000),
    ENQUEUED_EXPIRY_MS: z.preprocess((v) => Number(v) || 30000, z.number()).default(30000),

    // Logging & Stats (Optimized for free tier - reduced TTL)
    CRON_LOG_LIST_LIMIT: z.preprocess((v) => Number(v) || 100, z.number()).default(100),        // Was 300
    CRON_LOG_LIST_TTL: z.preprocess((v) => Number(v) || 259200, z.number()).default(259200),   // 3 days (was 14)
    // Scraper credentials (mandatory for realtime data)
    IKIRU_EMAIL: z.string().min(1),
    IKIRU_PASSWORD: z.string().min(1),


    // Scraper tuning
    SECONDARY_SOURCE_URL: z.string().url().default("https://api.shngm.io"),
    SECONDARY_DETAIL_WINDOW_HOURS: z.preprocess((v) => Number(v) || 2, z.number()).default(2),
    SECONDARY_DETAIL_THROTTLE_MS: z.preprocess((v) => Number(v) || 200, z.number()).default(200),
    IKIRU_EMPTY_PAGE_BREAK_STREAK: z.preprocess((v) => Number(v) || 1, z.number()).default(1),

    // Discord send rate-limiting
    DISCORD_SEND_MAX_CONCURRENT: z.preprocess((v) => Number(v) || 10, z.number()).default(10),
    DISCORD_SEND_MIN_TIME_MS: z.preprocess((v) => Number(v) || 50, z.number()).default(50),
    DISCORD_CHANNEL_CONCURRENCY: z.preprocess((v) => Number(v) || 10, z.number()).default(10),

    // Supabase (Required for Hybrid storage)
    SUPABASE_URL: z.string().url(),
    SUPABASE_KEY: z.string().min(1),
});

const isTest = process.env.NODE_ENV === "test" ||
    process.env.VITEST !== undefined ||
    (typeof process.argv !== "undefined" && process.argv.some(arg => arg.toLowerCase().includes("vitest") || arg.toLowerCase().includes("jest") || arg.toLowerCase().includes("mocha")));

// Inject dummy values in test mode to satisfy Zod validation
const envToParse = { ...process.env };
if (isTest) {
    envToParse.UPSTASH_REDIS_REST_URL = envToParse.UPSTASH_REDIS_REST_URL || "https://mock-redis.com";
    envToParse.UPSTASH_REDIS_REST_TOKEN = envToParse.UPSTASH_REDIS_REST_TOKEN || "mock-token";
    envToParse.DISCORD_BOT_TOKEN = envToParse.DISCORD_BOT_TOKEN || "mock-bot-token";
    envToParse.QSTASH_ENABLED = "false";
    envToParse.QSTASH_CURRENT_SIGNING_KEY = envToParse.QSTASH_CURRENT_SIGNING_KEY || "mock-key";
    envToParse.SUPABASE_URL = envToParse.SUPABASE_URL || "https://mock.supabase.co";
    envToParse.SUPABASE_KEY = envToParse.SUPABASE_KEY || "mock-supabase-key";
}

const parsed = envSchema.safeParse(envToParse);

if (!parsed.success && !isTest) {
    console.error("❌ Invalid environment variables:", JSON.stringify(parsed.error.format(), null, 2));
    throw new Error("Invalid environment variables");
}

// Build partial env from defaults for fallback (edge runtime safety)
const buildPartialEnv = () => {
    try {
        return envSchema.partial().parse(process.env);
    } catch {
        return {} as any;
    }
};

// Use Proxy in test mode for dynamic process.env modifications
export const env: any = isTest
    ? new Proxy({}, {
        get(_, prop: string) {
            const envToParse = { ...process.env };
            // Inject dummy values for tests if missing
            envToParse.UPSTASH_REDIS_REST_URL = envToParse.UPSTASH_REDIS_REST_URL || "https://mock-redis.com";
            envToParse.UPSTASH_REDIS_REST_TOKEN = envToParse.UPSTASH_REDIS_REST_TOKEN || "mock-token";
            envToParse.DISCORD_BOT_TOKEN = envToParse.DISCORD_BOT_TOKEN || "mock-bot-token";
            envToParse.SUPABASE_URL = envToParse.SUPABASE_URL || "https://mock.supabase.co";
            envToParse.SUPABASE_KEY = envToParse.SUPABASE_KEY || "mock-supabase-key";

            const p = envSchema.safeParse(envToParse);
            if (p.success) {
                return (p.data as any)[prop];
            }
            // Fallback for partial/invalid during tests
            try {
                return (envSchema.partial().parse(envToParse) as any)[prop];
            } catch {
                return (process.env as any)[prop];
            }
        }
    })
    : (parsed.data || buildPartialEnv());
