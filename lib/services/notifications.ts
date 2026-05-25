import { redis } from "../redis.js";
import {
  MANGA_SUBSCRIBERS_SET_PREFIX as SUBSCRIBERS_SET,
  MANGA_MUTES_SET_PREFIX as MUTES_SET,
  USER_SETTINGS_KEY,
  USER_FOLLOWS_SET_PREFIX,
  USER_ALL_MODE_SET_KEY,
  MANGA_POPULARITY_KEY,
} from "../constants/redis.js";
import { normalizeTitleKey } from "../domain.js";
import { arrayUnion, arrayUnique } from "../utils.js";
import { getLogger } from "../logger.js";
import { NotifyMode } from "../types.js";

const logger = getLogger({ scope: "notifications" });

// Re-export for backward compatibility
export { NotifyMode };

export const NOTIFY_MODES = {
  FOLLOWS: NotifyMode.FOLLOWS,
  ALL: NotifyMode.ALL,
  NONE: NotifyMode.NONE,
};

const userFollowSetKey = (userId: string) => `${USER_FOLLOWS_SET_PREFIX}${userId}`;
const ALL_MODE_SET = USER_ALL_MODE_SET_KEY;

// Internal helpers

async function getUserSettings(userId: string): Promise<any> {
  const json = await redis.hget(USER_SETTINGS_KEY, userId);
  if (!json) return {};
  try {
    return typeof json === "string" ? JSON.parse(json) : json;
  } catch (err) {
    logger.warn({ userId }, "Failed to parse user settings");
    return {};
  }
}

export async function getUserNotifyMode(userId: string): Promise<NotifyMode> {
  const settings = await getUserSettings(userId);
  return (settings.notify_mode as NotifyMode) || NotifyMode.FOLLOWS;
}

export async function setUserNotifyMode(userId: string, mode: NotifyMode): Promise<void> {
  if (!Object.values(NotifyMode).includes(mode)) {
    throw new Error(`Invalid notify mode: ${mode}`);
  }

  const settings = await getUserSettings(userId);
  settings.notify_mode = mode;

  await redis.hset(USER_SETTINGS_KEY, { [userId]: JSON.stringify(settings) });
  await updateNotifyModeIndex(userId, mode);
}

export async function getUserFollowsMembers(userId: string): Promise<string[]> {
  if (!userId) return [];
  const members = await redis.smembers(userFollowSetKey(userId));
  return (members as string[]) || [];
}

export async function isUserFollowing(userId: string, title: string): Promise<boolean> {
  const titleKey = normalizeTitleKey(title);
  if (!titleKey || !userId) return false;
  return Boolean(await redis.sismember(userFollowSetKey(userId), titleKey));
}

export async function followManga(userId: string, title: string): Promise<void> {
  if (!userId) return;
  const titleKey = normalizeTitleKey(title);
  if (!titleKey) return;

  try {
    await Promise.all([
      redis.sadd(userFollowSetKey(userId), titleKey),
      redis.sadd(`${SUBSCRIBERS_SET}${titleKey}`, userId),
      redis.zincrby(MANGA_POPULARITY_KEY, 1, titleKey),
    ]);
  } catch (err: unknown) {
    logger.error({ error: err instanceof Error ? err.message : String(err), titleKey }, "followManga failed");
  }
}

export async function unfollowManga(userId: string, title: string): Promise<void> {
  if (!userId) return;
  const titleKey = normalizeTitleKey(title);
  if (!titleKey) return;

  try {
    await Promise.all([
      redis.srem(userFollowSetKey(userId), titleKey),
      redis.srem(`${SUBSCRIBERS_SET}${titleKey}`, userId),
      redis.zincrby(MANGA_POPULARITY_KEY, -1, titleKey),
    ]);
  } catch (err: unknown) {
    logger.error({ error: err instanceof Error ? err.message : String(err), titleKey }, "unfollowManga failed");
  }
}

export async function muteManga(userId: string, title: string): Promise<void> {
  if (!userId) return;
  const titleKey = normalizeTitleKey(title);
  if (!titleKey) return;
  await redis.sadd(`${MUTES_SET}${titleKey}`, userId);
}

export async function unmuteManga(userId: string, title: string): Promise<void> {
  if (!userId) return;
  const titleKey = normalizeTitleKey(title);
  if (!titleKey) return;
  await redis.srem(`${MUTES_SET}${titleKey}`, userId);
}

export async function getMangaSubscribers(title: string): Promise<string[]> {
  const titleKey = normalizeTitleKey(title);
  if (!titleKey) return [];

  try {
    // 3-way fetch for notification dispatch
    const [nativeSubs, allModeUsers, nativeMutes] = await Promise.all([
      redis.smembers(`${SUBSCRIBERS_SET}${titleKey}`) as Promise<string[]>,
      redis.smembers(ALL_MODE_SET) as Promise<string[]>,
      redis.smembers(`${MUTES_SET}${titleKey}`) as Promise<string[]>,
    ]);

    const subscribers = arrayUnique(arrayUnion(nativeSubs, allModeUsers));
    const mutes = new Set(nativeMutes);

    return subscribers.filter(userId => !mutes.has(userId));
  } catch (err: unknown) {
    logger.error({ error: err instanceof Error ? err.message : String(err), titleKey }, "getMangaSubscribers failed");
    return [];
  }
}

export async function updateNotifyModeIndex(userId: string, mode: NotifyMode): Promise<void> {
  if (mode === NotifyMode.ALL) {
    await redis.sadd(ALL_MODE_SET, userId);
  } else {
    await redis.srem(ALL_MODE_SET, userId);
  }
}
