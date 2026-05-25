/**
 * Core shared types: Logger, Error, HTTP options
 */

/**
 * Structured logger interface for consistent logging
 * Mirrors pino's Logger interface for compatibility
 * Uses function overloads to support multiple calling patterns
 */
export interface Logger {
  level: string;
  fatal(msg: string): void;
  fatal(obj: Record<string, unknown>, msg?: string): void;
  error(msg: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
  warn(msg: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  info(msg: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
  debug(msg: string): void;
  debug(obj: Record<string, unknown>, msg?: string): void;
  trace(msg: string): void;
  trace(obj: Record<string, unknown>, msg?: string): void;
  child(bindings: Record<string, unknown>): Logger;
  // Allow additional properties for extensibility
  [key: string]: unknown;
}

/**
 * Logger options for extended logging
 */
export interface LoggerOptions extends Record<string, unknown> {
  scope?: string;
  module?: string;
}

/**
 * Options for preparing authorized GET requests
 */
export interface PrepareAuthorizedGetOptions {
  defaultCacheTtl?: number;
  maxAgeCap?: number;
  rawCacheTtl?: number | string | null;
}

// Shared types to prevent circular dependencies between cron.ts and dispatch.ts

import type { z } from "zod";
import type { CronLogEntrySchema } from "../schemas.js";
import type { ChapterItem } from "./scraper.js";
import type { RedisClient } from "./redis.js";

/**
 * Normalized stats for cron execution logs
 * Moved here to break circular dependency
 */
export type CronLogEntry = z.infer<typeof CronLogEntrySchema>;

/**
 * Function type for sending Discord embeds
 * Moved here to break circular dependency
 */
export type SendEmbedFn = (
  item: ChapterItem,
  channelId: string,
  redis: RedisClient,
  mentions?: string,
) => Promise<{ success: boolean }>;
