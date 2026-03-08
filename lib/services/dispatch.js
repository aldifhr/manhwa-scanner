import { normalizeSourceUrl } from "../domain/source.js";
import { sendToChannelsLimited } from "./discordRateLimiter.js";

const DEFAULT_CHAPTER_TTL = 60 * 60 * 24 * 3;
const DEFAULT_WRITE_TASK_BATCH = 24;
const RECENT_LIST_TTL = 60 * 60 * 24 * 14;
const LOG_LIST_TTL = 60 * 60 * 24 * 30;

export async function dispatchChapters({
  redis,
  matched = [],
  channelIds = [],
  sendEmbed,
  nowIso = new Date().toISOString(),
  chapterTtl = DEFAULT_CHAPTER_TTL,
  writeTaskBatch = DEFAULT_WRITE_TASK_BATCH,
  onDispatchSuccess = null,
  log = () => {},
  warn = () => {},
} = {}) {
  if (!redis) throw new Error("dispatchChapters requires redis");
  if (typeof sendEmbed !== "function") {
    throw new Error("dispatchChapters requires sendEmbed function");
  }

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  const chapterMeta = matched.map((item) => {
    const normalizedChapterUrl = normalizeSourceUrl(item?.url);
    return {
      item,
      key: normalizedChapterUrl ? `chapter:${normalizedChapterUrl}` : null,
    };
  });
  const validChapterMeta = chapterMeta.filter((entry) => entry.key);

  const existingFlags = validChapterMeta.length
    ? await redis.mget(...validChapterMeta.map((entry) => entry.key))
    : [];
  const prefiltered = validChapterMeta.filter((_, i) => !existingFlags[i]);

  skipped += chapterMeta.length - validChapterMeta.length;
  skipped += validChapterMeta.length - prefiltered.length;

  const writeTasks = [];
  const flushWriteTasks = async () => {
    if (!writeTasks.length) return;
    await Promise.all(writeTasks.splice(0, writeTasks.length));
  };

  const queueWriteTask = (task) => {
    if (task && typeof task.then === "function") writeTasks.push(task);
  };

  for (const entry of prefiltered) {
    const { item, key } = entry;
    const claimed = await redis.set(key, Date.now().toString(), {
      ex: chapterTtl,
      nx: true,
    });

    if (!claimed) {
      log(`Skip (TTL): ${item.title} ${item.chapter}`);
      skipped++;
      continue;
    }

    const sendResult = await sendToChannelsLimited({
      sendFn: sendEmbed,
      item,
      channelIds,
      redis,
      onError: (err, channelId) => {
        warn(`Failed ${String(channelId).slice(-4)}: ${err.message}`);
      },
    });
    const success = sendResult.success > 0;
    failed += sendResult.failed;
    if (success) {
      log(`Sent chapter "${item.title}" to ${sendResult.success} channels`);
    }

    if (!success) {
      await redis.del(key);
      warn(`All guilds failed "${item.title}" - released`);
      continue;
    }

    queueWriteTask(
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
    queueWriteTask(
      redis.lpush("cron:logs", {
        time: nowIso,
        message: `${item.title} - ${item.chapter}`,
        title: item.title,
        chapter: item.chapter,
        tag: "sent",
      }),
    );

    if (typeof onDispatchSuccess === "function") {
      const extra = onDispatchSuccess(item);
      if (Array.isArray(extra)) {
        for (const task of extra) queueWriteTask(task);
      } else {
        queueWriteTask(extra);
      }
    }

    if (writeTasks.length >= writeTaskBatch) {
      await flushWriteTasks();
    }

    sent++;
  }

  await flushWriteTasks();

  await Promise.all([
    redis.ltrim("recent:chapters", 0, 99),
    redis.expire("recent:chapters", RECENT_LIST_TTL),
    redis.ltrim("cron:logs", 0, 499),
    redis.expire("cron:logs", LOG_LIST_TTL),
  ]);

  return { sent, skipped, failed };
}
