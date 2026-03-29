import * as cheerio from "cheerio";
import {
  AJAX_PATH,
  IKIRU_CHAPTER_LIST_MAX_PAGES,
  IKIRU_EMPTY_PAGE_BREAK_STREAK,
  IKIRU_LATEST_MAX_PAGES,
  LATEST_URL,
  SITE_URL,
  cleanImageUrl,
  isValidDate,
  normalizeSource,
  normalizeSourceUrl,
  normalizeText,
  parseIkiruDatetime,
  parseLooseRelativeTime,
  parseRelativeTimeText,
  resolveChapterUrl,
  scrapeWithHeaders,
  shouldPrioritizeSecondaryTitle,
  toAbsoluteUrl,
} from "./shared.js";

function parsePage($, seen) {
  const results = [];
  let foundOlderThan24h = false;
  let foundFreshWithin24h = false;

  $("#search-results")
    .children()
    .each((_, card) => {
      const $card = $(card);
      const $vertical = $card.children("div").first();
      if (!$vertical.length) return;

      const title = $vertical.find("h1").first().text().trim();
      if (!title) return;

      const mangaUrl = toAbsoluteUrl($vertical.find("a[href*='/manga/']").first().attr("href"));
      const cover = cleanImageUrl(toAbsoluteUrl($vertical.find("img").first().attr("src")));
      const rating = $vertical.find(".numscore").text().trim() || "N/A";
      const status =
        $vertical
          .find("p.font-normal.text-xs")
          .filter((_, el) =>
            ["Ongoing", "Completed", "Hiatus"].includes($(el).text().trim()),
          )
          .first()
          .text()
          .trim() || "Unknown";

      const $chapterLinks = $vertical.find("a[href*='/chapter-']");
      if (!$chapterLinks.length) return;

      $chapterLinks.each((_, el) => {
        const $link = $(el);
        const chapterText = $link.find("p").text().trim();
        const timeNode = $link.find("time[datetime]").first();
        let updatedTime = timeNode.attr("datetime");
        let parsedUpdated = parseIkiruDatetime(updatedTime);
        if (!parsedUpdated) {
          const timeFallbackText = $link.find("time").first().text().trim();
          parsedUpdated = parseRelativeTimeText(timeFallbackText);
          updatedTime = parsedUpdated?.toISOString() ?? null;
        }
        const rawUrl = $link.attr("href");
        if (!chapterText || !parsedUpdated || !rawUrl) return;

        const url = toAbsoluteUrl(rawUrl);
        const diffHours = (Date.now() - parsedUpdated.getTime()) / 3600000;
        if (diffHours > 24) {
          foundOlderThan24h = true;
          return;
        }
        foundFreshWithin24h = true;

        const key = `${title}-${chapterText}`;
        if (seen.has(key)) return;
        seen.add(key);

        results.push({
          title,
          chapter: chapterText,
          url,
          cover,
          mangaUrl,
          rating,
          status,
          updatedTime,
          source: "ikiru",
        });
      });
    });

  return { results, foundOlderThan24h, foundFreshWithin24h };
}

export function collectIkiruRecentChaptersFromMangaPage($, mangaUrl, baseItem = {}, seen = null) {
  const results = [];
  const title =
    normalizeText(baseItem?.title) ||
    normalizeText($("h1").first().text()) ||
    normalizeText($(".entry-title, .post-title, .series-title").first().text());
  const cover =
    baseItem?.cover ??
    cleanImageUrl(
      toAbsoluteUrl($(".summary_image img, .thumb img, img.wp-post-image").first().attr("src")),
    );
  const rating =
    (baseItem?.rating ?? normalizeText($(".numscore, .rating-prc .num").first().text())) || "N/A";
  const status =
    (
      baseItem?.status ??
      normalizeText(
        $("p.font-normal.text-xs, .tsinfo .imptdt i")
          .filter((_, el) =>
            ["Ongoing", "Completed", "Hiatus"].includes($(el).text().trim()),
          )
          .first()
          .text(),
      )
    ) || "Unknown";
  const fallbackMangaUrl = toAbsoluteUrl(mangaUrl);
  const seenKeys = seen instanceof Set ? seen : new Set();

  $("li:has(a[href*='/chapter-']), .eplister li, .clstyle li, .chapters li").each((_, el) => {
    const $row = $(el);
    const href = $row.find("a[href*='/chapter-']").first().attr("href");
    const chapterUrl = resolveChapterUrl(href, fallbackMangaUrl);
    const chapterText =
      normalizeText($row.find("a[href*='/chapter-'] p").first().text()) ||
      normalizeText($row.find("a[href*='/chapter-']").first().text());
    const rawUpdated =
      $row.find("time[datetime]").first().attr("datetime") ||
      $row.find("time").first().text().trim() ||
      $row.find(".text-gray-500, .text-xs, .date, .chapter-date, .chapterdate").first().text().trim() ||
      null;
    const parsedUpdated =
      parseIkiruDatetime(rawUpdated) ||
      parseLooseRelativeTime(rawUpdated) ||
      parseRelativeTimeText(rawUpdated);

    if (!chapterUrl || !chapterText || !parsedUpdated) return;
    if ((Date.now() - parsedUpdated.getTime()) / 3600000 > 24) return;

    const key = `${title}-${chapterText}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);

    results.push({
      title,
      chapter: chapterText,
      url: chapterUrl,
      cover,
      mangaUrl: fallbackMangaUrl,
      rating,
      status,
      updatedTime: parsedUpdated.toISOString(),
      source: "ikiru",
    });
  });

  return results;
}

function extractIkiruMangaId($) {
  const rawHxGet =
    $("#chapter-list").attr("hx-get") ||
    $("[hx-get*='action=chapter_list']").first().attr("hx-get") ||
    "";
  const match = String(rawHxGet).match(/manga_id=(\d+)/i);
  return match ? match[1] : null;
}

export function collectIkiruRecentChaptersFromAjaxHtml(html, mangaUrl, baseItem = {}, seen = null) {
  const $ = cheerio.load(html);
  const results = [];
  const title = normalizeText(baseItem?.title);
  const cover = baseItem?.cover ?? null;
  const rating = baseItem?.rating || "N/A";
  const status = baseItem?.status || "Unknown";
  const fallbackMangaUrl = toAbsoluteUrl(mangaUrl);
  const seenKeys = seen instanceof Set ? seen : new Set();
  let foundOlderThan24h = false;

  $("#chapter-list > div[data-chapter-number], #chapter-list .flex[data-chapter-number]").each((_, el) => {
    const $row = $(el);
    const href = $row.find("a[href*='/chapter-']").first().attr("href");
    const chapterUrl = resolveChapterUrl(href, fallbackMangaUrl);
    const chapterText = normalizeText($row.find("span").first().text());
    const rawUpdated =
      $row.find("time[datetime]").first().attr("datetime") ||
      $row.find("time").first().text().trim() ||
      null;
    const parsedUpdated =
      parseIkiruDatetime(rawUpdated) ||
      parseLooseRelativeTime(rawUpdated) ||
      parseRelativeTimeText(rawUpdated);

    if (!chapterUrl || !chapterText || !parsedUpdated) return;

    const diffHours = (Date.now() - parsedUpdated.getTime()) / 3600000;
    if (diffHours > 24) {
      foundOlderThan24h = true;
      return;
    }

    const key = `${title}-${chapterText}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);

    results.push({
      title,
      chapter: chapterText,
      url: chapterUrl,
      cover,
      mangaUrl: fallbackMangaUrl,
      rating,
      status,
      updatedTime: parsedUpdated.toISOString(),
      source: "ikiru",
    });
  });

  return { results, foundOlderThan24h };
}

async function fetchIkiruRecentChaptersFromAjax(mangaId, mangaUrl, redis, baseItem = {}, seen = null) {
  if (!mangaId) return [];

  const collected = [];
  for (let page = 1; page <= Math.max(1, IKIRU_CHAPTER_LIST_MAX_PAGES); page++) {
    const endpoint =
      `${SITE_URL}${AJAX_PATH}?manga_id=${encodeURIComponent(mangaId)}&page=${page}&action=chapter_list`;
    try {
      const res = await scrapeWithHeaders(endpoint, redis, {
        timeout: 10000,
        extraHeaders: { Accept: "text/html, */*" },
      });
      const { results, foundOlderThan24h } = collectIkiruRecentChaptersFromAjaxHtml(
        res.data,
        mangaUrl,
        baseItem,
        seen,
      );
      if (results.length) collected.push(...results);
      if (!results.length || foundOlderThan24h) break;
    } catch (err) {
      console.warn(`[fetchIkiruRecentChaptersFromAjax] Failed for ${mangaUrl}:`, err.message);
      break;
    }
  }

  return collected;
}

async function fetchIkiruRecentChaptersFromMangaPage(mangaUrl, redis, baseItem = {}, seen = null) {
  if (!mangaUrl) return [];

  try {
    const res = await scrapeWithHeaders(mangaUrl, redis, { timeout: 10000 });
    const $ = cheerio.load(res.data);
    const mangaId = extractIkiruMangaId($);
    const ajaxResults = await fetchIkiruRecentChaptersFromAjax(mangaId, mangaUrl, redis, baseItem, seen);
    if (ajaxResults.length) return ajaxResults;
    return collectIkiruRecentChaptersFromMangaPage($, mangaUrl, baseItem, seen);
  } catch (err) {
    console.warn(`[fetchIkiruRecentChaptersFromMangaPage] Failed for ${mangaUrl}:`, err.message);
    return [];
  }
}

export async function expandIkiruUpdatesFromDetailPages(items = [], redis = null, preferredTitleKeys = null) {
  if (!(preferredTitleKeys instanceof Set) || preferredTitleKeys.size === 0) {
    return items;
  }

  const candidates = [];
  const candidateKeys = new Set();
  for (const item of items) {
    if (normalizeSource(item?.source) !== "ikiru") continue;
    if (!shouldPrioritizeSecondaryTitle(item?.title, preferredTitleKeys)) continue;
    const candidateKey = normalizeSourceUrl(item?.mangaUrl || item?.url || "");
    if (!candidateKey || candidateKeys.has(candidateKey)) continue;
    candidateKeys.add(candidateKey);
    candidates.push(item);
  }
  if (!candidates.length) return items;

  const candidateKeySet = new Set(candidates.map((item) => normalizeSourceUrl(item?.mangaUrl || item?.url || "")));
  const seen = new Set(
    items
      .filter((item) => !candidateKeySet.has(normalizeSourceUrl(item?.mangaUrl || item?.url || "")))
      .map((item) => `${String(item?.title || "").trim()}-${String(item?.chapter || "").trim()}`),
  );
  const replacementMap = new Map();

  await Promise.all(
    candidates.map(async (item) => {
      const expanded = await fetchIkiruRecentChaptersFromMangaPage(item.mangaUrl || item.url, redis, item, seen);
      if (expanded.length) {
        replacementMap.set(normalizeSourceUrl(item.mangaUrl || item.url || ""), expanded);
      }
    }),
  );

  if (!replacementMap.size) return items;

  const merged = [];
  const injected = new Set();
  for (const item of items) {
    const key = normalizeSourceUrl(item?.mangaUrl || item?.url || "");
    if (replacementMap.has(key)) {
      if (injected.has(key)) continue;
      merged.push(...replacementMap.get(key));
      injected.add(key);
      continue;
    }
    merged.push(item);
  }

  return merged;
}

export async function fetchLatestMangaUpdateTime(mangaUrl, redis = null) {
  if (!mangaUrl) return null;

  const cacheKey = `lastupd:${mangaUrl}`;
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return cached;
    } catch (err) {
      console.warn("[fetchLatestMangaUpdateTime] Redis get failed:", err.message);
    }
  }

  try {
    const res = await scrapeWithHeaders(mangaUrl, redis, { timeout: 10000 });
    const $ = cheerio.load(res.data);
    const chapterCandidates = [];
    const chapterUrls = [];
    const seenChapterUrls = new Set();

    $("li:has(a[href*='/chapter-']), .eplister li, .clstyle li, .chapters li").each((_, el) => {
      const $row = $(el);
      const href = $row.find("a[href*='/chapter-']").first().attr("href");
      const chapterUrl = resolveChapterUrl(href, mangaUrl);
      if (chapterUrl && !seenChapterUrls.has(chapterUrl)) {
        seenChapterUrls.add(chapterUrl);
        chapterUrls.push(chapterUrl);
      }

      const raw =
        $row.find("time[datetime]").first().attr("datetime") ||
        $row.find("time").first().text().trim() ||
        $row.find(".text-gray-500, .text-xs, .date, .chapter-date, .chapterdate").first().text().trim() ||
        null;
      const parsed =
        parseIkiruDatetime(raw) ||
        parseLooseRelativeTime(raw) ||
        parseRelativeTimeText(raw);
      if (isValidDate(parsed)) chapterCandidates.push(parsed);
    });

    $("a[href*='/chapter-']").each((_, el) => {
      const chapterUrl = resolveChapterUrl($(el).attr("href"), mangaUrl);
      if (chapterUrl && !seenChapterUrls.has(chapterUrl)) {
        seenChapterUrls.add(chapterUrl);
        chapterUrls.push(chapterUrl);
      }
    });

    if (!chapterCandidates.length) {
      let lastUpdatesRaw = null;
      $("h4").each((_, h4) => {
        if (lastUpdatesRaw) return;
        const label = $(h4).text().trim().toLowerCase();
        if (!label.includes("last updates")) return;
        const row = $(h4).closest("div");
        const raw =
          row.find("p").last().text().trim() ||
          row.siblings("div").first().find("p").first().text().trim() ||
          null;
        if (raw) lastUpdatesRaw = raw;
      });

      const parsedLastUpdates =
        parseLooseRelativeTime(lastUpdatesRaw) ||
        parseRelativeTimeText(lastUpdatesRaw) ||
        parseIkiruDatetime(lastUpdatesRaw);
      if (isValidDate(parsedLastUpdates)) chapterCandidates.push(parsedLastUpdates);
    }

    if (!chapterCandidates.length) {
      const rawModified =
        $("time[itemprop='dateModified']").attr("datetime") ||
        $("meta[property='article:modified_time']").attr("content") ||
        $("meta[property='og:updated_time']").attr("content") ||
        null;
      const parsedModified = parseIkiruDatetime(rawModified);
      if (isValidDate(parsedModified)) chapterCandidates.push(parsedModified);
    }

    if (!chapterCandidates.length && chapterUrls.length) {
      const latestChapterUrl = chapterUrls[0];
      try {
        const chapterRes = await scrapeWithHeaders(latestChapterUrl, redis, { timeout: 10000 });
        const $$ = cheerio.load(chapterRes.data);
        const chapterRaw =
          $$("meta[property='article:published_time']").attr("content") ||
          $$("meta[property='og:updated_time']").attr("content") ||
          $$("time[datetime]").first().attr("datetime") ||
          $$("time").first().text().trim() ||
          $$(".entry-date, .post-date, .chapter-date, .updated").first().text().trim() ||
          null;
        const parsedChapter =
          parseIkiruDatetime(chapterRaw) ||
          parseLooseRelativeTime(chapterRaw) ||
          parseRelativeTimeText(chapterRaw);
        if (isValidDate(parsedChapter)) chapterCandidates.push(parsedChapter);
      } catch (err) {
        console.warn(
          `[fetchLatestMangaUpdateTime] Chapter fallback failed for ${latestChapterUrl}:`,
          err.message,
        );
      }
    }

    if (!chapterCandidates.length) {
      const rawFallback =
        $("time[datetime]").first().attr("datetime") ||
        $("time").first().text().trim() ||
        null;
      const parsedFallback =
        parseIkiruDatetime(rawFallback) ||
        parseLooseRelativeTime(rawFallback) ||
        parseRelativeTimeText(rawFallback);
      if (isValidDate(parsedFallback)) chapterCandidates.push(parsedFallback);
    }

    const latest = chapterCandidates.length
      ? chapterCandidates.filter(isValidDate).sort((a, b) => b.getTime() - a.getTime())[0]
      : null;
    const iso = latest?.toISOString() || null;

    if (redis && iso) {
      await redis
        .set(cacheKey, iso, { ex: 60 * 60 * 6 })
        .catch((err) => console.warn("[fetchLatestMangaUpdateTime] Redis set failed:", err.message));
    }

    return iso;
  } catch (err) {
    console.warn(`[fetchLatestMangaUpdateTime] Failed for ${mangaUrl}:`, err.message);
    return null;
  }
}

export function shouldBreakIkiruLatestScan({
  emptyPageStreak = 0,
  stalePageStreak = 0,
} = {}) {
  if (emptyPageStreak >= IKIRU_EMPTY_PAGE_BREAK_STREAK) return true;
  if (stalePageStreak >= 2) return true;
  return false;
}

export async function scrapeIkiruUpdatesWithMeta(
  redis = null,
  preferredIkiruTitleKeys = new Set(),
  logger = null,
) {
  const sourceState = { status: "pending", count: 0, error: null, metrics: null };
  let ikiruPageError = null;
  const ikiruResults = [];
  const seen = new Set();
  let stalePageStreak = 0;
  let emptyPageStreak = 0;
  let pagesScanned = 0;

  for (let page = 1; page <= Math.max(1, IKIRU_LATEST_MAX_PAGES); page++) {
    pagesScanned = page;
    const url = page === 1 ? LATEST_URL : `${LATEST_URL}?the_page=${page}`;

    let res;
    try {
      res = await scrapeWithHeaders(url, redis);
    } catch (err) {
      ikiruPageError = err;
      if (logger) logger.warn({ page, err: err.message }, "ikiru latest page fetch failed");
      break;
    }

    const $ = cheerio.load(res.data);
    const { results, foundOlderThan24h, foundFreshWithin24h } = parsePage($, seen);
    ikiruResults.push(...results);
    if (logger) logger.info({ page, count: results.length }, "ikiru latest page parsed");

    if (results.length === 0) {
      emptyPageStreak += 1;
    } else {
      emptyPageStreak = 0;
    }

    stalePageStreak = !foundFreshWithin24h && foundOlderThan24h ? stalePageStreak + 1 : 0;

    if (shouldBreakIkiruLatestScan({
      emptyPageStreak,
      stalePageStreak,
    })) break;
  }

  const expandedResults = await expandIkiruUpdatesFromDetailPages(
    ikiruResults,
    redis,
    preferredIkiruTitleKeys,
  );
  sourceState.status = ikiruPageError && expandedResults.length === 0 ? "error" : "ok";
  sourceState.count = expandedResults.length;
  sourceState.error = ikiruPageError && expandedResults.length === 0 ? ikiruPageError.message : null;
  sourceState.metrics = {
    pagesScanned,
    stalePageStreak,
    emptyPageStreak,
    maxPages: Math.max(1, IKIRU_LATEST_MAX_PAGES),
    preferredTitles: preferredIkiruTitleKeys.size,
    expandedCount: Math.max(0, expandedResults.length - ikiruResults.length),
  };

  return { results: expandedResults, state: sourceState };
}

export async function fetchRandomIkiruManga(redis = null) {
  // Ambil page dari 1 sampai 50 secara acak untuk mendapatkan list manga
  const randPage = Math.floor(Math.random() * 50) + 1;
  const url = `${SITE_URL}/manga/?page=${randPage}`;
  
  try {
    const res = await scrapeWithHeaders(url, redis, { timeout: 10000 });
    const $ = cheerio.load(res.data);
    
    const results = [];
    $("#search-results").children().each((_, card) => {
      const $card = $(card);
      const $vertical = $card.children("div").first();
      if (!$vertical.length) return;

      const title = $vertical.find("h1").first().text().trim();
      if (!title) return;

      const mangaUrl = toAbsoluteUrl($vertical.find("a[href*='/manga/']").first().attr("href"));
      const cover = cleanImageUrl(toAbsoluteUrl($vertical.find("img").first().attr("src")));
      const rating = $vertical.find(".numscore").text().trim() || "N/A";
      const status =
        $vertical
          .find("p.font-normal.text-xs")
          .filter((_, el) =>
            ["Ongoing", "Completed", "Hiatus"].includes($(el).text().trim()),
          )
          .first()
          .text()
          .trim() || "Unknown";
      
      results.push({ title, mangaUrl, cover, rating, status });
    });
    
    if (results.length > 0) {
      const randomIndex = Math.floor(Math.random() * results.length);
      return results[randomIndex];
    }
    return null;
  } catch (err) {
    console.warn("[fetchRandomIkiruManga] Error:", err.message);
    return null;
  }
}

