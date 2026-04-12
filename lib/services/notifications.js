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

// ============ Storage constants ============
// Single Hash for all manga subscribers: field=titleKey, value=JSON array of userIds
const SUBSCRIBERS_HASH = "manga:subscribers";
// Single Hash for all manga mutes: field=titleKey, value=JSON array of userIds
const MUTES_HASH = "manga:mutes";
// Per-user follow set (kept as Set for fast sismember checks)
const userFollowSetKey = (userId) => `user:follows:set:${userId}`;
// Global set of users with 'all' mode
const ALL_MODE_SET = "users:mode:all";

// ============ Internal helpers ============

async function getHashJsonArray(hashKey, field) {
  try {
    const raw = await redis.hget(hashKey, field);
    if (!raw) return [];
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function setHashJsonArray(hashKey, field, arr) {
  if (!arr || arr.length === 0) {
    await redis.hdel(hashKey, field);
  } else {
    await redis.hset(hashKey, { [field]: JSON.stringify(arr) });
  }
}

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

  await redis
    .hset("users:settings", { [userId]: JSON.stringify(settings) })
    .catch((err) => {
      logger.error({ userId, error: err.message }, "Failed to save settings");
    });

  await updateNotifyModeIndex(userId, mode);
}

/**
 * Fetches all manga keys being followed by a user.
 */
export async function getUserFollowsMembers(userId) {
  if (!userId) return [];
  return await redis.smembers(userFollowSetKey(userId)) || [];
}

/**
 * Checks if a user is following a specific manga key.
 */
export async function isUserFollowing(userId, title) {
  const titleKey = normalizeTitleKey(title);
  if (!titleKey || !userId) return false;
  return Boolean(await redis.sismember(userFollowSetKey(userId), titleKey));
}

/**
 * Subscribes a user to a manga.
 */
export async function followManga(userId, title) {
  if (!userId) return;
  const titleKey = normalizeTitleKey(title);
  if (!titleKey) return;

  try {
    // Update user's follow set
    await redis.sadd(userFollowSetKey(userId), titleKey);

    // Update manga subscribers hash
    const subs = await getHashJsonArray(SUBSCRIBERS_HASH, titleKey);
    if (!subs.includes(userId)) {
      subs.push(userId);
      await setHashJsonArray(SUBSCRIBERS_HASH, titleKey, subs);
    }

    await redis.zincrby("manga:popularity_index", 1, titleKey);
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

  try {
    // Update user's follow set
    await redis.srem(userFollowSetKey(userId), titleKey);

    // Update manga subscribers hash
    const subs = await getHashJsonArray(SUBSCRIBERS_HASH, titleKey);
    const updated = subs.filter((id) => id !== userId);
    await setHashJsonArray(SUBSCRIBERS_HASH, titleKey, updated);

    await redis.zincrby("manga:popularity_index", -1, titleKey);
  } catch (err) {
    logger.error({ error: err.message }, "unfollowManga failed");
  }
}

/**
 * Mutes a manga for a user.
 */
export async function muteManga(userId, title) {
  if (!userId) return;
  const titleKey = normalizeTitleKey(title);
  if (!titleKey) return;

  const mutes = await getHashJsonArray(MUTES_HASH, titleKey);
  if (!mutes.includes(userId)) {
    mutes.push(userId);
    await setHashJsonArray(MUTES_HASH, titleKey, mutes);
  }
}

/**
 * Unmutes a manga for a user.
 */
export async function unmuteManga(userId, title) {
  if (!userId) return;
  const titleKey = normalizeTitleKey(title);
  if (!titleKey) return;

  const mutes = await getHashJsonArray(MUTES_HASH, titleKey);
  const updated = mutes.filter((id) => id !== userId);
  await setHashJsonArray(MUTES_HASH, titleKey, updated);
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
    // Fetch subscribers, muted users, and 'all mode' users in parallel
    const [explicitSubscribers, allModeUsers, mutes] = await Promise.all([
      getHashJsonArray(SUBSCRIBERS_HASH, titleKey),
      redis.smembers(ALL_MODE_SET),
      getHashJsonArray(MUTES_HASH, titleKey),
    ]);

    const combined = new Set(arrayUnion(explicitSubscribers || [], allModeUsers || []));

    // Filter out muted users
    for (const userId of mutes) {
      combined.delete(userId);
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
    await redis.sadd(ALL_MODE_SET, userId);
  } else {
    await redis.srem(ALL_MODE_SET, userId);
  }
}

/**
 * One-time migration: converts legacy Set-based keys to Hash format.
 * Run once via POST /api/health { action: "migrate_redis" }
 */
export async function migrateSubscribersToHash() {
  const results = { subscribers: 0, mutes: 0, errors: 0 };

  // Scan for old Set keys: manga:subscribers:set:* and manga:subscribers:*
  for (const pattern of [
    "manga:subscribers:set:*",
    "manga:subscribers:*",
    "manga:mutes:set:*",
    "manga:mutes:*",
  ]) {
    let cursor = "0";
    const isMute = pattern.includes("mutes");
    const targetHash = isMute ? MUTES_HASH : SUBSCRIBERS_HASH;
    const stripPrefixes = isMute
      ? ["manga:mutes:set:", "manga:mutes:"]
      : ["manga:subscribers:set:", "manga:subscribers:"];

    do {
      const [nextCursor, keys] = await redis.scan(cursor, {
        match: pattern,
        count: 100,
      });
      cursor = nextCursor;

      for (const key of keys || []) {
        // Skip if it IS the hash key itself
        if (key === SUBSCRIBERS_HASH || key === MUTES_HASH) continue;

        try {
          const type = await redis.type(key);
          if (type !== "set") continue;

          // Extract titleKey from the key name
          let titleKey = key;
          for (const prefix of stripPrefixes) {
            if (key.startsWith(prefix)) {
              titleKey = key.slice(prefix.length);
              break;
            }
          }

          const members = await redis.smembers(key);
          if (members && members.length > 0) {
            // Merge with existing hash data
            const existing = await getHashJsonArray(targetHash, titleKey);
            const merged = [...new Set([...existing, ...members])];
            await setHashJsonArray(targetHash, titleKey, merged);
          }

          await redis.del(key);
          isMute ? results.mutes++ : results.subscribers++;
        } catch (err) {
          logger.warn({ key, err: err.message }, "migrateSubscribersToHash: key error");
          results.errors++;
        }
      }
    } while (cursor !== "0");
  }

  return results;
}
