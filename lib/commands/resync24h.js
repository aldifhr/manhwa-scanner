import { waitUntil } from "@vercel/functions";
import { InteractionResponseType } from "discord-interactions";
import { isOwner } from "../permissions.js";
import { redis } from "../redis.js";
import { editInteractionResponse, sendDiscordEmbed } from "../discord.js";
import { scrapeMangaUpdates } from "../scraper.js";
import {
  dispatchChapters,
  prepareDispatchQueue,
} from "../services/dispatch.js";
import { loadMatchedDispatchContext } from "../services/commandDispatchFlow.js";
import { checkStaleMangas } from "../services/staleChecker.js";
import { loadWhitelist } from "../redis.js";
import { getLogger } from "../logger.js";
import {
  CHAPTER_TTL_SEC,
  RESYNC_DEFAULT_MAX_SEND,
  RESYNC_LOCK_TTL_SEC,
} from "../runtimeConfig.js";
import { normalizeSource, normalizeSourceUrl } from "../domain/source.js";
import { getChapterNumber, normalizeTitleKey } from "../domain/manga.js";
import { buildScrapeOptions } from "../services/scrapePreferences.js";

const LOCK_KEY = "job:resync24h:lock";
const logger = getLogger({ scope: "resync24h" });

function getOption(options, name) {
  return options?.find((o) => o.name === name)?.value;
}

function buildResyncGroupKey(item) {
  const source = normalizeSource(item?.source);
  const normalizedMangaUrl = normalizeSourceUrl(item?.mangaUrl || "");
  if (normalizedMangaUrl) return `${source}::${normalizedMangaUrl}`;
  return `${source}::${normalizeTitleKey(item?.title || "")}`;
}

export function sortResyncMatchedChapters(items = []) {
  const grouped = new Map();

  for (const item of items) {
    const key = buildResyncGroupKey(item);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  }

  return [...grouped.values()].flatMap((group) =>
    [...group].sort((a, b) => {
      const chapterDelta = getChapterNumber(a.chapter) - getChapterNumber(b.chapter);
      if (chapterDelta !== 0) return chapterDelta;

      const updatedA = new Date(a?.updatedTime).getTime();
      const updatedB = new Date(b?.updatedTime).getTime();
      if (!Number.isNaN(updatedA) && !Number.isNaN(updatedB) && updatedA !== updatedB) {
        return updatedA - updatedB;
      }

      return String(a?.chapter || "").localeCompare(
        String(b?.chapter || ""),
        undefined,
        { numeric: true },
      );
    }),
  );
}

export default function handleResync24h(payload, options, res) {
  if (!isOwner(payload)) {
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "Command ini hanya untuk owner bot.", flags: 64 },
    });
  }

  const dryRun = Boolean(getOption(options, "dry_run"));
  const rawMaxSend = Number(getOption(options, "max_send"));
  const maxSend = Number.isFinite(rawMaxSend) && rawMaxSend > 0
    ? Math.floor(rawMaxSend)
    : RESYNC_DEFAULT_MAX_SEND;

  res.json({ type: 5, data: { flags: 64 } });

  waitUntil(
    (async () => {
      const lockPayload = {
        by: payload.member?.user?.id ?? payload.user?.id ?? "unknown",
        at: new Date().toISOString(),
      };
      const claimedLock = await redis.set(LOCK_KEY, lockPayload, { nx: true, ex: RESYNC_LOCK_TTL_SEC });

      if (!claimedLock) {
        await editInteractionResponse(
          payload,
          "Resync24h sedang berjalan. Tunggu beberapa menit lalu coba lagi.",
        );
        return;
      }

      try {
        const context = await loadMatchedDispatchContext({
          scrapeUpdates: (whitelist) => scrapeMangaUpdates(redis, buildScrapeOptions(whitelist)),
          prioritizeChannels: true,
        });

        if (context.status === "no_channels") {
          await editInteractionResponse(payload, "Tidak ada notification channel aktif.");
          return;
        }
        if (context.status === "empty_whitelist") {
          await editInteractionResponse(payload, "Whitelist kosong. Tidak ada yang di-resync.");
          return;
        }
        if (context.status === "no_matches") {
          await editInteractionResponse(payload, "Tidak ada chapter <24h yang cocok whitelist.");
          return;
        }

        const matchedSorted = sortResyncMatchedChapters(context.matched);
        const queueState = await prepareDispatchQueue(redis, matchedSorted, maxSend);

        if (dryRun) {
          await editInteractionResponse(
            payload,
            `Resync24h (dry-run)\n` +
              `matched: ${matchedSorted.length}\n` +
              `would_send: ${queueState.unsentMeta.length}\n` +
              `already_sent: ${queueState.alreadySentCount}\n` +
              `max_send: ${maxSend}\n` +
              `channels: ${context.channelIds.length}`,
          );
          return;
        }

        const { sent, skipped, failed, processed } = await dispatchChapters({
          redis,
          matched: matchedSorted,
          channelIds: context.channelIds,
          sendEmbed: sendDiscordEmbed,
          chapterTtl: CHAPTER_TTL_SEC,
          maxItems: maxSend,
          buildSummaryLog: (sentItems, failedCount) => {
            if (!sentItems.length && failedCount <= 0) return null;
            return {
              time: new Date().toISOString(),
              message: `[resync24h] sent ${sentItems.length} chapter(s)${
                failedCount > 0 ? ` | failed=${failedCount}` : ""
              }`,
              tag: failedCount > 0 ? "partial" : "sent",
              code: failedCount > 0 ? "resync_partial" : "resync_sent",
              type: "delivery_summary",
              source: "resync24h",
              count: sentItems.length,
              failed: failedCount,
              titles: sentItems.slice(0, 10).map((item) => item.title).filter(Boolean),
            };
          },
          log: (msg) => logger.debug({ msg }, "dispatch"),
          warn: (msg) => logger.warn({ msg }, "dispatch"),
        });

        await editInteractionResponse(
          payload,
          `Resync24h selesai\n` +
            `matched: ${matchedSorted.length}\n` +
            `processed: ${processed}\n` +
            `sent: ${sent}\n` +
            `skipped: ${skipped}\n` +
            `failed: ${failed}\n` +
            `max_send: ${maxSend}\n` +
            `channels: ${context.channelIds.length}`,
        );

        // Cek manga stale (>30 hari tidak update), kirim ephemeral ke pemanggil command
        const whitelist = await loadWhitelist().catch(() => []);
        await checkStaleMangas(redis, whitelist, payload).catch(err =>
          logger.warn({ err: err.message }, "staleChecker failed")
        );
      } catch (err) {
        logger.error({ err: err.message }, "resync failed");
        await editInteractionResponse(payload, `Resync24h gagal: ${err.message}`);
      } finally {
        await redis.del(LOCK_KEY).catch(() => {});
      }
    })(),
  );
}
