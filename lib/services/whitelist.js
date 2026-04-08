import { loadWhitelist, redis, saveWhitelist, getAllGuildChannels } from "../redis.js";
import { fetchRecentChaptersFromMangaPage } from "../scrapers/ikiru.js";
import { dispatchChapters } from "./dispatch.js";
import { sendDiscordEmbed } from "../discord.js";
import { CHAPTER_TTL_SEC } from "../config.js";
import {
  WHITELIST_API_CACHE_KEY,
  invalidateDashboardCaches,
} from "../cacheKeys.js";
import {
  inferSourceFromUrl,
  normalizeSource,
  normalizeSourceUrl,
  sourceLabel,
} from "../domain.js";
import { MARK_REASON_LABELS, normalizeMarkReason } from "../domain.js";
import { fuzzyTitleSimilarity, normalizeTitleKey } from "../domain.js";
import { compactArray } from "../utils.js";

/** ==========================================
 * WHITELIST ENGINE AND DATA MANAGEMENT
 * ========================================== */

export function findWhitelistEntryIndex(items, { title, url = null } = {}) {
  const normalizedTitle = String(title || "").trim();
  const normalizedUrl = url ? normalizeSourceUrl(url) : null;
  if (!normalizedTitle && !normalizedUrl) return -1;

  return items.findIndex((item) => {
    if (
      normalizedTitle &&
      item.title?.toLowerCase() === normalizedTitle.toLowerCase()
    )
      return true;
    if (
      normalizedUrl &&
      item.sources?.some(
        (s) => normalizeSourceUrl(s.url || "") === normalizedUrl,
      )
    )
      return true;
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

    if (exactMatches.length > 1)
      return { status: "ambiguous", matches: exactMatches };
    if (exactMatches.length === 1) index = exactMatches[0].index;
    else {
      const partialMatches = list
        .map((item, itemIndex) => ({ item, index: itemIndex }))
        .filter(({ item }) => item.title.toLowerCase().includes(lower));
      if (partialMatches.length > 1)
        return { status: "ambiguous", matches: partialMatches };
      if (partialMatches.length === 1) index = partialMatches[0].index;
      else {
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
          } else {
            return {
              status: "ambiguous",
              suggested: true,
              matches: fuzzyMatches
                .slice(0, 5)
                .map((fm) => ({ item: fm.item, index: fm.index })),
            };
          }
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
  )
    return normalizedSource;
  return inferredSource || normalizedSource;
}

async function persistWhitelistItems(
  items,
  { saveWhitelistFn = saveWhitelist, redisClient = redis } = {},
) {
  await saveWhitelistFn(items);
  await invalidateDashboardCaches(redisClient, [WHITELIST_API_CACHE_KEY]);
}

export async function addWhitelistEntry(
  { title, url = null, source = "ikiru" },
  {
    redisClient = redis,
    loadWhitelistFn = loadWhitelist,
    saveWhitelistFn = saveWhitelist,
  } = {},
) {
  const normalizedTitle = String(title || "").trim();
  if (!normalizedTitle) throw new Error("Title required");

  const effectiveSource = resolveWhitelistSource({ url, source });
  const normalizedUrl = url ? normalizeSourceUrl(url) : null;

  // Ambil whitelist lengkap untuk pengecekan (bisa dioptimasi lebih lanjut nanti)
  const whitelist = await loadWhitelistFn();

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
  const titleKey = normalizeTitleKey(normalizedTitle);

  // Task untuk inisialisasi timestamp update
  const initUpdateTask = redisClient.hset("manga:last_updates", {
    [titleKey]: new Date().toISOString(),
  });

  if (activeIndex !== -1) {
    const existing = whitelist[activeIndex];
    const hasSource = existing.sources?.some(
      (s) =>
        normalizeSource(s.source) === effectiveSource &&
        (!normalizedUrl || normalizeSourceUrl(s.url || "") === normalizedUrl),
    );

    if (hasSource)
      return {
        status: "exists",
        whitelist,
        source: effectiveSource,
        title: normalizedTitle,
      };

    existing.sources = existing.sources || [];
    existing.sources.push({
      url: url ?? null,
      source: effectiveSource,
      mark: null,
    });

    // Simpan perubahan ke entry tunggal di Hash dan update index ZSET (melalui saveWhitelist untuk saat ini agar aman)
    await Promise.all([saveWhitelistFn(whitelist), initUpdateTask]);
    return {
      status: "added",
      whitelist,
      source: effectiveSource,
      title: normalizedTitle,
    };
  }

  whitelist.push({
    title: normalizedTitle,
    sources: [{ url: url ?? null, source: effectiveSource, mark: null }],
  });
  await Promise.all([saveWhitelistFn(whitelist), initUpdateTask]);

  // Trigger immediate chapter check and dispatch for new manga
  // Fire and forget - don't block the response
  if (normalizedUrl && effectiveSource === "ikiru") {
    (async () => {
      try {
        console.log(`[addWhitelistEntry] Fetching chapters from ${normalizedUrl}`);
        const chapters = await fetchRecentChaptersFromMangaPage(normalizedUrl, redisClient);
        console.log(`[addWhitelistEntry] Found ${chapters.length} chapters from ${normalizedTitle}`);
        if (chapters.length > 0) {
          console.log("[addWhitelistEntry] Chapter sample:", chapters[0]);
          const guildChannels = await getAllGuildChannels();
          const channelIds = Object.values(guildChannels ?? {});
          console.log(`[addWhitelistEntry] Channels: ${channelIds.length}`, channelIds);
          if (channelIds.length > 0) {
            const result = await dispatchChapters({
              redis: redisClient,
              matched: chapters,
              channelIds,
              sendEmbed: sendDiscordEmbed,
              chapterTtl: CHAPTER_TTL_SEC,
            });
            console.log("[addWhitelistEntry] Dispatch result:", result);
          }
        }
      } catch (err) {
        console.error("[addWhitelistEntry] Failed to dispatch initial chapters:", err.message);
      }
    })();
  }

  return {
    status: "added",
    whitelist,
    source: effectiveSource,
    title: normalizedTitle,
  };
}

/**
 * Pembersihan data terkait manga yang dihapus dari Redis
 * Handles both old SET-based and new HASH-based data structures
 */
async function cleanupMangaData(redisClient, titleKey) {
  if (!redisClient || !titleKey) return;
  try {
    // Get subscribers before cleanup to fix users:follows index
    const subscribersJson = await redisClient.hget(
      "manga:subscribers",
      titleKey,
    );
    const subscribers = subscribersJson ? JSON.parse(subscribersJson) : [];

    // Remove this title from each user's follows list
    const userCleanupTasks = subscribers.map(async (userId) => {
      const userFollowsJson = await redisClient.hget("users:follows", userId);
      if (userFollowsJson) {
        const userFollows = JSON.parse(userFollowsJson);
        const updatedFollows = userFollows.filter((t) => t !== titleKey);
        if (updatedFollows.length > 0) {
          await redisClient.hset("users:follows", {
            [userId]: JSON.stringify(updatedFollows),
          });
        } else {
          await redisClient.hdel("users:follows", userId);
        }
      }
    });

    await Promise.all([
      // Clean up old SET-based structure (if exists)
      redisClient.del(`manga:subscribers:${titleKey}`),
      redisClient.del(`manga:mutes:${titleKey}`),
      redisClient.del(`stale:warned:${titleKey}`),
      // Clean up new HASH-based structure
      redisClient.hdel("manga:subscribers", titleKey),
      redisClient.hdel("manga:mutes", titleKey),
      redisClient.hdel("manga:last_updates", titleKey),
      redisClient.zrem("manga:popularity_index", titleKey),
      // Clean up users:follows entries
      ...userCleanupTasks,
    ]);
  } catch (err) {
    console.error(
      `[cleanupMangaData] Error titleKey=${titleKey}:`,
      err.message,
    );
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
  const items = await loadWhitelistFn();
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

      await persistWhitelistItems(items, { saveWhitelistFn, redisClient });
      return {
        status: "removed_source",
        items,
        item,
        removedSource,
        removedEntirely,
      };
    }
  }

  const resolved = resolveWhitelistQuery(items, trimmed);
  if (resolved.status === "ambiguous")
    return { status: "ambiguous", items, matches: resolved.matches };
  if (resolved.status === "not_found") return { status: "not_found", items };

  const removedItem = items[resolved.index];
  const titleKey = normalizeTitleKey(removedItem.title);
  items.splice(resolved.index, 1);

  await Promise.all([
    persistWhitelistItems(items, { saveWhitelistFn, redisClient }),
    cleanupMangaData(redisClient, titleKey),
  ]);

  return { status: "removed", items, item: removedItem };
}

/**
 * Menghapus satu sumber spesifik dari entry whitelist berdasarkan title + source/url.
 * Jika setelah dihapus entry tidak memiliki sumber lagi, entry dihapus seluruhnya.
 */
export async function removeWhitelistEntryIdentity(
  { title, source = null, url = null },
  {
    loadWhitelistFn = loadWhitelist,
    saveWhitelistFn = saveWhitelist,
    redisClient = redis,
  } = {},
) {
  const items = await loadWhitelistFn();
  const normalizedTitle = normalizeTitleKey(String(title || "").trim());

  const index = items.findIndex(
    (item) => normalizeTitleKey(item.title) === normalizedTitle,
  );
  if (index === -1) return { status: "not_found", items };

  const item = items[index];

  // Jika ada url, cari source berdasarkan url
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

    await persistWhitelistItems(items, { saveWhitelistFn, redisClient });
    return {
      status: "removed_source",
      items,
      item,
      removedSource,
      removedEntirely,
    };
  }

  // Jika ada source, hapus sumber berdasarkan normalizeSource
  if (source) {
    const { normalizeSource } = await import("../domain.js");
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

    await persistWhitelistItems(items, { saveWhitelistFn, redisClient });
    return {
      status: "removed_source",
      items,
      item,
      removedSource,
      removedEntirely,
    };
  }

  // Fallback: hapus seluruh entry
  const removedItem = items.splice(index, 1)[0];
  const titleKey = normalizeTitleKey(removedItem.title);

  await Promise.all([
    persistWhitelistItems(items, { saveWhitelistFn, redisClient }),
    cleanupMangaData(redisClient, titleKey),
  ]);

  return { status: "removed", items, item: removedItem };
}

export async function clearWhitelist() {
  const items = await loadWhitelist();

  // Cleanup semua data terkait manga sebelum menghapus index utama
  const cleanupTasks = items.map((item) =>
    cleanupMangaData(redis, normalizeTitleKey(item.title)),
  );

  await Promise.all([persistWhitelistItems([]), ...cleanupTasks]);

  return { status: "cleared", count: items.length };
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
  const normalizedQuery = String(query || "").trim();
  if (!normalizedQuery) throw new Error("Query required");

  const normalizedReason = normalizeMarkReason(reason);
  const items = await loadWhitelistFn();
  const resolved = resolveWhitelistQuery(items, normalizedQuery);

  if (resolved.status === "ambiguous")
    return { status: "ambiguous", items, matches: resolved.matches };
  if (resolved.status === "not_found") return { status: "not_found", items };

  const item = items[resolved.index];
  if (item.sources)
    item.sources.forEach((s) => {
      s.mark = normalizedReason;
    });

  await persistWhitelistItems(items, { saveWhitelistFn, redisClient });
  return {
    status: "updated",
    items,
    item: items[resolved.index],
    reason: normalizedReason,
  };
}

/** ==========================================
 * UI AND DISCORD PRESENTATION
 * ========================================== */

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
  let whitelist = await loadWhitelist();

  if (search)
    whitelist = whitelist.filter((item) =>
      item.title?.toLowerCase().includes(search.toLowerCase()),
    );
  if (filter)
    whitelist = whitelist.filter((item) =>
      item.sources?.some((s) => s.mark === filter.toLowerCase()),
    );

  const totalPage = Math.ceil(whitelist.length / pageSize) || 1;
  const safePage = Math.min(Math.max(1, page), totalPage);
  const start = (safePage - 1) * pageSize;
  const slice = whitelist.slice(start, start + pageSize);

  const titleKeys = slice.map((item) => normalizeTitleKey(item.title));
  let updateTimes = [];
  if (titleKeys.length > 0) {
    try {
      const updateTimesRaw = await redis.hmget(
        "manga:last_updates",
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
    } catch (_err) {
      /* ignore */
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
      : `📚 **Daftar Whitelist (${whitelist.length})**${search ? ` | Cari: "${search}"` : ""}${filter ? ` | Status: ${MARK_REASON_LABELS[filter] || filter}` : ""}\n*Halaman ${safePage}/${totalPage}*\n\n${
        lines.join("\n")}`;

  const components =
    whitelist.length === 0
      ? []
      : [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 1,
              label: "Sebelumnya",
              custom_id: `list:${safePage - 1}${search ? `:${search.slice(0, 30)}` : ""}${filter ? `|${filter.slice(0, 20)}` : ""}`,
              disabled: safePage <= 1,
            },
            {
              type: 2,
              style: 2,
              label: `Hal ${safePage}`,
              custom_id: "noop",
              disabled: true,
            },
            {
              type: 2,
              style: 1,
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
