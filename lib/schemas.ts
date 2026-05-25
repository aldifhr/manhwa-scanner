import { z } from "zod";

/**
 * Validates the query parameters for the Cron API
 */
export const cronQuerySchema = z.object({
  action: z.enum(["update", "health", "links", "prefetch-metadata"]).default("update"),
  mode: z.enum(["normal", "full", "fast"]).optional(),
  incremental: z.enum(["0", "1", "false", "true"]).optional(),
  deduplicate: z.enum(["0", "1", "false", "true"]).optional(),
  fastLimit: z.string().optional(),
  forceUnlock: z.enum(["0", "1", "false", "true"]).optional(),
});

/**
 * Represents a single chapter update found by a scraper
 */
export const ChapterItemSchema = z.object({
  title: z.string().min(1, "Judul kosong"),
  chapter: z.string().min(1, "Text chapter kosong"),
  url: z.string().min(1, "URL Chapter kosong"),
  mangaUrl: z.string().nullable().optional(),
  mangaId: z.union([z.string(), z.number()]).nullable().optional(),
  source: z.string().min(1, "Source kosong"),
  updatedTime: z.string().nullable().optional(),
  canonicalTitle: z.string().optional(),
  status: z.string().nullable().optional(),
  rating: z.string().nullable().optional(),
  cover: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  titleKey: z.string().optional(),
  image: z.string().nullable().optional(),
  genres: z.array(z.string()).optional(),
  metadata: z.any().optional(),
});

/**
 * Standard classification for scraper errors
 */
export const ProviderErrorCodeSchema = z.enum([
  "RATE_LIMIT",
  "CLOUDFLARE_BLOCK",
  "AUTH_FAILURE",
  "TIMEOUT",
  "UPSTREAM_ERROR",
  "STRUCTURE_CHANGE",
  "BAD_URL",
  "UNKNOWN",
]);

/**
 * A source configuration within a whitelist entry
 */
export const WhitelistSourceSchema = z.object({
  url: z.string().nullable().optional(),
  source: z.string(),
  mark: z.string().nullable().optional(),
});

/**
 * An entry in the user's manga whitelist
 */
export const WhitelistEntrySchema = z.object({
  title: z.string(),
  titleCompact: z.string().optional(),
  sources: z.array(WhitelistSourceSchema),
  // Optional internal fields for optimization
  _normalizedTitle: z.string().optional(),
  _normalizedUrls: z.any().optional(), // Set<string> at runtime
});

/**
 * Normalized stats for cron execution logs
 */
export const CronLogEntrySchema = z.object({
  timestamp: z.string(),
  time: z.string().optional(),
  tag: z.string(),
  code: z.string().nullable().optional(),
  type: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  titles: z.array(z.string()).nullable().optional(),
  count: z.number().nullable().optional(),
  sent: z.number().nullable().optional(),
  skipped: z.number().nullable().optional(),
  failed: z.number().nullable().optional(),
  message: z.string(),
});

/**
 * Metrics collected during a scraper run
 */
export const ScraperMetricsSchema = z.object({
  detailAttempts: z.number().optional(),
  detailSuccesses: z.number().optional(),
  detailFallbacks: z.number().optional(),
  detail429: z.number().optional(),
  detailSkippedNonPriority: z.number().optional(),
  responseTime: z.number().optional(),
});

/**
 * Persistent health state for a single source
 */
export const SourceHealthSchema = z.object({
  source: z.string(),
  status: z.enum(["healthy", "degraded"]),
  consecutiveFailures: z.number(),
  disabledUntil: z.string().nullable(),
  lastError: z.string().nullable(),
  lastErrorCode: ProviderErrorCodeSchema.nullable().optional(),
  lastSuccessAt: z.string().nullable(),
  lastCheckedAt: z.string().nullable(),
  responseTime: z.number().nullable(),
  failuresToday: z.number().default(0),
  successesToday: z.number().default(0),
});

/**
 * Execution state of a single source during orchestration
 */
export const SourceStateSchema = z.object({
  status: z.string(),
  count: z.number(),
  error: z.string().nullable(),
  errCode: ProviderErrorCodeSchema.nullable().optional(),
  metrics: ScraperMetricsSchema.nullable(),
  responseTime: z.number().nullable().optional(),
});

/**
 * Detailed metrics for execution phases
 */
export const TimingMetricsSchema = z.object({
  loadInputsMs: z.number(),
  channelValidationMs: z.number(),
  scrapeMs: z.number(),
  sourceHealthWriteMs: z.number().optional(),
  matchFilterMs: z.number(),
  dispatchMs: z.number(),
  totalMs: z.number().optional(),
});

/**
 * Breakdown of why chapters were skipped
 */
export const SkipBreakdownSchema = z.object({
  invalid: z.number(),
  alreadySentOrPending: z.number(),
  duplicate: z.number(),
  overLimit: z.number(),
  runtimeClaimOrSend: z.number(),
  total: z.number(),
  alreadyStateBreakdown: z.object({
    sent: z.number(),
    pending: z.number(),
    other: z.number(),
    duplicateSent: z.number(),
    duplicatePending: z.number(),
    duplicateOther: z.number(),
  }).nullable().optional(),
  alreadyStateBySource: z.record(z.string(), z.number()).nullable().optional(),
  blockedSample: z.array(z.object({
    source: z.string(),
    title: z.string().nullable(),
    chapter: z.string().nullable(),
    reason: z.string(),
  })).nullable().optional(),
});

/**
 * Detailed status of a cron execution run
 */
export const CronStatusSchema = z.object({
  timestamp: z.union([z.string(), z.number()]).optional(),
  lastRun: z.string().nullable().optional(),
  sent: z.number().default(0),
  skipped: z.number().default(0),
  failed: z.number().default(0),
  duration: z.union([z.number(), z.string()]).nullable().optional(),
  outcome: z.string().optional(),
  guilds: z.number().optional(),
  whitelist: z.number().optional(),
  scraped: z.number().optional(),
  hibernated: z.number().optional(),
  incrementalSaved: z.number().optional(),
  error: z.string().optional(),
  shortCircuitReason: z.string().nullable().optional(),
  scrapeMetrics: z.record(z.string(), ScraperMetricsSchema.nullable()).nullable().optional(),
  sourceHealth: z.record(z.string(), SourceHealthSchema).nullable().optional(),
  timingMetrics: TimingMetricsSchema.nullable().optional(),
  enqueued: z.number().nullable().optional(),
  skipBreakdown: SkipBreakdownSchema.nullable().optional(),
  tag: z.string().optional(),
  message: z.string().optional(),
});

/**
 * A notification task ready to be enqueued
 */
export const NotificationTaskSchema = z.object({
  chapter: ChapterItemSchema,
  channelIds: z.array(z.string()),
  mentions: z.array(z.string()),
  primaryKey: z.string().nullable().optional(),
  duplicateKey: z.string().nullable().optional(),
  enqueuedAt: z.string().optional(),
});

/**
 * Internal state tracking for a claimed chapter
 */
export const ClaimStateSchema = z.object({
  status: z.enum(["pending", "enqueued", "sent"]).nullable(),
  claimedAt: z.string().nullable(),
  enqueuedAt: z.string().nullable().optional(),
  sentAt: z.string().nullable(),
  expiresAt: z.number().nullable(),
});

/**
 * Tracking the current execution step
 */
export const LifecycleStateSchema = z.object({
  currentStep: z.string(),
});

/**
 * Detailed metadata for a manga, cached in Redis
 */
export const MangaMetadataSchema = z.object({
  title: z.string(),
  source: z.string(),
  url: z.string(),
  cover: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  rating: z.string().nullable().optional(),
  lastUpdated: z.string(),
  chaptersCount: z.number().optional(),
  genres: z.array(z.string()).optional(),
  authors: z.array(z.string()).optional(),
  alternativeTitles: z.array(z.string()).optional(),
});


/**
 * Standardized error object for providers
 */
export const ProviderErrorSchema = z.object({
  message: z.string(),
  source: z.string(),
  code: z.string().optional(),
  errCode: ProviderErrorCodeSchema.optional(),
});

/**
 * Schema for raw manga data from secondary providers (Shinigami, etc.)
 */
export const SecondaryMangaRowSchema = z.object({
  manga_id: z.union([z.string(), z.number()]),
  title: z.string().optional(),
  direct_series_url: z.string().optional(),
  latest_chapter_id: z.union([z.string(), z.number()]).optional(),
  latest_chapter_number: z.union([z.string(), z.number()]).optional(),
  latest_chapter_time: z.string().optional(),
  updated_at: z.string().optional(),
  description: z.string().optional(),
  synopsis: z.string().optional(),
  user_rate: z.union([z.string(), z.number()]).optional(),
  taxonomy: z.object({
    Genre: z.array(z.object({ name: z.string() })).optional(),
  }).optional(),
  genres: z.array(z.object({ name: z.string() })).optional(),
  cover_portrait_url: z.string().optional(),
  cover_image_url: z.string().optional(),
  cover: z.string().optional(),
  image: z.string().optional(),
  status: z.union([z.string(), z.number()]).nullable().optional(),
  __directFallback: z.boolean().optional(),
}).passthrough();

/**
 * Generic envelope for secondary API responses
 */
export const SecondaryApiResponseSchema = z.object({
  data: z.any().optional(),
  result: z.any().optional(),
  items: z.any().optional(),
}).passthrough();

/**
 * Validation result for a single Discord channel
 */
export const ChannelValidationEntrySchema = z.object({
  valid: z.boolean(),
  expiresAt: z.number(),
});

/**
 * Global state for the channel validation process
 * Supports both old format (at, total, valid) and new format (lastRun, totalChannels, validCount, invalidCount)
 */
export const ChannelValidationStateSchema = z.union([
  // New format
  z.object({
    lastRun: z.string(),
    totalChannels: z.number(),
    validCount: z.number(),
    invalidCount: z.number(),
    durationMs: z.number().optional(),
  }),
  // Old format (legacy support)
  z.object({
    at: z.string(),
    total: z.number(),
    valid: z.number(),
    durationMs: z.number().optional(),
  }).transform((old) => ({
    lastRun: old.at,
    totalChannels: old.total,
    validCount: old.valid,
    invalidCount: old.total - old.valid,
    durationMs: old.durationMs,
  })),
]);

/**
 * Discord Interaction payload fragment for identifying context
 */
export const InteractionTokenSchema = z.object({
  token: z.string(),
  channel_id: z.string().optional(),
  application_id: z.string().optional(),
  user: z.object({ id: z.string() }).optional(),
  member: z.object({ user: z.object({ id: z.string() }) }).optional(),
});

