import * as cheerio from "cheerio";
import { httpGet } from "../httpClient.js";
import { HTTP_USER_AGENT, SECONDARY_SOURCE_URL } from "../scrapers/shared.js";
import { loadWhitelist, saveWhitelist, redis } from "../redis.js";
import { WHITELIST_API_CACHE_KEY, invalidateDashboardCaches } from "../cacheKeys.js";
import { inferSourceFromUrl, normalizeSource, normalizeSourceUrl, sourceLabel } from "../domain.js";
import { MARK_REASON_LABELS, normalizeMarkReason } from "../domain.js";
import { normalizeTitleKey, fuzzyTitleSimilarity } from "../domain.js";

/** ==========================================
 * ADD FROM URL LOGIC
 * ========================================== */

const DOMAIN_SOURCE_MAP = [
  { pattern: /ikiru\.wtf/i,          source: "ikiru" },
  { pattern: /shinigami-id\.com/i,   source: "shinigami_project" },
  { pattern: /shinigami\.moe/i,      source: "shinigami_project" },
  { pattern: /shinigami\.asia/i,     source: "shinigami_project" },
  { pattern: /shinigami\.ink/i,      source: "shinigami_mirror" },
  { pattern: /komikcast/i,           source: "ikiru" },
];

export function detectSourceFromUrl(url) {
  const str = String(url || "").toLowerCase();
  const ikiruBase = process.env.IKIRU_BASE_URL ? process.env.IKIRU_BASE_URL.toLowerCase() : null;
  const shigBase = process.env.SECONDARY_PUBLIC_BASE ? process.env.SECONDARY_PUBLIC_BASE.toLowerCase() : null;

  if (ikiruBase && str.startsWith(ikiruBase)) return "ikiru";
  if (shigBase && str.startsWith(shigBase)) return "shinigami_project";

  for (const { pattern, source } of DOMAIN_SOURCE_MAP) {
    if (pattern.test(str)) return source;
  }
  return null;
}

async function scrapeIkiruTitle(url) {
  const res = await httpGet(url, { headers: { "User-Agent": HTTP_USER_AGENT }, timeout: 12000 }, { retries: 2, baseDelayMs: 500 });
  const html = typeof res?.data === "string" ? res.data : null;
  if (!html) return null;

  const $ = cheerio.load(html);
  const selectors = ["h1.entry-title", ".post-title h1", "h1.manga-title", "h1"];
  for (const sel of selectors) {
    const title = $(sel).first().text().trim();
    if (title) return title;
  }
  return null;
}

async function scrapeShingmTitle(url) {
  const uuidMatch = url.match(/\/series\/([a-f0-9-]{36})/i);
  if (uuidMatch && uuidMatch[1]) {
    try {
      const apiRes = await httpGet(`${SECONDARY_SOURCE_URL.replace(/\/+$/, "")}/v1/manga/detail/${uuidMatch[1]}`, { headers: { "User-Agent": HTTP_USER_AGENT, "Accept": "application/json" }, timeout: 10000 });
      const apiTitle = apiRes?.data?.data?.title;
      if (apiTitle) return String(apiTitle).trim();
    } catch { /* ignore */ }
  }

  const res = await httpGet(url, {
      headers: {
        "User-Agent": HTTP_USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Upgrade-Insecure-Requests": "1",
      }, timeout: 15000,
    }, { retries: 2, baseDelayMs: 1000 });
  const html = typeof res?.data === "string" ? res.data : null;
  if (!html) return null;

  const $ = cheerio.load(html);
  const selectors = ["h1.text-xl", "h1.title", ".series-title h1", "h1"];
  for (const sel of selectors) {
    const title = $(sel).first().text().trim();
    if (title && title !== "undefined - Shinigami Scans" && title !== "Shinigami Scans") return title;
  }

  const titleMatch = html.match(/"title":"([^\\"]+)"/g);
  if (titleMatch && titleMatch.length > 0) {
    for (const match of titleMatch) {
      const extracted = match.replace(/"title":"|"/g, "");
      if (extracted && extracted.length > 2 && extracted !== "Shinigami Scans" && extracted !== "undefined - Shinigami Scans" && extracted !== "Home") return extracted;
    }
  }

  const titleTagMatch = html.match(/<title[^>]*>(.*?)<\/title>/is);
  if (titleTagMatch && titleTagMatch[1]) {
    let t = titleTagMatch[1].trim();
    t = t.replace(/\s*-\s*Shinigami(\s*Scans)?$/i, "").trim();
    if (t && t !== "undefined") return t;
  }
  return null;
}

export async function resolveAddFromUrl(url) {
  const cleanUrl = String(url || "").trim();
  if (!cleanUrl.startsWith("http")) return { title: null, source: null, error: "URL tidak valid. Pastikan dimulai dengan http:// atau https://" };

  const source = detectSourceFromUrl(cleanUrl);
  if (!source) return { title: null, source: null, error: "Domain URL tidak dikenali. URL harus dari Ikiru, Shinigami Project, atau Shinigami Mirror." };

  let title = null;
  try {
    if (source === "ikiru") title = await scrapeIkiruTitle(cleanUrl);
    else title = await scrapeShingmTitle(cleanUrl);
  } catch (err) {
    return { title: null, source, error: `Gagal membaca halaman: ${err.message}` };
  }

  if (!title) return { title: null, source, error: "Tidak dapat menemukan judul manga dari URL ini." };
  return { title, source, error: null };
}

/** ==========================================
 * WHITELIST ENGINE AND DATA MANAGEMENT
 * ========================================== */

export function findWhitelistEntryIndex(items, { title, url = null } = {}) {
  const normalizedTitle = String(title || "").trim();
  const normalizedUrl = url ? normalizeSourceUrl(url) : null;
  if (!normalizedTitle && !normalizedUrl) return -1;

  return items.findIndex((item) => {
    if (normalizedTitle && item.title?.toLowerCase() === normalizedTitle.toLowerCase()) return true;
    if (normalizedUrl && item.sources?.some(s => normalizeSourceUrl(s.url || "") === normalizedUrl)) return true;
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
    const exactMatches = list.map((item, itemIndex) => ({ item, index: itemIndex })).filter(({ item }) => item.title.toLowerCase() === lower);

    if (exactMatches.length > 1) return { status: "ambiguous", matches: exactMatches };
    if (exactMatches.length === 1) index = exactMatches[0].index;
    else {
      const partialMatches = list.map((item, itemIndex) => ({ item, index: itemIndex })).filter(({ item }) => item.title.toLowerCase().includes(lower));
      if (partialMatches.length > 1) return { status: "ambiguous", matches: partialMatches };
      if (partialMatches.length === 1) index = partialMatches[0].index;
      else {
        const fuzzyMatches = list.map((item, itemIndex) => ({ item, index: itemIndex, score: fuzzyTitleSimilarity(item.title, lower), }))
          .filter((res) => res.score > 0.55).sort((a, b) => b.score - a.score);

        if (fuzzyMatches.length > 1) {
          if (fuzzyMatches[0].score > fuzzyMatches[1].score + 0.1) {
            index = fuzzyMatches[0].index;
            return { status: "matched", index, item: list[index], suggested: true };
          } else {
            return { status: "ambiguous", suggested: true, matches: fuzzyMatches.slice(0, 5).map((fm) => ({ item: fm.item, index: fm.index })) };
          }
        } else if (fuzzyMatches.length === 1) {
          index = fuzzyMatches[0].index;
          return { status: "matched", index, item: list[index], suggested: true };
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
  if (normalizedSource === "shinigami_project" || normalizedSource === "shinigami_mirror") return normalizedSource;
  return inferredSource || normalizedSource;
}

async function persistWhitelistItems(items, { saveWhitelistFn = saveWhitelist, redisClient = redis } = {}) {
  await saveWhitelistFn(items);
  await invalidateDashboardCaches(redisClient, [WHITELIST_API_CACHE_KEY]);
}

export async function addWhitelistEntry({ title, url = null, source = "ikiru" }, { redisClient = redis, loadWhitelistFn = loadWhitelist, saveWhitelistFn = saveWhitelist } = {}) {
  const normalizedTitle = String(title || "").trim();
  if (!normalizedTitle) throw new Error("Title required");

  const effectiveSource = resolveWhitelistSource({ url, source });
  const normalizedUrl = url ? normalizeSourceUrl(url) : null;
  const whitelist = await loadWhitelistFn();

  const existingIndex = findWhitelistEntryIndex(whitelist, { title: normalizedTitle, url: normalizedUrl });
  let fuzzyExisting = null;

  if (existingIndex === -1 && !normalizedUrl) {
    for (const item of whitelist) {
      if (fuzzyTitleSimilarity(item.title, normalizedTitle) >= 0.8) {
        fuzzyExisting = item;
        break;
      }
    }
  }

  const activeIndex = existingIndex !== -1 ? existingIndex : (fuzzyExisting ? whitelist.indexOf(fuzzyExisting) : -1);
  const titleKey = normalizeTitleKey(normalizedTitle);
  const initUpdateTask = redisClient.set(`manga:last_update:${titleKey}`, new Date().toISOString());

  if (activeIndex !== -1) {
    const existing = whitelist[activeIndex];
    const hasSource = existing.sources?.some(s => normalizeSource(s.source) === effectiveSource && (!normalizedUrl || normalizeSourceUrl(s.url || "") === normalizedUrl));

    if (hasSource) return { status: "exists", whitelist, source: effectiveSource, title: normalizedTitle };

    existing.sources = existing.sources || [];
    existing.sources.push({ url: url ?? null, source: effectiveSource, mark: null });
    
    await Promise.all([persistWhitelistItems(whitelist, { redisClient, saveWhitelistFn }), initUpdateTask]);
    return { status: "added", whitelist, source: effectiveSource, title: normalizedTitle };
  }

  whitelist.push({ title: normalizedTitle, sources: [{ url: url ?? null, source: effectiveSource, mark: null }] });
  await Promise.all([persistWhitelistItems(whitelist, { redisClient, saveWhitelistFn }), initUpdateTask]);
  return { status: "added", whitelist, source: effectiveSource, title: normalizedTitle };
}

export async function removeWhitelistEntry(query, { loadWhitelistFn = loadWhitelist, saveWhitelistFn = saveWhitelist, redisClient = redis } = {}) {
  const items = await loadWhitelistFn();
  const trimmed = String(query || "").trim();

  if (/^https?:\/\//i.test(trimmed)) {
    const normUrl = normalizeSourceUrl(trimmed);
    const index = items.findIndex(item => item.sources?.some(s => normalizeSourceUrl(s.url || "") === normUrl));

    if (index !== -1) {
      const item = items[index];
      const sourceIndex = item.sources.findIndex(s => normalizeSourceUrl(s.url || "") === normUrl);
      const removedSource = item.sources[sourceIndex];
      
      item.sources.splice(sourceIndex, 1);
      
      let removedEntirely = false;
      if (item.sources.length === 0) {
        items.splice(index, 1);
        removedEntirely = true;
      }

      await persistWhitelistItems(items, { saveWhitelistFn, redisClient });
      return { status: "removed_source", items, item, removedSource, removedEntirely };
    }
  }

  const resolved = resolveWhitelistQuery(items, trimmed);
  if (resolved.status === "ambiguous") return { status: "ambiguous", items, matches: resolved.matches };
  if (resolved.status === "not_found") return { status: "not_found", items };

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

export async function markWhitelistEntry(query, reason, { loadWhitelistFn = loadWhitelist, saveWhitelistFn = saveWhitelist, redisClient = redis } = {}) {
  const normalizedQuery = String(query || "").trim();
  if (!normalizedQuery) throw new Error("Query required");

  const normalizedReason = normalizeMarkReason(reason);
  const items = await loadWhitelistFn();
  const resolved = resolveWhitelistQuery(items, normalizedQuery);

  if (resolved.status === "ambiguous") return { status: "ambiguous", items, matches: resolved.matches };
  if (resolved.status === "not_found") return { status: "not_found", items };

  const item = items[resolved.index];
  if (item.sources) item.sources.forEach(s => { s.mark = normalizedReason; });

  await persistWhitelistItems(items, { saveWhitelistFn, redisClient });
  return { status: "updated", items, item: items[resolved.index], reason: normalizedReason };
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

export async function buildWhitelistListResponse(page = 1, pageSize = 10, { search = null, filter = null } = {}) {
  let whitelist = await loadWhitelist();

  if (search) whitelist = whitelist.filter(item => item.title?.toLowerCase().includes(search.toLowerCase()));
  if (filter) whitelist = whitelist.filter(item => item.sources?.some(s => s.mark === filter.toLowerCase()));

  const totalPage = Math.ceil(whitelist.length / pageSize) || 1;
  const safePage = Math.min(Math.max(1, page), totalPage);
  const start = (safePage - 1) * pageSize;
  const slice = whitelist.slice(start, start + pageSize);

  const updateKeys = slice.map(item => `manga:last_update:${normalizeTitleKey(item.title)}`);
  let updateTimes = [];
  if (updateKeys.length > 0) {
    try { updateTimes = await redis.mget(...updateKeys); } catch (err) { /* ignore */ }
  }

  const lines = slice.map((item, i) => {
    const sourceIcons = (item.sources || []).map(s => `[${sourceLabel(s.source)}]`).join(" ");
    const { text, isHibernating } = formatRelativeIndo(updateTimes[i]);
    return `${start + i + 1}. **${formatMarkedTitle(item)}**${isHibernating ? " 💤" : ""} ${sourceIcons}${text ? ` _(Update: ${text})_` : ""}`;
  });

  const content = whitelist.length === 0 ? "Whitelist kosong." 
    : `📚 **Daftar Whitelist (${whitelist.length})**${search ? ` | Cari: "${search}"` : ""}${filter ? ` | Status: ${MARK_REASON_LABELS[filter] || filter}` : ""}\n*Halaman ${safePage}/${totalPage}*\n\n` + lines.join("\n");

  const components = whitelist.length === 0 ? [] : [{
    type: 1, components: [
      { type: 2, style: 1, label: "Sebelumnya", custom_id: `list:${safePage - 1}${search ? `:${search.slice(0, 30)}` : ""}${filter ? `|${filter.slice(0, 20)}` : ""}`, disabled: safePage <= 1 },
      { type: 2, style: 2, label: `Hal ${safePage}`, custom_id: "noop", disabled: true },
      { type: 2, style: 1, label: "Berikutnya", custom_id: `list:${safePage + 1}${search ? `:${search.slice(0, 30)}` : ""}${filter ? `|${filter.slice(0, 20)}` : ""}`, disabled: safePage >= totalPage },
    ]
  }];

  return { content, components, items: whitelist };
}

export function buildAddSuccessMessage({ title, source, total }) {
  return `Berhasil menambah **${title}** dari **${sourceLabel(source)}**.\nTotal Whitelist: **${total}**`;
}

export function buildAddExistsMessage({ title, source }) {
  return `**${title}** sudah ada di whitelist (**${sourceLabel(source)}**).`;
}
