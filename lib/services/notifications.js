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

// Helpers for Hash-based Sets (JSON Arrays)
async function hsetAdd(key, field, value) {
  const jsonStr = await redis.hget(key, field);
  let arr;
  try {
    arr = typeof jsonStr === "string" ? JSON.parse(jsonStr) : jsonStr || [];
  } catch (err) {
    logger.warn({ key, field, error: err.message }, "Failed to parse hset data");
    arr = [];
  }
  if (!arr.includes(value)) {
    arr.push(value);
    await redis.hset(key, { [field]: JSON.stringify(arr) });
  }
}

async function hsetRem(key, field, value) {
  const jsonStr = await redis.hget(key, field);
  if (!jsonStr) return;
  let arr;
  try {
    arr = typeof jsonStr === "string" ? JSON.parse(jsonStr) : jsonStr;
  } catch (err) {
    logger.warn({ key, field, error: err.message }, "Failed to parse hset data");
    return;
  }
  const filtered = arr.filter((v) => v !== value);
  if (filtered.length > 0) {
    await redis.hset(key, { [field]: JSON.stringify(filtered) });
  } else {
    await redis.hdel(key, field);
  }
}

async function hsetMembers(key, field) {
  const jsonStr = await redis.hget(key, field);
  try {
    return typeof jsonStr === "string" ? JSON.parse(jsonStr) : jsonStr || [];
  } catch (err) {
    logger.warn({ key, field, error: err.message }, "Failed to parse hset data");
    return [];
  }
}

/**
 * Checks if a user is following a specific manga key.
 */
export async function isUserFollowing(userId, title) {
  const titleKey = normalizeTitleKey(title);
  if (!titleKey) return false;
  const follows = await hsetMembers("users:follows", userId);
  return follows.includes(titleKey);
}

/**
 * Subscribes a user to a manga.
 */
export async function followManga(userId, title) {
  if (!userId || typeof userId !== "string") {
    logger.error("followManga: invalid userId");
    return;
  }
  const titleKey = normalizeTitleKey(title);
  if (!titleKey) {
    logger.error("followManga: invalid title");
    return;
  }

  try {
    await Promise.all([
      hsetAdd("users:follows", userId, titleKey),
      hsetAdd("manga:subscribers", titleKey, userId),
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
  if (!userId || typeof userId !== "string") {
    logger.error("unfollowManga: invalid userId");
    return;
  }
  const titleKey = normalizeTitleKey(title);
  if (!titleKey) {
    logger.error("unfollowManga: invalid title");
    return;
  }

  try {
    await Promise.all([
      hsetRem("users:follows", userId, titleKey),
      hsetRem("manga:subscribers", titleKey, userId),
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
    // 1. Get explicit subscribers
    const explicitSubscribers = await hsetMembers(
      "manga:subscribers",
      titleKey,
    );

    // 2. Get users with "all" mode enabled
    const allModeUsers = await redis.smembers("users:mode:all");

    const combined = new Set(
      arrayUnion(explicitSubscribers || [], allModeUsers || []),
    );

    // 3. Filter out muted users
    const mutes = await hsetMembers("manga:mutes", titleKey);
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
