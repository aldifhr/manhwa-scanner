import { normalizeTitleKey } from "../domain.js";
import { arrayUnion, arrayUnique } from "../utils.js";
import { getLogger } from "../logger.js";
import { NotifyMode } from "../types.js";
import { supabase } from "../supabase.js";
import { redis } from "../redis.js";

const logger = getLogger({ scope: "notifications" });

export { NotifyMode };

export const NOTIFY_MODES = {
  FOLLOWS: NotifyMode.FOLLOWS,
  ALL: NotifyMode.ALL,
  NONE: NotifyMode.NONE,
};

export async function getUserNotifyMode(userId: string): Promise<NotifyMode> {
  const cacheKey = `user:notify_mode:${userId}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached) return cached as NotifyMode;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Failed to get user notify mode from Redis");
  }

  const { data } = await supabase.from("user_notify_settings").select("notify_mode").eq("user_id", userId).maybeSingle();
  const mode = (data?.notify_mode as NotifyMode) || NotifyMode.FOLLOWS;
  
  try {
    await redis.set(cacheKey, mode, { ex: 86400 });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Failed to set user notify mode in Redis");
  }
  return mode;
}

export async function setUserNotifyMode(userId: string, mode: NotifyMode): Promise<void> {
  if (!Object.values(NotifyMode).includes(mode)) {
    throw new Error(`Invalid notify mode: ${mode}`);
  }
  const { error } = await supabase.from("user_notify_settings").upsert(
    { user_id: userId, notify_mode: mode, settings_json: { notify_mode: mode } },
    { onConflict: "user_id" },
  );
  if (error) throw error;
  if (mode === NotifyMode.ALL) {
    await supabase.from("user_all_mode").upsert({ user_id: userId }, { onConflict: "user_id" });
  } else {
    await supabase.from("user_all_mode").delete().eq("user_id", userId);
  }

  // Update Redis cache
  try {
    const pipeline = redis.pipeline();
    pipeline.set(`user:notify_mode:${userId}`, mode, { ex: 86400 });
    if (mode === NotifyMode.ALL) {
      pipeline.sadd("users:mode:all", userId);
    } else {
      pipeline.srem("users:mode:all", userId);
    }
    await pipeline.exec();
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Failed to update notify mode cache in Redis");
  }
}

export async function getUserFollowsMembers(userId: string): Promise<string[]> {
  if (!userId) return [];
  const { data } = await supabase.from("user_follows").select("title_key").eq("user_id", userId);
  return (data || []).map((r) => r.title_key);
}

export async function isUserFollowing(userId: string, title: string): Promise<boolean> {
  const titleKey = normalizeTitleKey(title);
  if (!titleKey || !userId) return false;

  const cacheKey = `user:follows:set:${userId}`;
  try {
    const exists = await redis.exists(cacheKey);
    if (exists) {
      const isMember = await redis.sismember(cacheKey, titleKey);
      return !!isMember;
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Failed to check user follow cache in Redis");
  }

  const follows = await getUserFollowsMembers(userId);
  try {
    const pipeline = redis.pipeline();
    if (follows.length > 0) {
      pipeline.sadd(cacheKey, ...follows);
    } else {
      pipeline.sadd(cacheKey, "__empty__");
    }
    pipeline.expire(cacheKey, 86400);
    await pipeline.exec();
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Failed to populate user follow cache in Redis");
  }
  return follows.includes(titleKey);
}

export async function followManga(userId: string, title: string): Promise<void> {
  if (!userId) return;
  const titleKey = normalizeTitleKey(title);
  if (!titleKey) return;
  try {
    await supabase.from("user_follows").upsert(
      { user_id: userId, title_key: titleKey },
      { onConflict: "user_id,title_key" },
    );
    supabase.rpc("increment_popularity", { key: titleKey, delta: 1 }).then(undefined, (err: any) => {
      logger.warn({ err: err instanceof Error ? err.message : String(err), titleKey }, "increment_popularity failed");
    });

    // Update Redis caches
    try {
      const pipeline = redis.pipeline();
      pipeline.sadd(`user:follows:set:${userId}`, titleKey);
      pipeline.sadd(`manga:subscribers:set:${titleKey}`, userId);
      await pipeline.exec();
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Failed to update Redis caches on follow");
    }
  } catch (err: unknown) {
    logger.error({ error: err instanceof Error ? err.message : String(err), titleKey }, "followManga failed");
  }
}

export async function unfollowManga(userId: string, title: string): Promise<void> {
  if (!userId) return;
  const titleKey = normalizeTitleKey(title);
  if (!titleKey) return;
  try {
    await supabase.from("user_follows").delete().eq("user_id", userId).eq("title_key", titleKey);
    supabase.rpc("increment_popularity", { key: titleKey, delta: -1 }).then(undefined, (err: any) => {
      logger.warn({ err: err instanceof Error ? err.message : String(err), titleKey }, "increment_popularity failed");
    });

    // Update Redis caches
    try {
      const pipeline = redis.pipeline();
      pipeline.srem(`user:follows:set:${userId}`, titleKey);
      pipeline.srem(`manga:subscribers:set:${titleKey}`, userId);
      await pipeline.exec();
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Failed to update Redis caches on unfollow");
    }
  } catch (err: unknown) {
    logger.error({ error: err instanceof Error ? err.message : String(err), titleKey }, "unfollowManga failed");
  }
}

export async function muteManga(userId: string, title: string): Promise<void> {
  if (!userId) return;
  const titleKey = normalizeTitleKey(title);
  if (!titleKey) return;
  try {
    await supabase.from("manga_mutes").upsert(
      { user_id: userId, title_key: titleKey },
      { onConflict: "user_id,title_key" },
    );
    try {
      await redis.sadd(`manga:mutes:set:${titleKey}`, userId);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Failed to update mute cache");
    }
  } catch (err: unknown) {
    logger.error({ error: err instanceof Error ? err.message : String(err), titleKey }, "muteManga failed");
  }
}

export async function unmuteManga(userId: string, title: string): Promise<void> {
  if (!userId) return;
  const titleKey = normalizeTitleKey(title);
  if (!titleKey) return;
  try {
    await supabase.from("manga_mutes").delete().eq("user_id", userId).eq("title_key", titleKey);
    try {
      await redis.srem(`manga:mutes:set:${titleKey}`, userId);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Failed to update unmute cache");
    }
  } catch (err: unknown) {
    logger.error({ error: err instanceof Error ? err.message : String(err), titleKey }, "unmuteManga failed");
  }
}

export async function getMangaSubscribers(title: string): Promise<string[]> {
  const titleKey = normalizeTitleKey(title);
  if (!titleKey) return [];

  const subKey = `manga:subscribers:set:${titleKey}`;
  const muteKey = `manga:mutes:set:${titleKey}`;
  const allKey = "users:mode:all";

  try {
    const [subExists, muteExists, allExists] = await Promise.all([
      redis.exists(subKey),
      redis.exists(muteKey),
      redis.exists(allKey),
    ]);

    if (subExists && muteExists && allExists) {
      const [subs, mutes, allUsers] = await Promise.all([
        redis.smembers(subKey),
        redis.smembers(muteKey),
        redis.smembers(allKey),
      ]);
      const combined = arrayUnique(arrayUnion(
        subs.filter(x => x !== "__empty__"), 
        allUsers.filter(x => x !== "__empty__")
      ));
      const muteSet = new Set(mutes);
      return combined.filter(uid => !muteSet.has(uid));
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Failed to get manga subscribers from Redis cache");
  }

  try {
    const [followRows, allRows, muteRows] = await Promise.all([
      supabase.from("user_follows").select("user_id").eq("title_key", titleKey),
      supabase.from("user_all_mode").select("user_id"),
      supabase.from("manga_mutes").select("user_id").eq("title_key", titleKey),
    ]);

    const nativeSubs = (followRows.data || []).map((r) => r.user_id);
    const allModeUsers = (allRows.data || []).map((r) => r.user_id);
    const muteList = (muteRows.data || []).map((r) => r.user_id);

    try {
      const pipeline = redis.pipeline();
      if (nativeSubs.length > 0) pipeline.sadd(subKey, ...nativeSubs);
      else pipeline.sadd(subKey, "__empty__");
      pipeline.expire(subKey, 86400);

      if (muteList.length > 0) pipeline.sadd(muteKey, ...muteList);
      else pipeline.sadd(muteKey, "__empty__");
      pipeline.expire(muteKey, 86400);

      if (allModeUsers.length > 0) pipeline.sadd(allKey, ...allModeUsers);
      else pipeline.sadd(allKey, "__empty__");
      pipeline.expire(allKey, 86400);

      await pipeline.exec();
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Failed to backfill subscribers cache in Redis");
    }

    const subscribers = arrayUnique(arrayUnion(nativeSubs, allModeUsers));
    const mutes = new Set(muteList);
    return subscribers.filter((uid) => !mutes.has(uid));
  } catch (err: unknown) {
    logger.error({ error: err instanceof Error ? err.message : String(err), titleKey }, "getMangaSubscribers failed");
    return [];
  }
}
