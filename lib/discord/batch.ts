/**
 * Batch Discord operations with deduplication
 */

import pLimit from "p-limit";
import { BoundedInFlightMap } from "../utils/bounded-map.js";
import type { RedisClient, DiscordEmbedData } from "../types.js";
import { sendDiscordEmbed } from "./messaging.js";

// In-flight request tracking for Discord deduplication (bounded to prevent memory leaks)
const DISCORD_DEDUP_TTL_MS = 30000; // 30 seconds
const MAX_IN_FLIGHT_REQUESTS = 100; // Prevent unbounded memory growth
const inFlightDiscordSends = new BoundedInFlightMap<string, Promise<unknown>>({
  maxSize: MAX_IN_FLIGHT_REQUESTS,
  defaultTtlMs: DISCORD_DEDUP_TTL_MS,
});

function getDiscordDedupeKey(channelId: string, title: string, chapter: string): string {
  return `${channelId}:${title}:${chapter}`;
}

export interface BatchSendItem {
  data: DiscordEmbedData;
  channelId: string;
  mentions?: string;
}

export interface BatchSendResult {
  index: number;
  status: "sent" | "deduplicated" | "failed";
  channelId: string;
  title: string;
  chapter: string;
  delivery?: { success: boolean; status?: number; error?: string };
  error?: string;
}

export interface BatchSendSummary {
  successful: number;
  failed: number;
  deduplicated: number;
  total: number;
  results: BatchSendResult[];
}

/**
 * Send embeds to multiple channels with concurrency control and deduplication
 */
export async function sendDiscordEmbedsBatch(
  items: BatchSendItem[],
  options: {
    concurrency?: number;
    deduplicate?: boolean;
    redis?: RedisClient | null;
  } = {},
): Promise<BatchSendSummary> {
  if (!items || items.length === 0) {
    return { successful: 0, failed: 0, deduplicated: 0, total: 0, results: [] };
  }

  const concurrency = options.concurrency || 5;
  const deduplicate = options.deduplicate !== false;
  const redisClient = options.redis || null;
  const limit = pLimit(concurrency);

  const sendTasks = items.map((item, index) =>
    limit(async () => {
      const { data, channelId, mentions = "" } = item;
      const title = String(data?.title || "").trim();
      const chapter = String(data?.chapter || "").trim();

      if (deduplicate) {
        const dedupeKey = getDiscordDedupeKey(channelId, title, chapter);

        if (inFlightDiscordSends.has(dedupeKey)) {
          return {
            index,
            status: "deduplicated" as const,
            channelId,
            title,
            chapter,
          };
        }

        const promise = sendDiscordEmbed(
          data,
          channelId,
          redisClient,
          mentions,
        ).finally(() => {
          setTimeout(
            () => inFlightDiscordSends.delete(dedupeKey),
            DISCORD_DEDUP_TTL_MS,
          );
        });

        inFlightDiscordSends.set(dedupeKey, promise);
        const res = await promise;
        return {
          index,
          status: "sent" as const,
          channelId,
          title,
          chapter,
          delivery: res,
        };
      } else {
        const res = await sendDiscordEmbed(data, channelId, redisClient, mentions);
        return {
          index,
          status: "sent" as const,
          channelId,
          title,
          chapter,
          delivery: res,
        };
      }

    }).catch((err: Error) => ({
      index,
      status: "failed" as const,
      channelId: item.channelId,
      title: String(item.data?.title || ""),
      chapter: String(item.data?.chapter || ""),
      error: err?.message || "Unknown error",
    })),
  );

  const results = await Promise.all(sendTasks);

  const successful = results.filter((r) => r.status === "sent").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const deduplicated = results.filter(
    (r) => r.status === "deduplicated",
  ).length;

  return {
    successful,
    failed,
    deduplicated,
    total: items.length,
    results: results as BatchSendResult[],
  };
}
