import { redis } from "../redis.js";
import { normalizeTitleKey } from "../domain.js";
import { arrayUnion } from "../utils.js";
import { getLogger } from "../logger.js";

const logger = getLogger({ scope: "notifications" });

export const NOTIFY_MODES = {
  FOLLOWS: "follows",
  ALL: "all",
  NONE: "none",
};

/**
 * Gets a user's notification mode.
 * Defaults to 'follows'.
 */
export async function getUserNotifyMode(userId) {
  const settingsJson = await redis.hget("users:settings", userId);
  if (!settingsJson) return NOTIFY_MODES.FOLLOWS;
  try {
    const settings =
      typeof settingsJson === "string"
        ? JSON.parse(settingsJson)
        : settingsJson;
    return settings.notify_mode || NOTIFY_MODES.FOLLOWS;
  } catch (err) {
    logger.warn({ userId, error: err.message }, "Failed to parse user settings");
    return NOTIFY_MODES.FOLLOWS;
  }
}

/**
 * Sets a user's notification mode.
 */
export async function setUserNotifyMode(userId, mode) {
  if (!Object.values(NOTIFY_MODES).includes(mode)) {
    throw new Error(`Invalid notify mode: ${mode}`);
  }

  const settingsJson = await redis.hget("users:settings", userId);
  let settings;
  try {
    settings =
      settingsJson && typeof settingsJson === "string"
        ? JSON.parse(settingsJson)
        : settingsJson || {};
  } catch (err) {
    logger.warn({ userId, error: err.message }, "Failed to parse settings");
    settings = {};
  }
  settings.notify_mode = mode;

  // Sequential operations to prevent race conditions
  await redis
    .hset("users:settings", { [userId]: JSON.stringify(settings) })
    .catch((err) => {
      logger.error({ userId, error: err.message }, "Failed to save settings");
    });

  await updateNotifyModeIndex(userId, mode);
}

/**
 * Get the set key for a user's followed manga.
 */
function userFollowSetKey(userId) {
  return `user:follows:set:${userId}`;
}

/**
 * Get the set key for a manga's subscribers.
 */
function mangaSubscriberSetKey(titleKey) {
  return `manga:subscribers:set:${titleKey}`;
}

/**
 * Get the set key for a manga's mutes.
 */
function mangaMuteSetKey(titleKey) {
  return `manga:mutes:set:${titleKey}`;
}

/**
 * Lazy Migration: Moves data from old JSON-in-Hash format to native Redis Sets.
 */
export async function migrateToSets(userId, titleKey = null) {
  const pipeline = redis.pipeline();
  let migrated = false;

  // 1. Migrate user's follows
  if (userId) {
    const oldFollowsJson = await redis.hget("users:follows", userId);
    if (oldFollowsJson) {
      try {
        const follows = typeof oldFollowsJson === "string" ? JSON.parse(oldFollowsJson) : oldFollowsJson;
        if (Array.isArray(follows) && follows.length > 0) {
          pipeline.sadd(userFollowSetKey(userId), ...follows);
          pipeline.hdel("users:follows", userId);
          migrated = true;
        } else {
          // Cleanup empty hash entries
          pipeline.hdel("users:follows", userId);
          migrated = true;
        }
      } catch (e) { /* ignore */ }
    }
  }

  // 2. Migrate manga's subscribers/mutes if titleKey is provided
  if (titleKey) {
    // Subscribers
    const oldSubsJson = await redis.hget("manga:subscribers", titleKey);
    if (oldSubsJson) {
      try {
        const subs = typeof oldSubsJson === "string" ? JSON.parse(oldSubsJson) : oldSubsJson;
        if (Array.isArray(subs) && subs.length > 0) {
          pipeline.sadd(mangaSubscriberSetKey(titleKey), ...subs);
          pipeline.hdel("manga:subscribers", titleKey);
          migrated = true;
        } else {
          pipeline.hdel("manga:subscribers", titleKey);
          migrated = true;
        }
      } catch (e) { /* ignore */ }
    }

    // Mutes
    const oldMutesJson = await redis.hget("manga:mutes", titleKey);
    if (oldMutesJson) {
      try {
        const mutes = typeof oldMutesJson === "string" ? JSON.parse(oldMutesJson) : oldMutesJson;
        if (Array.isArray(mutes) && mutes.length > 0) {
          pipeline.sadd(mangaMuteSetKey(titleKey), ...mutes);
          pipeline.hdel("manga:mutes", titleKey);
          migrated = true;
        } else {
          pipeline.hdel("manga:mutes", titleKey);
          migrated = true;
        }
      } catch (e) { /* ignore */ }
    }
  }

  if (migrated) {
    await pipeline.exec();
    logger.debug({ userId, titleKey }, "Migrated bookmarks to Redis Sets");
  }
}

/**
 * Fetches all manga keys being followed by a user.
 * Handles lazy migration automatically.
 */
export async function getUserFollowsMembers(userId) {
  if (!userId) return [];

  // Always trigger migration check to be safe
  await migrateToSets(userId);

  return await redis.smembers(userFollowSetKey(userId)) || [];
}

/**
 * Checks if a user is following a specific manga key.
 */
export async function isUserFollowing(userId, title) {
  const titleKey = normalizeTitleKey(title);
  if (!titleKey || !userId) return false;

  // Try Set first (fast path)
  let isFollowing = await redis.sismember(userFollowSetKey(userId), titleKey);

  // Fallback to migration check if not found in set
  if (!isFollowing) {
    await migrateToSets(userId, titleKey);
    isFollowing = await redis.sismember(userFollowSetKey(userId), titleKey);
  }

  return Boolean(isFollowing);
}

/**
 * Subscribes a user to a manga.
 */
export async function followManga(userId, title) {
  if (!userId) return;
  const titleKey = normalizeTitleKey(title);
  if (!titleKey) return;

  await migrateToSets(userId, titleKey);

  try {
    await Promise.all([
      redis.sadd(userFollowSetKey(userId), titleKey),
      redis.sadd(mangaSubscriberSetKey(titleKey), userId),
      redis.zincrby("manga:popularity_index", 1, titleKey),
    ]);
  } catch (err) {
    logger.error({ error: err.message }, "followManga failed");
  }
}

/**
 * Unsubscribes a user from a manga.
 */
export async function unfollowManga(userId, title) {
  if (!userId) return;
  const titleKey = normalizeTitleKey(title);
  if (!titleKey) return;

  await migrateToSets(userId, titleKey);

  try {
    await Promise.all([
      redis.srem(userFollowSetKey(userId), titleKey),
      redis.srem(mangaSubscriberSetKey(titleKey), userId),
      redis.zincrby("manga:popularity_index", -1, titleKey),
    ]);
  } catch (err) {
    logger.error({ error: err.message }, "unfollowManga failed");
  }
}

/**
 * Gets all user IDs to be notified for a specific title.
 * Combines explicit followers + users with 'all' mode.
 * Excludes users with 'none' mode and those who have muted the title.
 */
export async function getMangaSubscribers(title) {
  const titleKey = normalizeTitleKey(title);
  if (!titleKey) {
    logger.error("getMangaSubscribers: invalid title");
    return [];
  }

  try {
    // 1. Trigger migration check and get explicit subscribers
    await migrateToSets(null, titleKey);
    const explicitSubscribers = await redis.smembers(mangaSubscriberSetKey(titleKey));

    // 2. Get users with "all" mode enabled
    const allModeUsers = await redis.smembers("users:mode:all");

    const combined = new Set(
      arrayUnion(explicitSubscribers || [], allModeUsers || []),
    );

    // 3. Filter out muted users
    const mutes = await redis.smembers(mangaMuteSetKey(titleKey));
    if (mutes && mutes.length > 0) {
      for (const userId of mutes) {
        combined.delete(userId);
      }
    }

    return Array.from(combined);
  } catch (err) {
    logger.error({ error: err.message }, "getMangaSubscribers failed");
    return [];
  }
}

/**
 * Updates the global index for 'all' mode users.
 */
export async function updateNotifyModeIndex(userId, mode) {
  if (mode === NOTIFY_MODES.ALL) {
    await redis.sadd("users:mode:all", userId);
  } else {
    await redis.srem("users:mode:all", userId);
  }
}
