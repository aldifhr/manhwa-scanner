/**
 * Discord message sending for chapter notifications
 */

import { httpPost } from "../httpClient.js";
import { getLogger } from "../logger.js";
import { normalizeChapterIdentity, normalizeTitleKey } from "../domain.js";
import type { RedisClient, DiscordEmbedData } from "../types.js";
import { BOT_TOKEN } from "./common.js";
import { buildToastContent, buildRichChapterEmbed, buildChapterComponents } from "./embed-builder.js";

const logger = getLogger({ scope: "discord:messaging" });

/**
 * Send a single chapter embed to a Discord channel
 */
export async function sendDiscordEmbed(
  data: DiscordEmbedData,
  channelId: string,
  redis: RedisClient | null = null,
  mentions = "",
): Promise<{ success: boolean; status?: number; channelId?: string; error?: string; skipped?: boolean; reason?: string }> {
  const title = String(data.title || "Untitled").trim();
  const chapter = String(data.chapter || "Unknown").trim();
  const eventTimestamp = new Date().toISOString();

  // Dedupe check
  if (redis && typeof redis.set === "function") {
    const titleKey = normalizeTitleKey(title);
    const chapterKey = normalizeChapterIdentity(chapter);
    if (titleKey && chapterKey) {
      const dedupeKey = `discord:dedupe:${channelId}:${titleKey}:${chapterKey}`;
      try {
        const claimed = await redis.set(dedupeKey, Date.now().toString(), {
          nx: true,
          ex: 120,
        });
        if (claimed !== "OK") {
          logger.info(
            { channelId, title, chapter },
            "Skipped duplicate Discord embed (Redis dedupe)",
          );
          return { success: true, skipped: true, reason: "dedupe" };
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ err: message, dedupeKey }, "Discord dedupe guard failed, continuing send as safety fallback");
      }
    }
  }

  const toastContent = buildToastContent({ title, chapter, type: data.type });
  const finalContent = mentions ? `${mentions}\n${toastContent}` : toastContent;
  const embeds = [buildRichChapterEmbed(data, eventTimestamp)];
  const components = buildChapterComponents(title);

  if (!BOT_TOKEN) {
    logger.error({ channelId }, "DISCORD_BOT_TOKEN not configured");
    return { success: false, error: "Bot token not configured" };
  }

  try {
    await httpPost(
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      { content: finalContent, embeds, components },
      {
        headers: {
          Authorization: `Bot ${BOT_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: 10000,
      },
      { retries: 2, baseDelayMs: 500, maxDelayMs: 3000 },
    );
    logger.info({ title, chapter }, "[sendDiscordEmbed] Success with buttons");
    return { success: true, status: 200, channelId };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const axiosError = err as { response?: { status?: number } };
    const status = axiosError.response?.status;
    logger.error({ title, chapter, status, error: message }, "[sendDiscordEmbed] Failed");
    return { success: false, status, error: message };
  }
}

/**
 * Sends a batch of chapter updates to a single Discord channel in a single message.
 * Discord allows up to 10 embeds per message.
 */
export async function sendDiscordEmbedsChannelBatch(
  items: DiscordEmbedData[],
  channelId: string,
  redis: RedisClient | null = null,
  mentions = "",
): Promise<{ success: boolean; status?: number; channelId?: string; error?: string; count?: number }> {
  if (!items || items.length === 0) return { success: true, count: 0 };

  const eventTimestamp = new Date().toISOString();
  
  // 1. Prepare embeds and toasts
  const validEmbeds: unknown[] = [];
  const toasts: string[] = [];

  for (const data of items) {
    const title = String(data.title || "Untitled").trim();
    const chapter = String(data.chapter || "Unknown").trim();

    // Redis dedupe guard (secondary)
    if (redis && typeof redis.set === "function") {
      const titleKey = normalizeTitleKey(title);
      const chapterKey = normalizeChapterIdentity(chapter);
      if (titleKey && chapterKey) {
        const dedupeKey = `discord:dedupe:${channelId}:${titleKey}:${chapterKey}`;
        try {
          const claimed = await redis.set(dedupeKey, Date.now().toString(), { nx: true, ex: 120 });
          if (claimed !== "OK") {
            logger.debug({ channelId, title, chapter }, "Skipped duplicate in batch (Redis dedupe)");
            continue;
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn({ err: message, dedupeKey }, "Batch dedupe check failed, continuing with send");
        }
      }
    }

    validEmbeds.push(buildRichChapterEmbed(data, eventTimestamp));
    toasts.push(buildToastContent({ title, chapter, type: data.type }));
  }

  if (validEmbeds.length === 0) return { success: true, count: 0 };

  // 2. Build consolidated content
  let toastsContent = toasts.join("\n");
  if (toastsContent.length > 500) {
    toastsContent = toastsContent.substring(0, 497) + "...";
  }

  const finalContent = mentions ? `${mentions}\n${toastsContent}` : toastsContent;

  const firstItem = items[0];
  const isReport = firstItem?.type === "report";
  const firstTitle = String(firstItem?.title || "Untitled").trim();
  const components = isReport ? [] : buildChapterComponents(firstTitle);

  if (!BOT_TOKEN) {
    logger.error({ channelId }, "DISCORD_BOT_TOKEN not configured for batch");
    return { success: false, error: "Bot token not configured" };
  }

  try {
    await httpPost(
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      { content: finalContent, embeds: validEmbeds.slice(0, 10), components },
      {
        headers: { Authorization: `Bot ${BOT_TOKEN}`, "Content-Type": "application/json" },
        timeout: 10000,
      },
      { retries: 2, baseDelayMs: 500, maxDelayMs: 3000 },
    );
    logger.info({ channelId, count: validEmbeds.length }, "[sendDiscordEmbedsChannelBatch] Success with buttons");
    return { success: true, status: 200, channelId, count: validEmbeds.length };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const axiosError = err as { response?: { status?: number } };
    const status = axiosError.response?.status;
    logger.error({ err: message, status, channelId, batchSize: validEmbeds.length }, "[sendDiscordEmbedsChannelBatch] Failed");
    return { success: false, status, channelId, error: message };
  }
}
