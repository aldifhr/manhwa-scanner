/**
 * Cron job and runtime types
 */

import { z } from "zod";
import {
  CronLogEntrySchema,
  CronStatusSchema,
  LifecycleStateSchema,
} from "../schemas.js";
import type { RedisClient } from "./redis.js";
import type { ChapterItem, SourceHealth, SourceState } from "./scraper.js";
import type { Logger, SendEmbedFn, CronLogEntry } from "./core.js";
import type { WhitelistEntry } from "./whitelist.js";

// CronLogEntry re-exported from core.ts to prevent circular dependency
export type { CronLogEntry } from "./core.js";

/**
 * Tracking the current execution step
 */
export type LifecycleState = z.infer<typeof LifecycleStateSchema>;

/**
 * Detailed status of a cron execution run
 */
export type CronStatus = z.infer<typeof CronStatusSchema>;

/**
 * Resolution for channel validation concurrency
 */
export interface ConcurrencyResolution {
  value: number;
  raw: string | number | undefined | null;
  reason: string | null;
}

/**
 * Options for running the cron job
 */
export interface RunCronJobOptions {
  redisClient?: RedisClient;
  logger?: Logger;
  loadWhitelistFn?: () => Promise<WhitelistEntry[]>;
  getAllGuildChannelsFn?: () => Promise<Record<string, string>>;
  scrapeMangaUpdatesWithMetaFn?: (
    redis: RedisClient | null,
    options?: OrchestrateOptions
  ) => Promise<{
    items: ChapterItem[];
    sourceStates: Record<string, SourceState>;
    nextSourceHealth?: Record<string, SourceHealth>;
    metrics?: { hibernatedCount: number; incrementalSaved: number; initialWhitelistSize: number };
  }>;
  sendEmbed?: (
    item: ChapterItem | DiscordEmbedData,
    channelId: string,
    redis: RedisClient | null,
    mentions?: string
  ) => Promise<{ success: boolean; status?: number; channelId?: string; error?: string } | undefined>;
  deleteGuildChannelFn?: (id: string) => Promise<unknown>;
  scrapeOptions?: {
    incremental?: boolean;
    deduplicate?: boolean;
    force?: boolean;
    fullRefresh?: boolean;
    skipExpansion?: boolean;
    fastSecondaryLimit?: number;
  };
  lifecycle?: LifecycleState;
  deadlineMs?: number;
}

/**
 * Data needed to build a Discord Embed for a chapter update
 */
export interface DiscordEmbedData extends ChapterItem {
  type?: "notification" | "report";
  sentAt?: string;
  enqueuedAt?: string;
  sentOrder?: number;
}

/**
 * Options for orchestrating scrape sources
 */
export interface OrchestrateOptions {
  lifecycle?: LifecycleState;
  startTime?: number;
  deadlineMs?: number;
  disabledSources?: string[];
  preferredIkiru?: { titles: string[]; urls: string[] };
  preferredIkiruTitles?: string[];
  preferredSecondaryTitles?: Record<string, string[]>;
  preferredSecondaryUrls?: Record<string, string[]>;
  preferredSecondaryEntries?: Record<string, { title: string; url: string }[]>;
  incremental?: boolean;
  force?: boolean;
  fullRefresh?: boolean;
  thresholdDays?: number;
  wakeProbability?: number;
  randomFn?: () => number;
  deduplicate?: boolean;
  deadline?: number;
  skipExpansion?: boolean;
  currentHealthMap?: Record<string, SourceHealth>;
  healthFailureThreshold?: number;
  healthCooldownSeconds?: number;
}
