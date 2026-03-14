import { loadWhitelist, saveWhitelist } from "../redis.js";
import { WHITELIST_API_CACHE_KEY, invalidateDashboardCaches } from "../cacheKeys.js";
import { redis } from "../redis.js";
import {
  normalizeSource,
  normalizeSourceUrl,
  sourceLabel,
} from "../domain/source.js";

export const MARK_REASON_LABELS = Object.freeze({
  hiatus: "Hiatus",
  end_season: "End Season",
  end: "End",
});

export function normalizeMarkReason(value) {
  const raw = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");

  if (!raw || raw === "clear" || raw === "none") return null;
  return MARK_REASON_LABELS[raw] ? raw : null;
}

export function formatMarkedTitle(item) {
  const title = String(item?.title || "").trim();
  const reason = normalizeMarkReason(item?.mark);
  if (!reason) return title;
  return `${title} [${MARK_REASON_LABELS[reason]}]`;
}

function hasSameWhitelistIdentity(item, title, normalizedUrl, normalizedSource) {
  return (
    normalizeSource(item.source) === normalizedSource &&
    (item.title?.toLowerCase() === title.toLowerCase() ||
      (normalizedUrl && normalizeSourceUrl(item.url || "") === normalizedUrl))
  );
}

export function findWhitelistEntryIndex(items, { title, url = null, source = null } = {}) {
  const normalizedTitle = String(title || "").trim();
  const normalizedUrl = url ? normalizeSourceUrl(url) : null;
  const normalizedSource = source ? normalizeSource(source) : null;

  if (!normalizedTitle && !normalizedUrl) return -1;

  return items.findIndex((item) => {
    const itemSource = normalizeSource(item?.source);
    const itemTitle = String(item?.title || "").trim();
    const itemUrl = normalizeSourceUrl(item?.url || "");

    if (normalizedSource && itemSource !== normalizedSource) return false;
    if (normalizedUrl && itemUrl) return hasSameWhitelistIdentity(
      item,
      normalizedTitle || itemTitle,
      normalizedUrl,
      normalizedSource || itemSource,
    );
    return itemTitle.toLowerCase() === normalizedTitle.toLowerCase();
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

    if (exactMatches.length > 1) {
      return { status: "ambiguous", matches: exactMatches };
    }

    if (exactMatches.length === 1) {
      index = exactMatches[0].index;
    } else {
      const partialMatches = list
        .map((item, itemIndex) => ({ item, index: itemIndex }))
        .filter(({ item }) => item.title.toLowerCase().includes(lower));

      if (partialMatches.length > 1) {
        return { status: "ambiguous", matches: partialMatches };
      }

      if (partialMatches.length === 1) {
        index = partialMatches[0].index;
      }
    }
  }

  if (index === -1) {
    return { status: "not_found" };
  }

  return { status: "matched", index, item: list[index] };
}

export async function addWhitelistEntry({ title, url = null, source = "ikiru" }) {
  const normalizedTitle = String(title || "").trim();
  if (!normalizedTitle) throw new Error("Title required");

  const normalizedSource = normalizeSource(source);
  const normalizedUrl = url ? normalizeSourceUrl(url) : null;
  const whitelist = await loadWhitelist();

  const exists = whitelist.some((item) =>
    hasSameWhitelistIdentity(item, normalizedTitle, normalizedUrl, normalizedSource),
  );

  if (exists) {
    return {
      status: "exists",
      whitelist,
      source: normalizedSource,
      title: normalizedTitle,
    };
  }

  whitelist.push({
    title: normalizedTitle,
    url: url ?? null,
    source: normalizedSource,
    mark: null,
  });
  await saveWhitelist(whitelist);
  await invalidateDashboardCaches(redis, [WHITELIST_API_CACHE_KEY]);

  return {
    status: "added",
    whitelist,
    source: normalizedSource,
    title: normalizedTitle,
  };
}

export async function removeWhitelistEntryByTitle(title) {
  const items = await loadWhitelist();
  const index = findWhitelistEntryIndex(items, { title });
  if (index === -1) {
    return { status: "not_found", items };
  }

  const removedItem = items[index];
  items.splice(index, 1);
  await saveWhitelist(items);
  await invalidateDashboardCaches(redis, [WHITELIST_API_CACHE_KEY]);
  return { status: "removed", items, item: removedItem };
}

export async function removeWhitelistEntryIdentity({ title, url = null, source = null } = {}) {
  const items = await loadWhitelist();
  const index = findWhitelistEntryIndex(items, { title, url, source });

  if (index === -1) {
    return { status: "not_found", items };
  }

  const removedItem = items[index];
  items.splice(index, 1);
  await saveWhitelist(items);
  await invalidateDashboardCaches(redis, [WHITELIST_API_CACHE_KEY]);
  return { status: "removed", items, item: removedItem };
}

export async function removeWhitelistEntry(query) {
  const items = await loadWhitelist();
  const resolved = resolveWhitelistQuery(items, query);

  if (resolved.status === "ambiguous") {
    return { status: "ambiguous", items, matches: resolved.matches };
  }

  if (resolved.status === "not_found") {
    return { status: "not_found", items };
  }

  const removedItem = items[resolved.index];
  items.splice(resolved.index, 1);
  await saveWhitelist(items);
  await invalidateDashboardCaches(redis, [WHITELIST_API_CACHE_KEY]);
  return { status: "removed", items, item: removedItem };
}

export async function clearWhitelist() {
  const items = await loadWhitelist();
  await saveWhitelist([]);
  await invalidateDashboardCaches(redis, [WHITELIST_API_CACHE_KEY]);
  return { status: "cleared", count: items.length };
}

export async function markWhitelistEntry(query, reason) {
  const normalizedQuery = String(query || "").trim();
  if (!normalizedQuery) throw new Error("Query required");

  const normalizedReason = normalizeMarkReason(reason);
  const items = await loadWhitelist();
  let index = -1;

  const num = Number.parseInt(normalizedQuery, 10);
  if (Number.isInteger(num) && num >= 1 && num <= items.length) {
    index = num - 1;
  } else {
    const lower = normalizedQuery.toLowerCase();
    index = items.findIndex((item) => item.title.toLowerCase() === lower);

    if (index === -1) {
      index = items.findIndex((item) => item.title.toLowerCase().includes(lower));
    }
  }

  if (index === -1) {
    return { status: "not_found", items };
  }

  items[index] = {
    ...items[index],
    mark: normalizedReason,
  };

  await saveWhitelist(items);
  await invalidateDashboardCaches(redis, [WHITELIST_API_CACHE_KEY]);
  return {
    status: "updated",
    items,
    item: items[index],
    reason: normalizedReason,
  };
}

export async function buildWhitelistListResponse(page = 1, pageSize = 10) {
  const whitelist = await loadWhitelist();
  const totalPage = Math.ceil(whitelist.length / pageSize) || 1;
  const safePage = Math.min(Math.max(1, page), totalPage);
  const start = (safePage - 1) * pageSize;
  const slice = whitelist.slice(start, start + pageSize);

  const content =
    whitelist.length === 0
      ? "Whitelist empty."
      : `Whitelist (${whitelist.length})\nPage ${safePage}/${totalPage}\n\n` +
        slice
          .map(
            (item, i) =>
              `${start + i + 1}. [${sourceLabel(item.source)}] ${formatMarkedTitle(item)}`,
          )
          .join("\n");

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
                label: "Prev",
                custom_id: `list:${safePage - 1}`,
                disabled: safePage <= 1,
              },
              {
                type: 2,
                style: 2,
                label: `Page ${safePage}`,
                custom_id: "noop",
                disabled: true,
              },
              {
                type: 2,
                style: 1,
                label: "Next",
                custom_id: `list:${safePage + 1}`,
                disabled: safePage >= totalPage,
              },
            ],
          },
        ];

  return { content, components, items: whitelist };
}

export function buildAddSuccessMessage({ title, source, total }) {
  return `Added **${title}** from **${sourceLabel(source)}**.\nTotal: **${total}**`;
}

export function buildAddExistsMessage({ title, source }) {
  return `**${title}** already exists in **${sourceLabel(source)}**.`;
}