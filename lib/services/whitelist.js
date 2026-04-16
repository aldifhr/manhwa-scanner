import {
  loadWhitelist,
  redis,
  saveWhitelist,
  getAllGuildChannels,
  getWhitelistCount,
  MANGA_LAST_UPDATES_KEY,
  MANGA_SUBSCRIBERS_KEY,
  MANGA_MUTES_KEY,
} from "../redis.js";
import { fetchIkiruRecentChaptersFromLatestPage } from "../scrapers/ikiru.js";
import { dispatchChapters } from "./dispatch.js";
import { sendDiscordEmbed } from "../discord.js";
import {
  CHAPTER_TTL_SEC,
  DISCORD_COMPONENT_TYPE,
  DISCORD_BUTTON_STYLE,
} from "../config.js";
import {
  WHITELIST_API_CACHE_KEY,
  invalidateDashboardCaches,
} from "../cacheKeys.js";
import {
  inferSourceFromUrl,
  normalizeSource,
  normalizeSourceUrl,
  sourceLabel,
  MARK_REASON_LABELS,
  normalizeMarkReason,
  fuzzyTitleSimilarity,
  normalizeTitleKey,
} from "../domain.js";
import { getLogger } from "../logger.js";

const logger = getLogger({ scope: "whitelist" });

async function withWhitelistLock(
  redisClient,
  fn,
  { timeoutMs = 15000, ttlSec = 30 } = {},
) {
  const lockKey = "lock:whitelist_update";
  const start = Date.now();
  const clientId = Math.random().toString(36).slice(2);

  let acquired = false;

  while (Date.now() - start < timeoutMs) {
    const result = await redisClient.set(lockKey, clientId, { nx: true, ex: ttlSec });
    if (result) {
      acquired = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!acquired) {
    throw new Error("Gagal mendapatkan lock whitelist (Timeout). Silakan coba lagi.");
  }

  try {
    return await fn();
  } finally {
    const current = await redisClient.get(lockKey);
    if (current === clientId) {
      await redisClient.del(lockKey);
    }
  }
}

export function findWhitelistEntryIndex(items, { title, url = null } = {}) {
  const normalizedTitle = String(title || "").trim();
  const normalizedUrl = url ? normalizeSourceUrl(url) : null;
  if (!normalizedTitle && !normalizedUrl) return -1;

  return items.findIndex((item) => {
    if (
      normalizedTitle &&
      item.title?.toLowerCase() === normalizedTitle.toLowerCase()
    ) {
      return true;
    }

    if (
      normalizedUrl &&
      item.sources?.some((s) => normalizeSourceUrl(s.url || "") === normalizedUrl)
    ) {
      return true;
    }

    return false;
  });
}

export function resolveWhitelistQuery(items, query) {
  const normalizedQuery = String(query || "").trim();
  if (!normalizedQuery) throw new Error("Query required");

  const list = Array.isArray(items) ? items : [];
  let index = -1;

  const num = Number.parseInt(normalizedQuery, 10);
  if (Number.isInteger(num) && num >= 1 && num <= list.length) {
    index = num - 1;
  } else {
    const lower = normalizedQuery.toLowerCase();
    const exactMatches = list
      .map((item, itemIndex) => ({ item, index: itemIndex }))
      .filter(({ item }) => item.title.toLowerCase() === lower);

    if (exactMatches.length > 1) return { status: "ambiguous", matches: exactMatches };
    if (exactMatches.length === 1) {
      index = exactMatches[0].index;
    } else {
      const partialMatches = list
        .map((item, itemIndex) => ({ item, index: itemIndex }))
        .filter(({ item }) => item.title.toLowerCase().includes(lower));

      if (partialMatches.length > 1) return { status: "ambiguous", matches: partialMatches };
      if (partialMatches.length === 1) {
        index = partialMatches[0].index;
      } else {
        const fuzzyMatches = list
          .map((item, itemIndex) => ({
            item,
            index: itemIndex,
            score: fuzzyTitleSimilarity(item.title, lower),
          }))
          .filter((res) => res.score > 0.55)
          .sort((a, b) => b.score - a.score);

        if (fuzzyMatches.length > 1) {
          if (fuzzyMatches[0].score > fuzzyMatches[1].score + 0.1) {
            index = fuzzyMatches[0].index;
            return {
              status: "matched",
              index,
              item: list[index],
              suggested: true,
            };
          }
          return {
            status: "ambiguous",
            suggested: true,
            matches: fuzzyMatches
              .slice(0, 5)
              .map((fm) => ({ item: fm.item, index: fm.index })),
          };
        } else if (fuzzyMatches.length === 1) {
          index = fuzzyMatches[0].index;
          return {
            status: "matched",
            index,
            item: list[index],
            suggested: true,
          };
        }
      }
    }
  }

  if (index === -1) return { status: "not_found" };
  return { status: "matched", index, item: list[index] };
}

export function resolveWhitelistSource({ url = null, source = "ikiru" } = {}) {
  const normalizedSource = normalizeSource(source);
  const normalizedUrl = url ? normalizeSourceUrl(url) : null;
  const inferredSource = inferSourceFromUrl(normalizedUrl);

  if (inferredSource === "ikiru") return "ikiru";
  if (
    normalizedSource === "shinigami_project" ||
    normalizedSource === "shinigami_mirror"
  ) {
    return normalizedSource;
  }
  return inferredSource || normalizedSource;
}

async function persistWhitelistItems(
  items,
  { saveWhitelistFn = saveWhitelist, redisClient = redis } = {},
) {
  const saved = await saveWhitelistFn(items, redisClient);
  await invalidateDashboardCaches(redisClient, [WHITELIST_API_CACHE_KEY]);
  return saved;
}

export async function addWhitelistEntry(
  { title, url = null, source = "ikiru" },
  {
    loadWhitelistFn = loadWhitelist,
    saveWhitelistFn = saveWhitelist,
    redisClient = redis,
  } = {},
) {
  const normalizedTitle = String(title || "").trim();
  const normalizedUrl = url ? normalizeSourceUrl(url) : null;
  const effectiveSource = resolveWhitelistSource({
    url: normalizedUrl,
    source,
  });
  const titleKey = normalizeTitleKey(normalizedTitle);

  if (!normalizedTitle || !titleKey) {
    throw new Error("Title tidak valid.");
  }

  return withWhitelistLock(redisClient, async () => {
    const whitelist = await loadWhitelistFn(redisClient);

    const existingIndex = findWhitelistEntryIndex(whitelist, {
      title: normalizedTitle,
      url: normalizedUrl,
    });

    let fuzzyExisting = null;
    if (existingIndex === -1 && !normalizedUrl) {
      for (const item of whitelist) {
        if (fuzzyTitleSimilarity(item.title, normalizedTitle) >= 0.8) {
          fuzzyExisting = item;
          break;
        }
      }
    }

    const activeIndex =
      existingIndex !== -1
        ? existingIndex
        : fuzzyExisting
          ? whitelist.indexOf(fuzzyExisting)
          : -1;

    if (activeIndex !== -1) {
      const existing = whitelist[activeIndex];
      const hasSource = existing.sources?.some(
        (s) =>
          normalizeSource(s.source) === effectiveSource &&
          (!normalizedUrl || normalizeSourceUrl(s.url || "") === normalizedUrl),
      );

      if (hasSource) {
        const finalWhitelist = await loadWhitelistFn(redisClient);
        return {
          status: "exists",
          whitelist: finalWhitelist,
          source: effectiveSource,
          title: existing.title,
        };
      }

      existing.sources = existing.sources || [];
      existing.sources.push({
        url: normalizedUrl ?? null,
        source: effectiveSource,
        mark: null,
      });

      await Promise.all([
        persistWhitelistItems(whitelist, { saveWhitelistFn, redisClient }),
        redisClient.hset(MANGA_LAST_UPDATES_KEY, {
          [normalizeTitleKey(existing.title)]: new Date().toISOString(),
        }),
      ]);

      const finalWhitelist = await loadWhitelistFn(redisClient);
      return {
        status: "added",
        whitelist: finalWhitelist,
        source: effectiveSource,
        title: existing.title,
      };
    }

    whitelist.push({
      title: normalizedTitle,
      sources: [{ url: normalizedUrl ?? null, source: effectiveSource, mark: null }],
    });

    await Promise.all([
      persistWhitelistItems(whitelist, { saveWhitelistFn, redisClient }),
      redisClient.hset(MANGA_LAST_UPDATES_KEY, {
        [titleKey]: new Date().toISOString(),
      }),
    ]);

    if (normalizedUrl && effectiveSource === "ikiru") {
      triggerInitialDispatch(normalizedUrl, normalizedTitle, redisClient);
    }

    const finalWhitelist = await loadWhitelistFn(redisClient);
    return {
      status: "added",
      whitelist: finalWhitelist,
      source: effectiveSource,
      title: normalizedTitle,
    };
  });
}

function triggerInitialDispatch(normalizedUrl, normalizedTitle, redisClient) {
  const dispatchTimeoutMs = 30000;

  const dispatchPromise = (async () => {
    try {
      const chapters = await fetchIkiruRecentChaptersFromLatestPage(normalizedUrl, redisClient);
      if (chapters.length > 0) {
        const guildChannels = await getAllGuildChannels(redisClient);
        const channelIds = Object.values(guildChannels ?? {});
        if (channelIds.length > 0) {
          await dispatchChapters({
            redis: redisClient,
            matched: chapters,
            channelIds,
            sendEmbed: sendDiscordEmbed,
            chapterTtl: CHAPTER_TTL_SEC,
          });
        }
      }
    } catch (err) {
      logger.error({ err: err.message }, "Failed to dispatch initial chapters");
    }
  })();

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error("Dispatch timeout")), dispatchTimeoutMs);
  });

  Promise.race([dispatchPromise, timeoutPromise]).catch((err) => {
    logger.warn({ err: err.message, title: normalizedTitle }, "Initial dispatch skipped/timed out");
  });
}

async function cleanupMangaData(redisClient, titleKey) {
  if (!redisClient || !titleKey) return;

  try {
    const subsRaw = await redisClient.hget(MANGA_SUBSCRIBERS_KEY, titleKey);
    let subscribers = [];
    if (subsRaw) {
      try {
        subscribers = JSON.parse(subsRaw);
      } catch {
        subscribers = [];
      }
    }

    const userCleanupTasks = subscribers.map((userId) =>
      redisClient.srem(`user:follows:set:${userId}`, titleKey).catch(() => { }),
    );

    await Promise.all([
      redisClient.hdel(MANGA_SUBSCRIBERS_KEY, titleKey),
      redisClient.hdel(MANGA_MUTES_KEY, titleKey),
      redisClient.del(`manga:subscribers:set:${titleKey}`),
      redisClient.del(`manga:mutes:set:${titleKey}`),
      redisClient.del(`manga:subscribers:${titleKey}`),
      redisClient.del(`manga:mutes:${titleKey}`),
      redisClient.del(`stale:warned:${titleKey}`),
      redisClient.hdel(MANGA_LAST_UPDATES_KEY, titleKey),
      redisClient.zrem("manga:popularity_index", titleKey),
      ...userCleanupTasks,
    ]);
  } catch (err) {
    logger.error({ titleKey, err: err.message }, "[cleanupMangaData] Error");
  }
}

export async function removeWhitelistEntry(
  query,
  {
    loadWhitelistFn = loadWhitelist,
    saveWhitelistFn = saveWhitelist,
    redisClient = redis,
  } = {},
) {
  return withWhitelistLock(redisClient, async () => {
    const items = await loadWhitelistFn(redisClient);
    const trimmed = String(query || "").trim();

    if (/^https?:\/\//i.test(trimmed)) {
      const normUrl = normalizeSourceUrl(trimmed);
      const index = items.findIndex((item) =>
        item.sources?.some((s) => normalizeSourceUrl(s.url || "") === normUrl),
      );

      if (index !== -1) {
        const item = items[index];
        const sourceIndex = item.sources.findIndex(
          (s) => normalizeSourceUrl(s.url || "") === normUrl,
        );
        const removedSource = item.sources[sourceIndex];

        item.sources.splice(sourceIndex, 1);

        let removedEntirely = false;
        if (item.sources.length === 0) {
          items.splice(index, 1);
          removedEntirely = true;
        }

        await Promise.all([
          persistWhitelistItems(items, { saveWhitelistFn, redisClient }),
          removedEntirely
            ? cleanupMangaData(redisClient, normalizeTitleKey(item.title))
            : Promise.resolve(),
        ]);

        const finalItems = await loadWhitelistFn(redisClient);

        return {
          status: "removed_source",
          items: finalItems,
          item,
          removedSource,
          removedEntirely,
        };
      }
    }

    const resolved = resolveWhitelistQuery(items, trimmed);
    if (resolved.status === "ambiguous") {
      return { status: "ambiguous", items, matches: resolved.matches };
    }
    if (resolved.status === "not_found") {
      return { status: "not_found", items };
    }

    const removedItem = items[resolved.index];
    const titleKey = normalizeTitleKey(removedItem.title);
    items.splice(resolved.index, 1);

    await Promise.all([
      persistWhitelistItems(items, { saveWhitelistFn, redisClient }),
      cleanupMangaData(redisClient, titleKey),
    ]);

    const finalItems = await loadWhitelistFn(redisClient);
    return { status: "removed", items: finalItems, item: removedItem };
  });
}

export async function removeWhitelistEntryIdentity(
  { title, source = null, url = null },
  {
    loadWhitelistFn = loadWhitelist,
    saveWhitelistFn = saveWhitelist,
    redisClient = redis,
  } = {},
) {
  return withWhitelistLock(redisClient, async () => {
    const items = await loadWhitelistFn(redisClient);
    const normalizedTitle = normalizeTitleKey(String(title || "").trim());

    const index = items.findIndex(
      (item) => normalizeTitleKey(item.title) === normalizedTitle,
    );
    if (index === -1) return { status: "not_found", items };

    const item = items[index];

    if (url) {
      const normUrl = normalizeSourceUrl(url);
      const sourceIndex =
        item.sources?.findIndex(
          (s) => normalizeSourceUrl(s.url || "") === normUrl,
        ) ?? -1;

      if (sourceIndex === -1) return { status: "not_found", items };

      const removedSource = item.sources[sourceIndex];
      item.sources.splice(sourceIndex, 1);

      let removedEntirely = false;
      if (!item.sources.length) {
        items.splice(index, 1);
        removedEntirely = true;
      }

      await Promise.all([
        persistWhitelistItems(items, { saveWhitelistFn, redisClient }),
        removedEntirely
          ? cleanupMangaData(redisClient, normalizeTitleKey(item.title))
          : Promise.resolve(),
      ]);

      const finalItems = await loadWhitelistFn(redisClient);

      return {
        status: "removed_source",
        items: finalItems,
        item,
        removedSource,
        removedEntirely,
      };
    }

    if (source) {
      const normSource = normalizeSource(source);
      const sourceIndex =
        item.sources?.findIndex(
          (s) => normalizeSource(s.source || "") === normSource,
        ) ?? -1;

      if (sourceIndex === -1) return { status: "not_found", items };

      const removedSource = item.sources[sourceIndex];
      item.sources.splice(sourceIndex, 1);

      let removedEntirely = false;
      if (!item.sources.length) {
        items.splice(index, 1);
        removedEntirely = true;
      }

      await Promise.all([
        persistWhitelistItems(items, { saveWhitelistFn, redisClient }),
        removedEntirely
          ? cleanupMangaData(redisClient, normalizeTitleKey(item.title))
          : Promise.resolve(),
      ]);

      const finalItems = await loadWhitelistFn(redisClient);

      return {
        status: "removed_source",
        items: finalItems,
        item,
        removedSource,
        removedEntirely,
      };
    }

    const removedItem = items.splice(index, 1)[0];
    const titleKey = normalizeTitleKey(removedItem.title);

    await Promise.all([
      persistWhitelistItems(items, { saveWhitelistFn, redisClient }),
      cleanupMangaData(redisClient, titleKey),
    ]);

    const finalItems = await loadWhitelistFn(redisClient);
    return { status: "removed", items: finalItems, item: removedItem };
  });
}

export async function clearWhitelist() {
  return withWhitelistLock(redis, async () => {
    const items = await loadWhitelist(redis);

    const cleanupTasks = items.map((item) =>
      cleanupMangaData(redis, normalizeTitleKey(item.title)),
    );

    await Promise.all([persistWhitelistItems([], { redisClient: redis }), ...cleanupTasks]);

    return { status: "cleared", count: items.length };
  });
}

export async function markWhitelistEntry(
  query,
  reason,
  {
    loadWhitelistFn = loadWhitelist,
    saveWhitelistFn = saveWhitelist,
    redisClient = redis,
  } = {},
) {
  return withWhitelistLock(redisClient, async () => {
    const normalizedQuery = String(query || "").trim();
    if (!normalizedQuery) throw new Error("Query required");

    const normalizedReason = normalizeMarkReason(reason);
    const items = await loadWhitelistFn(redisClient);
    const resolved = resolveWhitelistQuery(items, normalizedQuery);

    if (resolved.status === "ambiguous") {
      return { status: "ambiguous", items, matches: resolved.matches };
    }
    if (resolved.status === "not_found") {
      return { status: "not_found", items };
    }

    const item = items[resolved.index];
    if (item.sources) {
      item.sources.forEach((s) => {
        s.mark = normalizedReason;
      });
    }

    await persistWhitelistItems(items, { saveWhitelistFn, redisClient });
    const finalItems = await loadWhitelistFn(redisClient);

    return {
      status: "updated",
      items: finalItems,
      item: finalItems.find((x) => normalizeTitleKey(x.title) === normalizeTitleKey(item.title)) || item,
      reason: normalizedReason,
    };
  });
}

function formatRelativeIndo(isoString) {
  if (!isoString) return { text: null, isHibernating: false };
  const date = new Date(isoString);
  const diffMs = new Date() - date;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  let text;
  if (diffDay > 0) text = `${diffDay} hari yang lalu`;
  else if (diffHour > 0) text = `${diffHour} jam yang lalu`;
  else if (diffMin > 0) text = `${diffMin} menit yang lalu`;
  else text = "Baru saja";

  return { text, isHibernating: diffDay >= 14 };
}

export function formatMarkedTitle(item) {
  const title = String(item?.title || "").trim();
  const reason = normalizeMarkReason(item?.mark || item?.sources?.[0]?.mark);
  if (!reason) return title;
  return `${title} [${MARK_REASON_LABELS[reason] || reason}]`;
}

export async function buildWhitelistListResponse(
  page = 1,
  pageSize = 10,
  { search = null, filter = null } = {},
) {
  let whitelist = await loadWhitelist(redis);

  if (search) {
    whitelist = whitelist.filter((item) =>
      item.title?.toLowerCase().includes(search.toLowerCase()),
    );
  }

  if (filter) {
    whitelist = whitelist.filter((item) =>
      item.sources?.some((s) => s.mark === filter.toLowerCase()),
    );
  }

  const totalPage = Math.ceil(whitelist.length / pageSize) || 1;
  const safePage = Math.min(Math.max(1, page), totalPage);
  const start = (safePage - 1) * pageSize;
  const slice = whitelist.slice(start, start + pageSize);

  const titleKeys = slice.map((item) => normalizeTitleKey(item.title));
  let updateTimes = [];

  if (titleKeys.length > 0) {
    try {
      const updateTimesRaw = await redis.hmget(
        MANGA_LAST_UPDATES_KEY,
        ...titleKeys,
      );

      if (
        updateTimesRaw &&
        !Array.isArray(updateTimesRaw) &&
        typeof updateTimesRaw === "object"
      ) {
        updateTimes = titleKeys.map((tk) => updateTimesRaw[tk]);
      } else {
        updateTimes = updateTimesRaw || [];
      }
    } catch {
      updateTimes = [];
    }
  }

  const lines = slice.map((item, i) => {
    const sourceIcons = (item.sources || [])
      .map((s) => `[${sourceLabel(s.source)}]`)
      .join(" ");
    const { text, isHibernating } = formatRelativeIndo(updateTimes[i]);
    return `${start + i + 1}. **${formatMarkedTitle(item)}**${isHibernating ? " 💤" : ""} ${sourceIcons}${text ? ` _(Update: ${text})_` : ""}`;
  });

  const content =
    whitelist.length === 0
      ? "Whitelist kosong."
      : `📚 **Daftar Whitelist (${whitelist.length})**${search ? ` | Cari: "${search}"` : ""}${filter ? ` | Status: ${MARK_REASON_LABELS[filter] || filter}` : ""}\n*Halaman ${safePage}/${totalPage}*\n\n${lines.join("\n")}`;

  const components =
    whitelist.length === 0
      ? []
      : [
        {
          type: DISCORD_COMPONENT_TYPE.ACTION_ROW,
          components: [
            {
              type: DISCORD_COMPONENT_TYPE.BUTTON,
              style: DISCORD_BUTTON_STYLE.PRIMARY,
              label: "Sebelumnya",
              custom_id: `list:${safePage - 1}${search ? `:${search.slice(0, 30)}` : ""}${filter ? `|${filter.slice(0, 20)}` : ""}`,
              disabled: safePage <= 1,
            },
            {
              type: DISCORD_COMPONENT_TYPE.BUTTON,
              style: DISCORD_BUTTON_STYLE.SECONDARY,
              label: `Hal ${safePage}`,
              custom_id: "noop",
              disabled: true,
            },
            {
              type: DISCORD_COMPONENT_TYPE.BUTTON,
              style: DISCORD_BUTTON_STYLE.PRIMARY,
              label: "Berikutnya",
              custom_id: `list:${safePage + 1}${search ? `:${search.slice(0, 30)}` : ""}${filter ? `|${filter.slice(0, 20)}` : ""}`,
              disabled: safePage >= totalPage,
            },
          ],
        },
      ];

  return { content, components, items: whitelist };
}

export function buildAddSuccessMessage({ title, source, total }) {
  return `Berhasil menambah **${title}** dari **${sourceLabel(source)}**.\nTotal Whitelist: **${total}**`;
}

export function buildAddExistsMessage({ title, source }) {
  return `**${title}** sudah ada di whitelist (**${sourceLabel(source)}**).`;
}
