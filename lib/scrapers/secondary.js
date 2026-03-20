import { httpGet } from "../httpClient.js";
import {
  HTTP_USER_AGENT,
  SECONDARY_CHAPTER_LIST_MAX_PAGES,
  SECONDARY_DETAIL_MAX_MANGA,
  SECONDARY_DETAIL_THROTTLE_MS,
  SECONDARY_DETAIL_WINDOW_HOURS,
  SECONDARY_PUBLIC_BASE,
  SECONDARY_SOURCE_URL,
  normalizeSource,
  parseIkiruDatetime,
  parseLooseRelativeTime,
  pickSecondaryDescription,
  shouldPrioritizeSecondaryTitle,
  sleep,
} from "./shared.js";

function getShngmType(source) {
  return normalizeSource(source) === "shinigami_mirror" ? "mirror" : "project";
}

async function fetchSecondaryRecentChapters(apiBase, mangaId) {
  const pageSize = 24;
  const collected = [];

  for (let page = 1; page <= Math.max(1, SECONDARY_CHAPTER_LIST_MAX_PAGES); page++) {
    const endpoint =
      `${apiBase}/v1/chapter/${mangaId}/list` +
      `?page=${page}&page_size=${pageSize}&sort_by=chapter_number&sort_order=desc`;

    const res = await httpGet(
      endpoint,
      {
        headers: {
          Accept: "application/json",
          "User-Agent": HTTP_USER_AGENT,
        },
        timeout: 10000,
      },
      {
        retries: 2,
        baseDelayMs: 350,
      },
    );

    const payload = res.data || {};
    const rows = Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.result)
        ? payload.result
        : Array.isArray(payload?.items)
          ? payload.items
          : [];
    if (!rows.length) break;

    let foundFreshOnThisPage = false;
    for (const row of rows) {
      const parsedTime =
        parseIkiruDatetime(row?.release_date || row?.created_at || row?.updated_at || null) ||
        parseLooseRelativeTime(row?.release_date || row?.created_at || row?.updated_at || null);
      if (!parsedTime) continue;
      if ((Date.now() - parsedTime.getTime()) / 3600000 > 24) continue;
      foundFreshOnThisPage = true;

      collected.push({
        chapter_id: row?.chapter_id,
        chapter_number: row?.chapter_number,
        created_at: parsedTime.toISOString(),
      });
    }

    if (!foundFreshOnThisPage || rows.length < pageSize) break;
  }

  return collected;
}

export async function scrapeSecondarySourceUpdates(
  source = "shinigami_project",
  { throwOnError = false, preferredTitleKeys = null } = {},
  logger = null,
) {
  if (!SECONDARY_SOURCE_URL) {
    return {
      results: [],
      metrics: {
        detailAttempts: 0,
        detailSuccesses: 0,
        detailFallbacks: 0,
        detail429: 0,
        detailSkippedNonPriority: 0,
      },
    };
  }

  try {
    const apiBase = SECONDARY_SOURCE_URL.replace(/\/+$/, "");
    const normalized = normalizeSource(source);
    const endpoint =
      `${apiBase}/v1/manga/list?type=${getShngmType(normalized)}` +
      "&page=1&page_size=40&is_update=true&sort=latest&sort_order=desc";

    const res = await httpGet(
      endpoint,
      {
        headers: {
          Accept: "application/json",
          "User-Agent": HTTP_USER_AGENT,
        },
        timeout: 10000,
      },
      {
        retries: 3,
        baseDelayMs: 350,
      },
    );

    const payload = res.data || {};
    const rows = Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.result)
        ? payload.result
        : Array.isArray(payload?.items)
          ? payload.items
          : [];

    const results = [];
    const metrics = {
      detailAttempts: 0,
      detailSuccesses: 0,
      detailFallbacks: 0,
      detail429: 0,
      detailSkippedNonPriority: 0,
    };
    const seen = new Set();
    let detailCount = 0;
    let detailCircuitOpen = false;

    for (const row of rows) {
      const title = String(row?.title || "").trim();
      if (!title || !row?.manga_id) continue;

      const mangaUrl = `${SECONDARY_PUBLIC_BASE}/series/${row.manga_id}`;
      const cover = row?.cover_image_url || row?.cover_portrait_url || null;
      const latestParsed =
        parseIkiruDatetime(row?.latest_chapter_time || row?.updated_at || null) ||
        parseLooseRelativeTime(row?.latest_chapter_time || row?.updated_at || null);
      const latestDiffHours = latestParsed
        ? (Date.now() - latestParsed.getTime()) / 3600000
        : Number.POSITIVE_INFINITY;
      const prioritizeDetail = shouldPrioritizeSecondaryTitle(title, preferredTitleKeys);
      const shouldUseDetail =
        prioritizeDetail &&
        !detailCircuitOpen &&
        detailCount < SECONDARY_DETAIL_MAX_MANGA &&
        latestDiffHours <= SECONDARY_DETAIL_WINDOW_HOURS;

      if (!prioritizeDetail) {
        metrics.detailSkippedNonPriority += 1;
        continue;
      }

      let chapterRows = [];
      if (shouldUseDetail) {
        metrics.detailAttempts += 1;
        try {
          await sleep(SECONDARY_DETAIL_THROTTLE_MS);
          chapterRows = await fetchSecondaryRecentChapters(apiBase, row.manga_id);
          detailCount += 1;
          metrics.detailSuccesses += 1;
        } catch (err) {
          if (err?.response?.status === 429) {
            detailCircuitOpen = true;
            metrics.detail429 += 1;
            if (logger) {
              logger.warn({ source: normalized }, "secondary detail 429; disabling detail mode");
            }
          } else {
            if (logger) {
              logger.warn(
                { source: normalized, mangaId: row.manga_id, err: err.message },
                "secondary chapter list fallback",
              );
            }
          }
          metrics.detailFallbacks += 1;
        }
      }

      if (!Array.isArray(chapterRows) || !chapterRows.length) {
        if (!shouldUseDetail) metrics.detailFallbacks += 1;
        chapterRows = Array.isArray(row?.chapters) && row.chapters.length
          ? row.chapters
          : [
              {
                chapter_id: row?.latest_chapter_id,
                chapter_number: row?.latest_chapter_number,
                created_at: row?.latest_chapter_time || row?.updated_at,
              },
            ];
      }

      for (const chapterRow of chapterRows) {
        if (!chapterRow?.chapter_id) continue;

        const chapterText = String(chapterRow?.chapter_number ?? "").trim();
        const chapter = /chapter/i.test(chapterText)
          ? chapterText
          : chapterText
            ? `Chapter ${chapterText}`
            : "";
        if (!chapter) continue;

        const parsedTime =
          parseIkiruDatetime(chapterRow?.created_at || row?.updated_at || null) ||
          parseLooseRelativeTime(chapterRow?.created_at || row?.updated_at || null);
        if (!parsedTime || (Date.now() - parsedTime.getTime()) / 3600000 > 24) continue;

        const chapterUrl = `${SECONDARY_PUBLIC_BASE}/chapter/${chapterRow.chapter_id}`;
        const key = chapterUrl.toLowerCase().trim();
        if (seen.has(key)) continue;
        seen.add(key);

        results.push({
          title,
          chapter,
          url: chapterUrl,
          cover,
          mangaUrl,
          rating: row?.user_rate ? String(row.user_rate) : "N/A",
          status: row?.status === 1 ? "Ongoing" : "Unknown",
          updatedTime: parsedTime.toISOString(),
          description: pickSecondaryDescription(row),
          source: normalized,
        });
      }
    }

    return { results, metrics };
  } catch (err) {
    if (logger) logger.warn({ source, err: err.message }, "secondary scrape failed");
    if (throwOnError) throw err;
    return {
      results: [],
      metrics: {
        detailAttempts: 0,
        detailSuccesses: 0,
        detailFallbacks: 0,
        detail429: 0,
        detailSkippedNonPriority: 0,
      },
    };
  }
}

export async function searchShngm(query, source = "shinigami_project") {
  const keyword = String(query || "").trim().toLowerCase();
  if (!keyword) return [];

  const normalized = normalizeSource(source);
  const type = getShngmType(normalized);
  const apiBase = SECONDARY_SOURCE_URL.replace(/\/+$/, "");
  const results = [];
  const seen = new Set();

  for (let page = 1; page <= 4; page++) {
    try {
      const endpoint =
        `${apiBase}/v1/manga/list?type=${type}&page=${page}&page_size=40&sort=latest&sort_order=desc`;
      const res = await httpGet(
        endpoint,
        {
          headers: {
            Accept: "application/json",
            "User-Agent": HTTP_USER_AGENT,
          },
          timeout: 10000,
        },
        {
          retries: 2,
          baseDelayMs: 350,
        },
      );

      const payload = res.data || {};
      const rows = Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload?.result)
          ? payload.result
          : Array.isArray(payload?.items)
            ? payload.items
            : [];
      if (!rows.length) break;

      for (const row of rows) {
        const title = String(row?.title || "").trim();
        if (!title) continue;

        const normTitle = title.toLowerCase();
        if (!(normTitle.includes(keyword) || keyword.includes(normTitle))) continue;
        if (!row?.manga_id) continue;

        const mangaUrl = `${SECONDARY_PUBLIC_BASE}/series/${row.manga_id}`;
        const key = mangaUrl.toLowerCase().replace(/\/+$/, "");
        if (seen.has(key)) continue;
        seen.add(key);

        results.push({
          title,
          mangaUrl,
          updatedTime:
            (
              parseIkiruDatetime(row?.latest_chapter_time || row?.updated_at) ||
              parseLooseRelativeTime(row?.latest_chapter_time || row?.updated_at)
            )?.toISOString() || null,
          description: pickSecondaryDescription(row),
          source: normalized,
        });
      }
    } catch {
      break;
    }
  }

  return results.slice(0, 50);
}
