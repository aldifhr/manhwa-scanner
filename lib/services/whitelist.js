import { loadWhitelist, saveWhitelist } from "../redis.js";
import { WHITELIST_API_CACHE_KEY, invalidateDashboardCaches } from "../cacheKeys.js";
import { redis } from "../redis.js";
import {
  inferSourceFromUrl,
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
  // If item already has the source/url combo in its sources array
  return (
    item.title?.toLowerCase() === title.toLowerCase() ||
    item.sources?.some(s => 
      normalizeSource(s.source) === normalizedSource && 
      (normalizedUrl && normalizeSourceUrl(s.url || "") === normalizedUrl)
    )
  );
}

export function findWhitelistEntryIndex(items, { title, url = null, source = null } = {}) {
  const normalizedTitle = String(title || "").trim();
  const normalizedUrl = url ? normalizeSourceUrl(url) : null;
  const normalizedSource = source ? normalizeSource(source) : null;

  if (!normalizedTitle && !normalizedUrl) return -1;

  return items.findIndex((item) => {
    // Exact title match
    if (normalizedTitle && item.title?.toLowerCase() === normalizedTitle.toLowerCase()) {
      return true;
    }
    // Or URL match in any of its sources
    if (normalizedUrl && item.sources?.some(s => normalizeSourceUrl(s.url || "") === normalizedUrl)) {
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

async function persistWhitelistItems(items, {
  saveWhitelistFn = saveWhitelist,
  redisClient = redis,
} = {}) {
  await saveWhitelistFn(items);
  await invalidateDashboardCaches(redisClient, [WHITELIST_API_CACHE_KEY]);
}

export async function addWhitelistEntry({ title, url = null, source = "ikiru" }) {
  const normalizedTitle = String(title || "").trim();
  if (!normalizedTitle) throw new Error("Title required");

  const effectiveSource = resolveWhitelistSource({ url, source });
  const normalizedUrl = url ? normalizeSourceUrl(url) : null;
  const whitelist = await loadWhitelist();

  const existingIndex = findWhitelistEntryIndex(whitelist, { title: normalizedTitle, url: normalizedUrl });

  if (existingIndex !== -1) {
    const existing = whitelist[existingIndex];
    // Check if this source already exists in sources array
    const hasSource = existing.sources?.some(s => 
      normalizeSource(s.source) === effectiveSource && 
      (!normalizedUrl || normalizeSourceUrl(s.url || "") === normalizedUrl)
    );

    if (hasSource) {
      return {
        status: "exists",
        whitelist,
        source: effectiveSource,
        title: normalizedTitle,
      };
    }

    // Add new source to existing title
    existing.sources = existing.sources || [];
    existing.sources.push({
      url: url ?? null,
      source: effectiveSource,
      mark: null
    });
    
    await persistWhitelistItems(whitelist);
    return {
      status: "added",
      whitelist,
      source: effectiveSource,
      title: normalizedTitle,
    };
  }

  // New Title
  whitelist.push({
    title: normalizedTitle,
    sources: [{
      url: url ?? null,
      source: effectiveSource,
      mark: null,
    }]
  });
  await persistWhitelistItems(whitelist);

  return {
    status: "added",
    whitelist,
    source: effectiveSource,
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
  await persistWhitelistItems(items);
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
  await persistWhitelistItems(items);
  return { status: "removed", items, item: removedItem };
}

export async function removeWhitelistEntry(query, {
  loadWhitelistFn = loadWhitelist,
  saveWhitelistFn = saveWhitelist,
  redisClient = redis,
} = {}) {
  const items = await loadWhitelistFn();
  const resolved = resolveWhitelistQuery(items, query);

  if (resolved.status === "ambiguous") {
    return { status: "ambiguous", items, matches: resolved.matches };
  }

  if (resolved.status === "not_found") {
    return { status: "not_found", items };
  }

  const removedItem = items[resolved.index];
  items.splice(resolved.index, 1);
  await persistWhitelistItems(items, { saveWhitelistFn, redisClient });
  return { status: "removed", items, item: removedItem };
}

export async function clearWhitelist() {
  const items = await loadWhitelist();
  await persistWhitelistItems([]);
  return { status: "cleared", count: items.length };
}

export async function markWhitelistEntry(query, reason, {
  loadWhitelistFn = loadWhitelist,
  saveWhitelistFn = saveWhitelist,
  redisClient = redis,
} = {}) {
  const normalizedQuery = String(query || "").trim();
  if (!normalizedQuery) throw new Error("Query required");

  const normalizedReason = normalizeMarkReason(reason);
  const items = await loadWhitelistFn();
  const resolved = resolveWhitelistQuery(items, normalizedQuery);

  if (resolved.status === "ambiguous") {
    return { status: "ambiguous", items, matches: resolved.matches };
  }

  if (resolved.status === "not_found") {
    return { status: "not_found", items };
  }

  const item = items[resolved.index];
  // For multi-source, mark affects ALL sources of this title by default, 
  // or I could let the user pick. Let's make it affect all sources for now.
  if (item.sources) {
    item.sources.forEach(s => {
      s.mark = normalizedReason;
    });
  }

  await persistWhitelistItems(items, { saveWhitelistFn, redisClient });
  return {
    status: "updated",
    items,
    item: items[resolved.index],
    reason: normalizedReason,
  };
}

export async function buildWhitelistListResponse(page = 1, pageSize = 10, { search = null, filter = null } = {}) {
  let whitelist = await loadWhitelist();

  // Apply Search
  if (search) {
    const term = search.toLowerCase();
    whitelist = whitelist.filter(item => item.title?.toLowerCase().includes(term));
  }

  // Apply Filter (Status)
  if (filter) {
    const f = filter.toLowerCase();
    whitelist = whitelist.filter(item => {
      // If any source has the requested mark
      return item.sources?.some(s => s.mark === f);
    });
  }

  const totalPage = Math.ceil(whitelist.length / pageSize) || 1;
  const safePage = Math.min(Math.max(1, page), totalPage);
  const start = (safePage - 1) * pageSize;
  const slice = whitelist.slice(start, start + pageSize);

  const content =
    whitelist.length === 0
      ? "Whitelist empty."
      : `Whitelist (${whitelist.length})${search ? ` | Search: "${search}"` : ""}${filter ? ` | Status: ${MARK_REASON_LABELS[filter] || filter}` : ""}\nPage ${safePage}/${totalPage}\n\n` +
        slice
          .map(
            (item, i) => {
              const sourceIcons = (item.sources || [])
                .map(s => `[${sourceLabel(s.source)}]`)
                .join(" ");
              return `${start + i + 1}. ${formatMarkedTitle(item)} ${sourceIcons}`;
            },
          )
          .join("\n");

  const searchParam = search ? `:${search}` : "";
  const filterParam = filter ? `|${filter}` : "";
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
                custom_id: `list:${safePage - 1}${searchParam}${filterParam}`,
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
                custom_id: `list:${safePage + 1}${searchParam}${filterParam}`,
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
