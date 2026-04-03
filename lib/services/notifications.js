import { redis } from "../redis.js";
import { normalizeTitleKey } from "../domain.js";

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
  const mode = await redis.hget(`user:settings:${userId}`, "notify_mode");
  return mode || NOTIFY_MODES.FOLLOWS;
}

/**
 * Sets a user's notification mode.
 */
export async function setUserNotifyMode(userId, mode) {
  if (!Object.values(NOTIFY_MODES).includes(mode)) {
    throw new Error(`Invalid notify mode: ${mode}`);
  }
  await redis.hset(`user:settings:${userId}`, { notify_mode: mode });
}

/**
 * Checks if a user is following a specific manga key.
 */
export async function isUserFollowing(userId, titleKey) {
  return await redis.sismember(`user:follows:${userId}`, titleKey);
}

/**
 * Subscribes a user to a manga.
 */
export async function followManga(userId, title) {
  const titleKey = normalizeTitleKey(title);
  if (!titleKey) return;

  await Promise.all([
    redis.sadd(`user:follows:${userId}`, titleKey),
    redis.sadd(`manga:subscribers:${titleKey}`, userId),
    redis.zincrby("manga:popularity_index", 1, titleKey)
  ]);
}

/**
 * Unsubscribes a user from a manga.
 */
export async function unfollowManga(userId, title) {
  const titleKey = normalizeTitleKey(title);
  if (!titleKey) return;

  await Promise.all([
    redis.srem(`user:follows:${userId}`, titleKey),
    redis.srem(`manga:subscribers:${titleKey}`, userId),
    redis.zincrby("manga:popularity_index", -1, titleKey)
  ]);
}

/**
 * Gets all user IDs to be notified for a specific title.
 * Combines explicit followers + users with 'all' mode.
 * Excludes users with 'none' mode and those who have muted the title.
 */
export async function getMangaSubscribers(title) {
  const titleKey = normalizeTitleKey(title);
  if (!titleKey) return [];

  // 1. Get explicit subscribers
  const explicitSubscribers = await redis.smembers(`manga:subscribers:${titleKey}`);
  
  // 2. We also need to find users who have "all" mode enabled.
  // Note: Finding all users with "all" mode is tricky without a separate index.
  // We'll create an index for 'all' mode users to make this efficient.
  const allModeUsers = await redis.smembers("users:mode:all");

  const combined = new Set([...(explicitSubscribers || []), ...(allModeUsers || [])]);

  // 3. Filter out mutes? (Implementation detail: if they are in 'all' mode but muted this title)
  const mutes = await redis.smembers(`manga:mutes:${titleKey}`);
  if (mutes && mutes.length > 0) {
    for (const userId of mutes) {
      combined.delete(userId);
    }
  }

  return Array.from(combined);
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
