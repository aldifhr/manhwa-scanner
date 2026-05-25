/**
 * Discord API types and command interfaces
 */

import { z } from "zod";
import {
  InteractionTokenSchema,
} from "../schemas.js";

/**
 * Discord Interaction payload fragment for identifying context
 */
export type InteractionToken = z.infer<typeof InteractionTokenSchema>;

/**
 * Discord Channel API response structure
 */
export interface DiscordChannel {
  id: string;
  name: string;
  type: number;
  guild_id?: string;
  parent_id?: string | null;
  position?: number;
  permission_overwrites?: unknown[];
  topic?: string | null;
  nsfw?: boolean;
  last_message_id?: string | null;
  bitrate?: number;
  user_limit?: number;
  rate_limit_per_user?: number;
  recipients?: unknown[];
  icon?: string | null;
  owner_id?: string;
  application_id?: string;
  managed?: boolean;
  last_pin_timestamp?: string | null;
  rtc_region?: string | null;
  video_quality_mode?: number;
  message_count?: number;
  member_count?: number;
  default_auto_archive_duration?: number;
  permissions?: string;
  flags?: number;
  total_message_sent?: number;
  available_tags?: unknown[];
  applied_tags?: string[];
  default_reaction_emoji?: { emoji_id: string | null; emoji_name: string | null } | null;
  default_thread_rate_limit_per_user?: number;
  default_sort_order?: number | null;
  default_forum_layout?: number;
}

/**
 * Error response from Discord API
 */
export interface DiscordApiError {
  message: string;
  code?: number;
  response?: {
    status?: number;
    statusText?: string;
    data?: unknown;
  };
}

/**
 * Options for fetching a Discord channel
 */
export interface FetchDiscordChannelOptions {
  channelId: string;
  botToken: string;
}

/**
 * Options for validating a Discord channel
 */
import type { RedisClient } from "./redis.js";

export interface ValidateDiscordChannelOptions {
  redis?: RedisClient | null;
  channelId: string;
  botToken: string;
  cacheSec?: number;
  writeCache?: boolean;
  onValid?: ((channel: DiscordChannel) => void | Promise<void>) | null;
  onInvalid?: ((err: Error | DiscordApiError) => void | Promise<void>) | null;
}

/**
 * Options for batch validating Discord channels
 */
export interface ValidateDiscordChannelsBatchOptions {
  redis?: RedisClient | null;
  channelIds: string[];
  botToken: string;
  cacheSec?: number;
  concurrency?: number;
}

/**
 * Notification mode for users
 */
export enum NotifyMode {
  FOLLOWS = "follows",
  ALL = "all",
  NONE = "none",
}

/**
 * Discord slash command option (from interaction payload)
 * NOTE: Using 'any' for value to maintain backward compatibility with existing code
 */
export interface CommandOption {
  name: string;
  value?: any;
}

/**
 * Discord slash command option with subcommand support
 * Used when command has subcommands (e.g., /follow add, /follow remove)
 */
export interface SubcommandOption extends CommandOption {
  options?: SubcommandOption[];
}

/**
 * Discord autocomplete interaction option
 * Used for autocomplete handlers with focused field
 */
export interface AutocompleteOption extends CommandOption {
  options?: AutocompleteOption[];
  focused?: boolean;
}

/**
 * Discord command option with type information
 * Used when type discrimination is needed
 */
export interface TypedCommandOption extends CommandOption {
  type?: number;
  options?: TypedCommandOption[];
}
