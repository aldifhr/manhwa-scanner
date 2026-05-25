import { ChapterItem, RedisClient, RedisPipeline } from "../../types.js";
import {
  DISPATCH_HISTORY_KEY,
  MANGA_LAST_UPDATES_KEY,
  RECENT_CHAPTERS_KEY,
} from "../../constants/redis.js";
import { addHexpireToPipeline } from "../../redis.js";
import { ATOMIC_DISPATCH_SCRIPT } from "../../redisScripts.js";
import {
  CLAIM_STATUS,
  RECENT_LIST_TTL_SEC,
  RECENT_LIST_MAX_SIZE,
} from "../../config.js";
import { scanAndCleanupExpired } from "./history.js";
import { getLogger } from "../../logger.js";

const logger = getLogger({ scope: "dispatch" });

export function addSuccessWriteCommandsToPipeline({
  pipeline,
  item,
  key,
  duplicateKey,
  titleKey,
  index,
  nowIso,
  chapterTtl,
  crossSourceDedupeTtl,
  redisClient,
}: {
  pipeline: RedisPipeline;
  item: ChapterItem;
  key: string;
  duplicateKey: string | null;
  titleKey: string;
  index: number;
  nowIso: string;
  chapterTtl: number;
  crossSourceDedupeTtl: number;
  redisClient: RedisClient;
}): void {
  const chapterTtlMs = chapterTtl * 1000;

  const historyPayload = JSON.stringify({
    s: CLAIM_STATUS.SENT,
    ca: nowIso,
    ea: nowIso,
    e: Date.now() + chapterTtlMs,
  });

  const recentPayload = JSON.stringify({
    t: item.title,
    c: item.chapter,
    u: item.url,
    cv: item.cover ?? null,
    s: item.source ?? "ikiru",
    ut: item.updatedTime ?? null,
    sa: nowIso,
    ea: nowIso,
    so: index,
    e: Date.now() + RECENT_LIST_TTL_SEC * 1000,
  });

  if (typeof pipeline.eval === "function") {
    const dupTtlMs = crossSourceDedupeTtl * 1000;
    const dupPayload = duplicateKey
      ? JSON.stringify({ s: CLAIM_STATUS.SENT, ca: nowIso, ea: nowIso, e: Date.now() + dupTtlMs })
      : "";

    pipeline.eval(
      ATOMIC_DISPATCH_SCRIPT,
      [DISPATCH_HISTORY_KEY, MANGA_LAST_UPDATES_KEY, RECENT_CHAPTERS_KEY],
      [
        key,
        titleKey,
        nowIso,
        historyPayload,
        recentPayload,
        String(chapterTtlMs),
        String(RECENT_LIST_MAX_SIZE),
        duplicateKey || "",
        dupPayload,
      ],
    );

    if (duplicateKey) {
      addHexpireToPipeline(pipeline, DISPATCH_HISTORY_KEY, duplicateKey, crossSourceDedupeTtl * 1000, redisClient);
    }
  } else {
    // Legacy fallback (non-atomic)
    pipeline.hset(DISPATCH_HISTORY_KEY, { [key]: historyPayload });
    addHexpireToPipeline(pipeline, DISPATCH_HISTORY_KEY, key, chapterTtlMs, redisClient);

    if (duplicateKey) {
      const dupTtlMs = crossSourceDedupeTtl * 1000;
      const dupPayload = JSON.stringify({
        s: CLAIM_STATUS.SENT,
        ca: nowIso,
        ea: nowIso,
        e: Date.now() + dupTtlMs,
      });
      pipeline.hset(DISPATCH_HISTORY_KEY, { [duplicateKey]: dupPayload });
      addHexpireToPipeline(pipeline, DISPATCH_HISTORY_KEY, duplicateKey, dupTtlMs, redisClient);
    }

    pipeline.hset(MANGA_LAST_UPDATES_KEY, { [titleKey]: nowIso });
    addHexpireToPipeline(pipeline, MANGA_LAST_UPDATES_KEY, titleKey, chapterTtlMs, redisClient);
    pipeline.zadd(RECENT_CHAPTERS_KEY, { score: Date.now(), member: recentPayload });
    pipeline.zremrangebyrank(RECENT_CHAPTERS_KEY, 0, -(RECENT_LIST_MAX_SIZE + 1));
  }
}

export async function cleanupRecentChapters(redisClient: RedisClient): Promise<void> {
  const now = Date.now();
  const maxEntries = 50;
  const expiryThreshold = now - RECENT_LIST_TTL_SEC * 1000;

  try {
    await redisClient.zremrangebyscore(RECENT_CHAPTERS_KEY, 0, expiryThreshold);
    const count = await redisClient.zcard(RECENT_CHAPTERS_KEY);
    if (count > maxEntries) {
      await redisClient.zremrangebyrank(RECENT_CHAPTERS_KEY, 0, count - maxEntries - 1);
    }
  } catch (err: unknown) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[cleanupRecentChapters] Error");
  }
}

export function fireAndForgetCleanup(redisClient: RedisClient): void {
  Promise.resolve()
    .then(async () => {
      const toDelete = await scanAndCleanupExpired(redisClient, Date.now());
      if (toDelete.length > 0) {
        await redisClient.hdel(DISPATCH_HISTORY_KEY, ...toDelete);
      }
    })
    .catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "fireAndForgetCleanup failed",
      );
    });
}
