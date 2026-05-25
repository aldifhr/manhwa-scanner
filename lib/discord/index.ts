/**
 * Discord module - notification and interaction handling
 * 
 * Domain-organized exports:
 * - formatting: Rating stars, synopsis truncation
 * - source: Source metadata and labeling
 * - interactions: Edit/follow-up interaction responses
 * - embed-builder: Rich chapter embeds
 * - messaging: Send single/channel messages
 * - batch: Multi-channel batch operations
 */

// Constants
export { BOT_TOKEN, APP_ID, ICON_BELL } from "./common.js";

// Formatting utilities
export {
  ratingStars,
  shortSynopsis,
  truncateTitle,
  normalizeChapterText,
} from "./formatting.js";

// Source metadata
export {
  SOURCE_META,
  statusBar,
  normalizeSourceLabel,
  sourceMeta,
  type SourceMeta,
} from "./source.js";

// Interactions
export {
  editInteractionResponse,
  createFollowUpMessage,
  editInteractionResponseWithComponents,
} from "./interactions.js";

// Embed building
export {
  buildToastContent,
  buildRichChapterEmbed,
  buildMangaPreviewEmbed,
  buildChapterComponents,
} from "./embed-builder.js";

// Messaging
export {
  sendDiscordEmbed,
  sendDiscordEmbedsChannelBatch,
} from "./messaging.js";

// Batch operations
export {
  sendDiscordEmbedsBatch,
  type BatchSendItem,
  type BatchSendResult,
  type BatchSendSummary,
} from "./batch.js";

// Rate limiting
export {
  discordLimiter,
  discordPriorityLimiter,
  withDiscordRateLimit,
} from "./rate-limiter.js";
