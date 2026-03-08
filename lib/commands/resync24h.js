import { waitUntil } from "@vercel/functions";
import { InteractionResponseType } from "discord-interactions";
import { isOwner } from "../permissions.js";
import {
  getAllGuildChannels,
  loadWhitelist,
  redis,
} from "../redis.js";
import { editInteractionResponse, sendDiscordEmbed } from "../discord.js";
import { scrapeMangaUpdates } from "../scraper.js";

const CHAPTER_TTL = 60 * 60 * 24 * 3;
const LOCK_KEY = "job:resync24h:lock";
const LOCK_TTL_SEC = 60 * 10;
const SEND_CONCURRENCY = 3;
const DEFAULT_MAX_SEND = 30;

function normalizeTitle(str = "") {
  return String(str)
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUrl(u = "") {
  const normalized = String(u).replace(/\/+$/, "").toLowerCase().trim();
  return normalized
    .replace(/^https?:\/\/(?:www\.)?shngm\.id\b/, "https://a.shinigami.asia")
    .replace(/^https?:\/\/(?:www\.)?shinigami\.asia\b/, "https://a.shinigami.asia");
}

function normalizeSource(source = "") {
  const s = String(source).toLowerCase().trim();
  if (s === "mirror" || s === "shinigami_mirror") return "shinigami_mirror";
  if (s === "shinigami" || s === "project" || s === "shinigami_project") {
    return "shinigami_project";
  }
  return "ikiru";
}

function createWhitelistMatcher(whitelist) {
  const prepared = whitelist.map((entry) => ({
    hasUrl: Boolean(entry.url),
    url: entry.url ? normalizeUrl(entry.url) : null,
    title: entry.title ? normalizeTitle(entry.title) : null,
    source: normalizeSource(entry.source),
  }));

  return (item) => {
    const itemUrl = item.mangaUrl ? normalizeUrl(item.mangaUrl) : null;
    const itemTitle = item.title ? normalizeTitle(item.title) : null;
    const itemSource = normalizeSource(item.source);

    return prepared.some((entry) => {
      if (entry.source && itemSource !== entry.source) return false;
      if (entry.hasUrl) return Boolean(itemUrl) && itemUrl === entry.url;
      if (!entry.title || !itemTitle) return false;
      return (
        itemTitle === entry.title ||
        itemTitle.includes(entry.title) ||
        entry.title.includes(itemTitle)
      );
    });
  };
}

async function sendToChannels(item, channelIds) {
  let success = 0;
  let failed = 0;

  for (let i = 0; i < channelIds.length; i += SEND_CONCURRENCY) {
    const batch = channelIds.slice(i, i + SEND_CONCURRENCY);
    await Promise.all(
      batch.map(async (channelId) => {
        try {
          await sendDiscordEmbed(item, channelId, redis);
          success++;
        } catch {
          failed++;
        }
      }),
    );
  }

  return { success, failed };
}

function getOption(options, name) {
  return options?.find((o) => o.name === name)?.value;
}

export default function handleResync24h(payload, options, res) {
  if (!isOwner(payload)) {
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: "Command ini hanya untuk owner bot.",
        flags: 64,
      },
    });
  }

  const dryRun = Boolean(getOption(options, "dry_run"));
  const rawMaxSend = Number(getOption(options, "max_send"));
  const maxSend = Number.isFinite(rawMaxSend) && rawMaxSend > 0
    ? Math.floor(rawMaxSend)
    : DEFAULT_MAX_SEND;
  res.json({ type: 5, data: { flags: 64 } });

  waitUntil((async () => {
    const lockPayload = {
      by: payload.member?.user?.id ?? payload.user?.id ?? "unknown",
      at: new Date().toISOString(),
    };
    const claimedLock = await redis.set(LOCK_KEY, lockPayload, {
      nx: true,
      ex: LOCK_TTL_SEC,
    });

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
        const normalized = normalizeUrl(item.url);
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
      const writeTasks = [];
      const WRITE_TASK_BATCH = 24;
      const flushWriteTasks = async () => {
        if (!writeTasks.length) return;
        await Promise.all(writeTasks.splice(0, writeTasks.length));
      };

      for (const item of toProcess) {
        const normalizedChapterUrl = normalizeUrl(item.url);
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
          redis.lpush("cron:logs", {
            time: nowIso,
            message: `[resync24h] ${item.title} - ${item.chapter}`,
            title: item.title,
            chapter: item.chapter,
            tag: "sent",
          }),
        );
        if (writeTasks.length >= WRITE_TASK_BATCH) {
          await flushWriteTasks();
        }

        sent++;
      }

      await flushWriteTasks();

      skipped += matched.length - validMeta.length;
      skipped += validMeta.length - unsent.length;
      skipped += Math.max(0, unsent.length - toProcess.length);

      await Promise.all([
        redis.ltrim("recent:chapters", 0, 99),
        redis.expire("recent:chapters", 60 * 60 * 24 * 14),
        redis.ltrim("cron:logs", 0, 499),
        redis.expire("cron:logs", 60 * 60 * 24 * 30),
      ]);

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
      await editInteractionResponse(payload, `Resync24h gagal: ${err.message}`);
    } finally {
      await redis.del(LOCK_KEY).catch(() => {});
    }
  })());
}
