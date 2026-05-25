/**
 * Type definitions for the manhwa-scrap-discord bot
 * Barrel export - domain types are split into separate files
 */

// Re-export schema-derived types from schemas.ts for convenience
export {
  ChapterItemSchema,
  WhitelistSourceSchema,
  WhitelistEntrySchema,
  CronLogEntrySchema,
  ScraperMetricsSchema,
  SourceHealthSchema,
  SourceStateSchema,
  TimingMetricsSchema,
  SkipBreakdownSchema,
  CronStatusSchema,
  NotificationTaskSchema,
  ClaimStateSchema,
  LifecycleStateSchema,
  MangaMetadataSchema,
  ProviderErrorSchema,
  ProviderErrorCodeSchema,
  InteractionTokenSchema,
  SecondaryMangaRowSchema,
  SecondaryApiResponseSchema,
} from "../schemas.js";

// Redis types
export type {
  RedisValue,
  RedisHashFieldValue,
  RedisSetOptions,
  RedisZRangeOptions,
  RedisScanOptions,
  RedisPipeline,
  RedisClient,
} from "./redis.js";

// Discord types
export type {
  InteractionToken,
  DiscordChannel,
  DiscordApiError,
  FetchDiscordChannelOptions,
  ValidateDiscordChannelOptions,
  ValidateDiscordChannelsBatchOptions,
  CommandOption,
  SubcommandOption,
  AutocompleteOption,
  TypedCommandOption,
} from "./discord.js";
export { NotifyMode } from "./discord.js";

// Scraper types
export type {
  ChapterItem,
  ScraperMetrics,
  SourceState,
  SourceHealth,
  SecondaryMangaRow,
  SecondaryApiResponse,
  ProviderErrorCode,
  ProviderError,
  MangaMetadata,
  TimingMetrics,
  SkipBreakdown,
  ProviderResult,
  RetryOptions,
  HttpScrapeOptions,
  PreferenceScrapeOptions,
  ScraperProvider,
} from "./scraper.js";

// Cron types
export type {
  LifecycleState,
  CronStatus,
  ConcurrencyResolution,
  RunCronJobOptions,
  DiscordEmbedData,
  OrchestrateOptions,
} from "./cron.js";
// CronLogEntry exported from core.ts to prevent circular dependency

// Dispatch types
export type {
  DispatchChapterMeta,
  DispatchQueueState,
  SendToChannelsOptions,
  DispatchChaptersOptions,
  LinkHealthResult,
  BuildNextSourceHealthMapOptions,
  ClaimState,
} from "./dispatch.js";
// SendEmbedFn exported from core.ts to prevent circular dependency

// Whitelist types
export type {
  WhitelistSource,
  WhitelistEntry,
  NotificationTask,
} from "./whitelist.js";

// Core types (Logger, etc.)
export type {
  Logger,
  LoggerOptions,
  PrepareAuthorizedGetOptions,
  CronLogEntry,
  SendEmbedFn,
} from "./core.js";

// Re-export AdaptiveRateLimiter from its source
export { AdaptiveRateLimiter } from "../utils/adaptive-rate-limiter.js";
