import { waitUntil } from "@vercel/functions";
import { InteractionResponseType } from "discord-interactions";
import { isOwner } from "../permissions.js";
import { getAllGuildChannels, loadWhitelist, redis } from "../redis.js";
import { editInteractionResponse, sendDiscordEmbed } from "../discord.js";
import { scrapeMangaUpdates } from "../scraper.js";
import { createWhitelistMatcher } from "../domain/manga.js";
import { normalizeSourceUrl } from "../domain/source.js";
import {
  LOGS_API_CACHE_KEY,
  RECENT_API_CACHE_KEY,
  SOURCE_COMPARE_CACHE_KEY,
  invalidateDashboardCaches,
} from "../cacheKeys.js";
import { sendToChannelsLimited } from "../services/discordRateLimiter.js";
import { getLogger } from "../logger.js";

const CHAPTER_TTL = 60 * 60 * 24 * 3;
const LOCK_KEY = "job:resync24h:lock";
const LOCK_TTL_SEC = 60 * 10;
const DEFAULT_MAX_SEND = 30;
const logger = getLogger({ scope: "resync24h" });
const LOG_SUMMARY_SAMPLE_LIMIT = 3;

function buildResyncLogSummary(items = [], failed = 0) {
  if (!items.length && failed <= 0) return null;

  const sample = items
    .slice(0, LOG_SUMMARY_SAMPLE_LIMIT)
    .map((item) => `${item.title} ${item.chapter}`.trim())
    .filter(Boolean);
  const remainder = Math.max(0, items.length - sample.length);
  const detailText = sample.length
    ? `: ${sample.join(", ")}${remainder ? ` (+${remainder} lagi)` : ""}`
    : "";
  const failedText = failed > 0 ? ` | failed=${failed}` : "";

  return {
    time: new Date().toISOString(),
    message: `[resync24h] sent ${items.length} chapter(s)${failedText}${detailText}`,
    tag: failed > 0 ? "partial" : "sent",
    count: items.length,
    failed,
    titles: items.slice(0, 10).map((item) => item.title).filter(Boolean),
  };
}

async function sendToChannels(item, channelIds) {
  return sendToChannelsLimited({
    sendFn: sendDiscordEmbed,
    item,
    channelIds,
    redis,
    onError: (err, channelId) => {
      logger.warn({ err: err.message, channelId, title: item.title }, "send failed");
    },
  });
}

function getOption(options, name) {
  return options?.find((o) => o.name === name)?.value;
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
    : DEFAULT_MAX_SEND;

  res.json({ type: 5, data: { flags: 64 } });

  waitUntil(
    (async () => {
      const lockPayload = {
        by: payload.member?.user?.id ?? payload.user?.id ?? "unknown",
        at: new Date().toISOString(),
      };
      const claimedLock = await redis.set(LOCK_KEY, lockPayload, { nx: true, ex: LOCK_TTL_SEC });

      if (!claimedLock) {
        await editInteractionResponse(
          payload,
          "Resync24h sedang berjalan. Tunggu beberapa menit lalu coba lagi.",
        );
        return;
      }

      try {
        const [whitelist, allResults, guildChannels] = await Promise.all([
          loadWhitelist(),
          scrapeMangaUpdates(redis),
          getAllGuildChannels(),
        ]);

        const channelIds = Object.values(guildChannels || {});
        if (!channelIds.length) {
          await editInteractionResponse(payload, "Tidak ada notification channel aktif.");
          return;
        }

        if (!whitelist.length) {
          await editInteractionResponse(payload, "Whitelist kosong. Tidak ada yang di-resync.");
          return;
        }

        const isMatched = createWhitelistMatcher(whitelist);
        const matched = allResults.filter(isMatched);
        if (!matched.length) {
          await editInteractionResponse(payload, "Tidak ada chapter <24h yang cocok whitelist.");
          return;
        }

        const chapterMeta = matched.map((item) => {
          const normalized = normalizeSourceUrl(item.url);
          return { item, key: normalized ? `chapter:${normalized}` : null };
        });
        const validMeta = chapterMeta.filter((entry) => entry.key);
        const sentFlags = validMeta.length
          ? await redis.mget(...validMeta.map((entry) => entry.key))
          : [];
        const unsentMeta = validMeta.filter((_, i) => !sentFlags[i]);
        const unsent = unsentMeta.map((entry) => entry.item);
        const toProcess = unsent.slice(0, maxSend);

        if (dryRun) {
          await editInteractionResponse(
            payload,
            `Resync24h (dry-run)\n` +
              `matched: ${matched.length}\n` +
              `would_send: ${unsent.length}\n` +
              `already_sent: ${matched.length - unsent.length}\n` +
              `max_send: ${maxSend}\n` +
              `channels: ${channelIds.length}`,
          );
          return;
        }

        let sent = 0;
        let skipped = 0;
        let failed = 0;
        const sentItems = [];
        const writeTasks = [];
        const WRITE_TASK_BATCH = 24;
        const flushWriteTasks = async () => {
          if (!writeTasks.length) return;
          await Promise.all(writeTasks.splice(0, writeTasks.length));
        };

        for (const item of toProcess) {
          const normalizedChapterUrl = normalizeSourceUrl(item.url);
          if (!normalizedChapterUrl) {
            skipped++;
            continue;
          }

          const key = `chapter:${normalizedChapterUrl}`;
          const claimed = await redis.set(key, Date.now().toString(), {
            ex: CHAPTER_TTL,
            nx: true,
          });
          if (!claimed) {
            skipped++;
            continue;
          }

          const result = await sendToChannels(item, channelIds);
          failed += result.failed;

          if (result.success === 0) {
            await redis.del(key);
            continue;
          }

          const nowIso = new Date().toISOString();
          writeTasks.push(
            redis.lpush("recent:chapters", {
              title: item.title,
              chapter: item.chapter,
              url: item.url,
              cover: item.cover ?? null,
              source: item.source ?? "ikiru",
              updatedTime: item.updatedTime ?? null,
              sentAt: nowIso,
            }),
          );
          if (writeTasks.length >= WRITE_TASK_BATCH) {
            await flushWriteTasks();
          }

          sentItems.push(item);
          sent++;
        }

        await flushWriteTasks();

        const summaryLog = buildResyncLogSummary(sentItems, failed);
        if (summaryLog) {
          await redis.lpush("cron:logs", summaryLog);
        }

        skipped += matched.length - validMeta.length;
        skipped += validMeta.length - unsent.length;
        skipped += Math.max(0, unsent.length - toProcess.length);

        await Promise.all([
          redis.ltrim("recent:chapters", 0, 99),
          redis.expire("recent:chapters", 60 * 60 * 24 * 14),
          redis.ltrim("cron:logs", 0, 499),
          redis.expire("cron:logs", 60 * 60 * 24 * 30),
        ]);

        if (sentItems.length > 0 || summaryLog) {
          await invalidateDashboardCaches(redis, [
            RECENT_API_CACHE_KEY,
            LOGS_API_CACHE_KEY,
            SOURCE_COMPARE_CACHE_KEY,
          ]);
        }

        await editInteractionResponse(
          payload,
          `Resync24h selesai\n` +
            `matched: ${matched.length}\n` +
            `processed: ${toProcess.length}\n` +
            `sent: ${sent}\n` +
            `skipped: ${skipped}\n` +
            `failed: ${failed}\n` +
            `max_send: ${maxSend}\n` +
            `channels: ${channelIds.length}`,
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
