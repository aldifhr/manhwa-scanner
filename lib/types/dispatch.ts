/**
 * Dispatch system types for chapter notifications
 */

import type { RedisClient } from "./redis.js";
import type { ChapterItem, SourceHealth } from "./scraper.js";
import { ClaimStateSchema } from "../schemas.js";
import { z } from "zod";
import type { CronLogEntry, SendEmbedFn } from "./core.js";

/**
 * Meta information for a chapter being dispatched
 */
export interface DispatchChapterMeta {
  item: ChapterItem;
  key: string | null;
  duplicateKey: string | null;
}

/**
 * State of the dispatch queue preparation
 */
export interface DispatchQueueState {
  invalidCount: number;
  alreadySentCount: number;
  staleCount: number;
  unsentMeta: DispatchChapterMeta[];
  queuedMeta: DispatchChapterMeta[];
  alreadyStateBreakdown: {
    sent: number;
    pending: number;
    other: number;
    duplicateSent: number;
    duplicatePending: number;
    duplicateOther: number;
  };
  alreadyStateBySource: Record<string, number>;
  blockedSample: {
    source: string;
    title: string | null;
    chapter: string | null;
    reason: string;
  }[];
  duplicateCount: number;
  overLimitCount: number;
}

/**
 * Options for sending to channels with rate limiting
 */
export interface SendToChannelsOptions {
  sendFn: (item: unknown, channelId: string, redis: RedisClient, mentions?: string) => Promise<{ success: boolean }>;
  item: unknown;
  channelIds: string[];
  redis?: RedisClient | null;
  mentions?: string;
  concurrency?: number;
  onError?: ((err: unknown, channelId: string) => void | Promise<void>) | null;
}

// SendEmbedFn imported from core.ts to prevent circular dependency
export type { SendEmbedFn } from "./core.js";

/**
 * Options for dispatching chapters
 */
export interface DispatchChaptersOptions {
  redis: RedisClient;
  matched?: ChapterItem[];
  channelIds?: string[];
  sendEmbed: SendEmbedFn;
  sendEmbedsBatch?: (items: ChapterItem[], channelId: string, redis: RedisClient, mentions?: string) => Promise<{ success: boolean }>;
  nowIso?: string;
  chapterTtl?: number;
  pendingClaimTtl?: number;
  crossSourceDedupeTtl?: number;
  chapterConcurrency?: number;
  writeTaskBatch?: number;
  maxItems?: number;
  onDispatchSuccess?: ((item: ChapterItem) => unknown) | null;
  onChannelError?: ((err: unknown, channelId: string, item: ChapterItem) => void) | null;
  getSubscribersFn?: (title: string) => Promise<string[]>;
  buildSummaryLog?: (sentItems: ChapterItem[], failed: number, nowIso: string) => CronLogEntry | null;
  log?: (m: string) => void;
  warn?: (m: string) => void;
  appendLiveEvent?: ((r: RedisClient, e: { message: string; type: string }) => Promise<unknown>) | null;
  startTime?: number;
  deadlineMs?: number;
}

/**
 * Result of a link health check
 */
export interface LinkHealthResult {
  url: string;
  status: string | number;
  ok: boolean;
  message?: string;
}

/**
 * Options for building the next source health map
 */
export interface BuildNextSourceHealthMapOptions {
  sourceKeys?: string[];
  currentMap?: Record<string, SourceHealth>;
  sourceStates?: Record<string, { status: string; responseTime?: number | null; error?: string | null }>;
  nowIso?: string;
  failureThreshold?: number;
  cooldownSeconds?: number;
}

/**
 * Internal state tracking for a claimed chapter
 */
export type ClaimState = z.infer<typeof ClaimStateSchema>;
