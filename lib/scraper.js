import axios from "axios";
import * as cheerio from "cheerio";

const SITE_URL = "https://02.ikiru.wtf/";
const LATEST_URL = "https://02.ikiru.wtf/latest-update/";
const AJAX_PATH = "wp-admin/admin-ajax.php";
const SECONDARY_SOURCE_URL =
  process.env.SECONDARY_SOURCE_URL || "https://api.shngm.io";
const SECONDARY_PUBLIC_BASE =
  (process.env.SECONDARY_PUBLIC_BASE || "https://a.shinigami.asia")
    .replace(/\/+$/, "")
    .replace(/^https?:\/\/(?:www\.)?shngm\.id\b/i, "https://a.shinigami.asia")
    .replace(/^https?:\/\/(?:www\.)?shinigami\.asia\b/i, "https://a.shinigami.asia");

// ─── COOKIE ───────────────────────────────────────────────────────────────────
import { refreshCookie } from "./cookie.js";

let _cookie = process.env.IKIRU_COOKIE || "";
let _cookiePromise = null; // lock untuk prevent race condition

/**
 * Ambil cookie — dari memory, Redis, atau login ulang.
 * Menggunakan promise lock agar tidak terjadi race condition
 * ketika banyak request concurrent masuk bersamaan.
 */
async function getCookie(redis = null) {
  // 1. Sudah ada di memory
  if (_cookie) return _cookie;

  // 2. Sudah ada promise yang sedang berjalan — tunggu hasilnya
  if (_cookiePromise) return _cookiePromise;

  _cookiePromise = (async () => {
    // 3. Coba dari Redis
    if (redis) {
      try {
        const cached = await redis.get("ikiru:cookie");
        if (cached) {
          _cookie = cached;
          console.log("🍪 Cookie loaded from Redis");
          return _cookie;
        }
      } catch (err) {
        console.warn("[getCookie] Redis fetch failed:", err.message);
      }
    }

    // 4. Login ulang dan simpan ke Redis
    try {
      const fresh = await refreshCookie();
      if (fresh) {
        _cookie = fresh;
        if (redis) {
          // Simpan 12 hari (cookie WP biasanya 14 hari)
          await redis
            .set("ikiru:cookie", fresh, { ex: 60 * 60 * 24 * 12 })
            .catch((err) =>
              console.warn("[getCookie] Redis set failed:", err.message),
            );
        }
      }
    } catch (err) {
      console.error("[getCookie] refreshCookie failed:", err.message);
    }

    return _cookie || "";
  })();

  try {
    return await _cookiePromise;
  } finally {
    _cookiePromise = null;
  }
}

// ─── UTILS ────────────────────────────────────────────────────────────────────

/**
 * Retry dengan exponential backoff, max delay 5 detik.
 */
async function withRetry(fn, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      const status = err?.response?.status;
      // Jangan retry untuk client error permanen (kecuali rate-limit 429).
      if (status >= 400 && status < 500 && status !== 429) {
        throw err;
      }
      if (i === retries - 1) throw err;
      const delay = Math.min(1000 * Math.pow(2, i), 5000);
      console.log(`⚠️ Retry ${i + 1}/${retries} in ${delay}ms... (${err.message})`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/**
 * Konversi URL relatif ke absolut.
 */
const toAbsoluteUrl = (url, base = SITE_URL) => {
  if (!url) return null;
  if (url.startsWith("http")) return url;
  return `${base}${url.startsWith("/") ? url.slice(1) : url}`;
};

/**
 * Hapus suffix ukuran gambar WordPress, misal -300x450.
 */
const cleanImageUrl = (url) => url?.replace(/-\d+x\d+(\.\w+)$/, "$1") ?? null;

function resolveChapterUrl(href, mangaUrl) {
  if (!href) return null;
  const raw = String(href).trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;

  // Link chapter dari Ikiru kadang relatif tanpa leading slash.
  // Prioritaskan root domain, bukan relative ke manga URL.
  if (raw.startsWith("/")) return toAbsoluteUrl(raw, SITE_URL);

  const rootBased = toAbsoluteUrl(`/${raw}`, SITE_URL);
  if (rootBased) return rootBased;

  return toAbsoluteUrl(raw, mangaUrl || SITE_URL);
}

/**
 * Base headers yang dipakai semua request.
 */
async function baseHeaders(redis = null, extra = {}) {
  const cookie = await getCookie(redis);
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    ...(cookie ? { Cookie: cookie } : {}),
    ...extra,
  };
}

/**
 * GET request dengan headers lengkap + retry.
 */
async function scrapeWithHeaders(url, redis = null, options = {}) {
  const headers = await baseHeaders(redis, options.extraHeaders || {});
  return withRetry(
    () =>
      axios.get(url, {
        headers,
        timeout: options.timeout || 10000,
      }),
    options.retries,
  );
}

// ─── EXPORTS HELPERS ──────────────────────────────────────────────────────────

export const formatTimeAgo = (datetime) => {
  const parsed = parseIkiruDatetime(datetime);
  if (!parsed) return "Unknown";

  const diffMs = Date.now() - parsed.getTime();
  if (diffMs < -5 * 60 * 1000) {
    return new Intl.DateTimeFormat("id-ID", {
      hour: "2-digit",
      minute: "2-digit",
      day: "2-digit",
      month: "short",
      timeZone: "Asia/Jakarta",
    }).format(parsed);
  }

  try {
    const mins = Math.floor(diffMs / 60000);
    const hours = Math.floor(diffMs / 3600000);
    const days = Math.floor(diffMs / 86400000);

    return mins < 1
      ? "Just now"
      : mins < 60
        ? `${mins} min ago`
        : hours < 24
          ? `${hours} hour${hours > 1 ? "s" : ""} ago`
          : `${days} day${days > 1 ? "s" : ""} ago`;
  } catch {
    return "Unknown";
  }
};

export function parseIkiruDatetime(datetime) {
  if (!datetime) return null;
  const raw = String(datetime).trim();
  if (!raw) return null;

  // Beberapa source pakai "YYYY-MM-DD HH:mm:ss" (tanpa "T")
  const normalizedBase = raw.replace(
    /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}(?::\d{2})?)$/,
    "$1T$2",
  );
  const hasTimezone = /([zZ]|[+-]\d{2}:\d{2})$/.test(normalizedBase);

  const candidates = hasTimezone
    ? [new Date(normalizedBase)]
    : [new Date(normalizedBase), new Date(`${normalizedBase}+07:00`)];

  const valid = candidates.filter((d) => !Number.isNaN(d.getTime()));
  if (!valid.length) return null;
  if (valid.length === 1) return valid[0];

  // Pilih kandidat paling masuk akal terhadap "sekarang"
  const now = Date.now();
  const notTooFuture = valid.filter((d) => d.getTime() <= now + 10 * 60 * 1000);
  const pool = notTooFuture.length ? notTooFuture : valid;

  return pool.sort(
    (a, b) => Math.abs(now - a.getTime()) - Math.abs(now - b.getTime()),
  )[0];
}

function parseRelativeTimeText(raw) {
  if (!raw) return null;
  const text = String(raw).toLowerCase().trim();
  const m = text.match(/(\d+)\s*(hour|hours|day|days|jam|hari)/);
  if (!m) return null;

  const amount = Number.parseInt(m[1], 10);
  if (Number.isNaN(amount)) return null;

  const unit = m[2];
  const hours =
    unit.startsWith("day") || unit === "hari"
      ? amount * 24
      : amount;

  return new Date(Date.now() - hours * 3600 * 1000);
}

function parseLooseRelativeTime(raw) {
  if (!raw) return null;
  const text = String(raw).toLowerCase().trim();
  const m = text.match(
    /(\d+)\s*(minute|minutes|min|menit|hour|hours|jam|day|days|hari|week|weeks|minggu)/,
  );
  if (!m) return null;

  const amount = Number.parseInt(m[1], 10);
  if (Number.isNaN(amount)) return null;

  const unit = m[2];
  let minutes = amount;

  if (unit === "hour" || unit === "hours" || unit === "jam") {
    minutes = amount * 60;
  } else if (unit === "day" || unit === "days" || unit === "hari") {
    minutes = amount * 60 * 24;
  } else if (unit === "week" || unit === "weeks" || unit === "minggu") {
    minutes = amount * 60 * 24 * 7;
  }

  return new Date(Date.now() - minutes * 60 * 1000);
}

function isValidDate(value) {
  return value instanceof Date && Number.isFinite(value.getTime());
}

export const STATUS_EMOJI = {
  Ongoing: "🟢",
  Completed: "🔵",
  Hiatus: "🟡",
  Unknown: "⚪",
};

export const getStatusColor = (status) =>
  ({
    Ongoing: 0x22c55e,
    Completed: 0x3b82f6,
    Hiatus: 0xf59e0b,
    Unknown: 0x6b7280,
  })[status] ?? 0x6b7280;

// ─── CORE FUNCTIONS ───────────────────────────────────────────────────────────

export async function sendErrorLog(webhookUrl, error, context = "") {
  try {
    await axios.post(webhookUrl, {
      embeds: [
        {
          title: "❌ Bot Error",
          description: `\`\`\`${error.message || error}\`\`\``,
          color: 0xff0000,
          fields: [
            { name: "Context", value: context || "Unknown", inline: true },
            { name: "Time", value: new Date().toISOString(), inline: true },
          ],
          timestamp: new Date().toISOString(),
        },
      ],
    });
  } catch (err) {
    console.error("[sendErrorLog] Failed to send error log:", err.message);
  }
}

export async function fetchDescription(mangaUrl, redis = null) {
  if (!mangaUrl) return null;

  const cacheKey = `desc:${mangaUrl}`;

  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return cached;
    } catch (err) {
      console.warn("[fetchDescription] Redis get failed:", err.message);
    }
  }

  try {
    const res = await scrapeWithHeaders(mangaUrl, redis, { timeout: 8000 });
    const $ = cheerio.load(res.data);

    let desc =
      $('meta[name="description"]').attr("content") ||
      $(".description, .summary, [class*='description']").first().text().trim();

    desc = desc?.length > 300 ? desc.substring(0, 297) + "..." : desc;

    if (redis && desc) {
      await redis
        .set(cacheKey, desc, { ex: 1800 })
        .catch((err) =>
          console.warn("[fetchDescription] Redis set failed:", err.message),
        );
    }

    return desc || null;
  } catch (err) {
    console.warn(`[fetchDescription] Failed for ${mangaUrl}:`, err.message);
    return null;
  }
}

// ─── MAIN SCRAPER ─────────────────────────────────────────────────────────────

/**
 * Parse satu halaman latest-update.
 * Mengembalikan results dalam 24 jam terakhir dan flag apakah
 * sudah menemukan chapter yang lebih lama dari 24 jam.
 */
function parsePage($, seen) {
  const results = [];
  let foundOlderThan24h = false;

  $("#search-results")
    .children()
    .each((_, card) => {
      const $card = $(card);
      const $vertical = $card.children("div").first();
      if (!$vertical.length) return;

      const title = $vertical.find("h1").first().text().trim();
      if (!title) return;

      const mangaUrl = toAbsoluteUrl(
        $vertical.find("a[href*='/manga/']").first().attr("href"),
      );

      const rawCover = $vertical.find("img").first().attr("src");
      const cover = cleanImageUrl(toAbsoluteUrl(rawCover));

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
          return; // skip chapter ini, tapi lanjutkan iterasi
        }

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

  return { results, foundOlderThan24h };
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

    // Scan semua chapter row dan ambil timestamp paling baru.
    $("li:has(a[href*='/chapter-']), .eplister li, .clstyle li, .chapters li").each(
      (_, el) => {
        const $row = $(el);
        const href = $row.find("a[href*='/chapter-']").first().attr("href");
        const chapterUrl = resolveChapterUrl(href, mangaUrl);
        if (chapterUrl && !chapterUrls.includes(chapterUrl)) {
          chapterUrls.push(chapterUrl);
        }

        const raw =
          $row.find("time[datetime]").first().attr("datetime") ||
          $row.find("time").first().text().trim() ||
          $row
            .find(".text-gray-500, .text-xs, .date, .chapter-date, .chapterdate")
            .first()
            .text()
            .trim() ||
          null;

        const parsed =
          parseIkiruDatetime(raw) ||
          parseLooseRelativeTime(raw) ||
          parseRelativeTimeText(raw);
        if (isValidDate(parsed)) {
          chapterCandidates.push(parsed);
        }
      },
    );

    // Fallback: beberapa tema pakai anchor tanpa li pembungkus.
    $("a[href*='/chapter-']").each((_, el) => {
      const $el = $(el);
      const chapterUrl = resolveChapterUrl($el.attr("href"), mangaUrl);
      if (chapterUrl && !chapterUrls.includes(chapterUrl)) {
        chapterUrls.push(chapterUrl);
      }
    });

    // Fallback utama untuk layout baru Ikiru:
    // "Last Updates: 10 days ago" ada di info panel, bukan list chapter statis.
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
      if (isValidDate(parsedLastUpdates)) {
        chapterCandidates.push(parsedLastUpdates);
      }
    }

    // Fallback tambahan: dateModified biasanya lebih baru daripada publish manga.
    if (!chapterCandidates.length) {
      const rawModified =
        $("time[itemprop='dateModified']").attr("datetime") ||
        $("meta[property='article:modified_time']").attr("content") ||
        $("meta[property='og:updated_time']").attr("content") ||
        null;
      const parsedModified = parseIkiruDatetime(rawModified);
      if (isValidDate(parsedModified)) {
        chapterCandidates.push(parsedModified);
      }
    }

    // Fallback prioritas: buka halaman chapter terbaru dan ambil publish time chapter.
    if (!chapterCandidates.length && chapterUrls.length) {
      const latestChapterUrl = chapterUrls[0];
      try {
        const chapterRes = await scrapeWithHeaders(latestChapterUrl, redis, {
          timeout: 10000,
        });
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
        if (isValidDate(parsedChapter)) {
          chapterCandidates.push(parsedChapter);
        }
      } catch (err) {
        console.warn(
          `[fetchLatestMangaUpdateTime] Chapter fallback failed for ${latestChapterUrl}:`,
          err.message,
        );
      }
    }

    // Fallback terbatas terakhir: ambil time umum halaman manga.
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
      ? chapterCandidates
          .filter(isValidDate)
          .sort((a, b) => b.getTime() - a.getTime())[0]
      : null;
    const iso = latest?.toISOString() || null;

    if (redis && iso) {
      await redis
        .set(cacheKey, iso, { ex: 60 * 60 * 6 })
        .catch((err) =>
          console.warn("[fetchLatestMangaUpdateTime] Redis set failed:", err.message),
        );
    }

    return iso;
  } catch (err) {
    console.warn(`[fetchLatestMangaUpdateTime] Failed for ${mangaUrl}:`, err.message);
    return null;
  }
}

function normalizeSource(source) {
  const s = String(source || "").toLowerCase().trim();
  if (s === "mirror" || s === "shinigami_mirror") return "shinigami_mirror";
  if (s === "shinigami" || s === "project" || s === "shinigami_project") {
    return "shinigami_project";
  }
  return "ikiru";
}

function getShngmType(source) {
  return normalizeSource(source) === "shinigami_mirror" ? "mirror" : "project";
}

async function scrapeSecondarySourceUpdates(source = "shinigami") {
  if (!SECONDARY_SOURCE_URL) return [];

  try {
    const apiBase = SECONDARY_SOURCE_URL.replace(/\/+$/, "");
    const normalized = normalizeSource(source);
    const type = getShngmType(normalized);
    const endpoint = `${apiBase}/v1/manga/list?type=${type}&page=1&page_size=40&is_update=true&sort=latest&sort_order=desc`;

    const res = await withRetry(() =>
      axios.get(endpoint, {
        headers: {
          Accept: "application/json",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
        timeout: 10000,
      }),
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
    const seen = new Set();
    for (const row of rows) {
      const title = String(row?.title || "").trim();
      if (!title) continue;

      const mangaId = row?.manga_id;
      const chapterId = row?.latest_chapter_id;
      if (!mangaId || !chapterId) continue;

      const mangaUrl = `${SECONDARY_PUBLIC_BASE}/series/${mangaId}`;
      const chapterUrl = `${SECONDARY_PUBLIC_BASE}/chapter/${chapterId}`;

      const chapterValue = row?.latest_chapter_number;
      const chapterText = String(chapterValue).trim();
      const chapter = /chapter/i.test(chapterText)
        ? chapterText
        : chapterText
          ? `Chapter ${chapterText}`
          : "";
      if (!chapter) continue;

      const updatedRaw = row?.latest_chapter_time || row?.updated_at;
      const parsedTime =
        parseIkiruDatetime(updatedRaw) || parseLooseRelativeTime(updatedRaw);
      if (!parsedTime) continue;

      const diffHours = (Date.now() - parsedTime.getTime()) / 3600000;
      if (diffHours > 24) continue;

      const cover = row?.cover_image_url || row?.cover_portrait_url || null;

      const key = `${chapterUrl.toLowerCase().trim()}`;
      if (seen.has(key)) continue;
      seen.add(key);

      results.push({
        title,
        chapter,
        url: chapterUrl,
        cover,
        mangaUrl: mangaUrl || chapterUrl,
        rating: row?.user_rate ? String(row.user_rate) : "N/A",
        status: row?.status === 1 ? "Ongoing" : "Unknown",
        updatedTime: parsedTime.toISOString(),
        source: normalized,
      });
    }

    return results;
  } catch (err) {
    console.warn("[scrapeSecondarySourceUpdates] Failed:", err.message);
    return [];
  }
}

export async function scrapeMangaUpdates(redis = null) {
  try {
    const allResults = [];
    const seen = new Set();
    const MAX_PAGES = 10;
    let stalePageStreak = 0;

    const cookie = await getCookie(redis);
    console.log(
      cookie
        ? "🍪 Scraping with cookie (realtime mode)"
        : "⚠️ Scraping without cookie (cached mode) — set IKIRU_EMAIL/PASSWORD for realtime",
    );

    for (let page = 1; page <= MAX_PAGES; page++) {
      const url =
        page === 1 ? LATEST_URL : `${LATEST_URL}?the_page=${page}`;

      let res;
      try {
        res = await scrapeWithHeaders(url, redis);
      } catch (err) {
        console.error(`[scrapeMangaUpdates] Page ${page} fetch failed:`, err.message);
        break;
      }

      const $ = cheerio.load(res.data);
      const { results, foundOlderThan24h } = parsePage($, seen);

      allResults.push(...results);
      console.log(`🔍 Page ${page}: ${results.length} items`);

      // Jangan berhenti hanya karena ada item lama di halaman ini.
      // Banyak kasus halaman masih campuran (ada <24h dan >24h) atau update baru pindah ke page berikutnya.
      if (results.length === 0) {
        stalePageStreak += foundOlderThan24h ? 1 : 0;
      } else {
        stalePageStreak = 0;
      }

      // Berhenti setelah 2 halaman berturut-turut tidak memberi hasil baru dan indikasi sudah stale.
      if (stalePageStreak >= 2) break;
    }

    const [shinigamiResults, mirrorResults] = await Promise.all([
      scrapeSecondarySourceUpdates("shinigami_project"),
      scrapeSecondarySourceUpdates("shinigami_mirror"),
    ]);
    if (shinigamiResults.length || mirrorResults.length) {
      allResults.push(...shinigamiResults, ...mirrorResults);
      console.log(
        `Secondary source: shinigami=${shinigamiResults.length}, mirror=${mirrorResults.length}`,
      );
    }

    const deduped = [];
    const seenChapterUrls = new Set();
    for (const item of allResults) {
      const chapterKey = String(item.url || "")
        .replace(/\/+$/, "")
        .toLowerCase()
        .trim();
      if (!chapterKey || seenChapterUrls.has(chapterKey)) continue;
      seenChapterUrls.add(chapterKey);
      deduped.push(item);
    }

    deduped.sort((a, b) => {
      const ta = parseIkiruDatetime(a.updatedTime)?.getTime() ?? 0;
      const tb = parseIkiruDatetime(b.updatedTime)?.getTime() ?? 0;
      return tb - ta;
    });

    console.log(`✅ Total scraped: ${deduped.length} items`);
    return deduped;
  } catch (err) {
    console.error("[scrapeMangaUpdates] Fatal error:", err.message);
    return [];
  }
}

// ─── POPULAR ──────────────────────────────────────────────────────────────────

export async function scrapePopular() {
  try {
    const res = await scrapeWithHeaders(SITE_URL, null);
    const $ = cheerio.load(res.data);
    const results = [];
    const seen = new Set();

    $(
      ".swiper-slide a[href*='/manga/'], [class*='slide'] a[href*='/manga/']",
    ).each((_, el) => {
      const $el = $(el);
      const title = $el.attr("title") || $el.find("h4").text().trim();
      const link = $el.attr("href");
      const cover = $el.find("img").first().attr("src");

      if (!title || !link || seen.has(title)) return;
      seen.add(title);

      results.push({
        title,
        url: toAbsoluteUrl(link),
        cover: cleanImageUrl(toAbsoluteUrl(cover)),
        rating: $el.find(".rating, .details p").text().trim() || "N/A",
      });
    });

    return results.slice(0, 10);
  } catch (err) {
    console.error("[scrapePopular] Failed:", err.message);
    return [];
  }
}

// ─── ADVANCED SEARCH ──────────────────────────────────────────────────────────

const NONCE_PATTERNS = [
  /search_nonce["'\s:=]+([a-f0-9]{10})/,
  /nonce=([a-f0-9]{10})/,
  /["']nonce["']\s*:\s*["']([a-f0-9]{10})["']/,
];
const NONCE_TTL_MS = 5 * 60 * 1000;
let nonceCache = { value: null, expiresAt: 0 };

/** Whitelist parameter yang boleh dikirim ke AJAX search */
const ALLOWED_SEARCH_OPTS = ["genre", "status", "type", "order"];

async function fetchNonce() {
  if (nonceCache.value && nonceCache.expiresAt > Date.now()) {
    return nonceCache.value;
  }

  const urls = [
    SITE_URL + "advanced-search/",
    SITE_URL + "manga/",
    SITE_URL,
  ];

  for (const url of urls) {
    try {
      const res = await scrapeWithHeaders(url, null, {
        extraHeaders: { Accept: "text/html" },
        timeout: 8000,
      });
      for (const pattern of NONCE_PATTERNS) {
        const match = res.data.match(pattern);
        if (match) {
          console.log(`✅ Nonce found at: ${url}`);
          nonceCache = {
            value: match[1],
            expiresAt: Date.now() + NONCE_TTL_MS,
          };
          return nonceCache.value;
        }
      }
      console.warn(`[fetchNonce] No nonce matched at: ${url}`);
    } catch (err) {
      console.warn(`[fetchNonce] Failed for ${url}:`, err.message);
    }
  }

  throw new Error("Nonce not found in any URL");
}

/**
 * Parse HTML hasil AJAX advanced search menggunakan cheerio
 * agar lebih robust dibanding string splitting.
 */
function parseAdvancedSearchHTML(html) {
  if (!html || html.includes("No results found")) return [];

  const $ = cheerio.load(html);
  const results = [];
  const seenSlugs = new Set();

  // Tiap item manga adalah card dengan class flex + rounded-lg
  $(".flex.rounded-lg.overflow-hidden").each((_, el) => {
    const $el = $(el);

    // URL & slug dari link gambar
    const $imgLink = $el.find("a[href*='/manga/']").first();
    const url = $imgLink.attr("href");
    if (!url) return;

    const slugMatch = /\/manga\/([^/]+)\/?$/.exec(url);
    const slug = slugMatch ? slugMatch[1] : null;
    if (!slug || seenSlugs.has(slug)) return;
    seenSlugs.add(slug);

    // Title dari alt gambar atau fallback ke slug
    const rawTitle =
      $imgLink.find("img").attr("alt") ||
      slug.replace(/-/g, " ");
    const title = rawTitle.replace(/&#(\d+);/g, (_, n) =>
      String.fromCharCode(n),
    );

    // Cover — bersihkan suffix ukuran WP
    const rawCover = $imgLink.find("img").attr("src") || null;
    const cover = cleanImageUrl(rawCover);

    // Chapter terbaru
    const chapterText = $el.find("a[href*='/chapter-'] p").first().text().trim();
    const chapter = chapterText || null;

    const rawUpdated =
      $el.find("time[datetime]").first().attr("datetime") ||
      $el.find("time").first().text().trim() ||
      $el
        .find("a[href*='/chapter-'] .text-gray-500, a[href*='/chapter-'] .text-xs")
        .first()
        .text()
        .trim() ||
      null;
    const parsedUpdated =
      parseIkiruDatetime(rawUpdated) || parseLooseRelativeTime(rawUpdated);
    const updatedTime = parsedUpdated?.toISOString() || null;

    // Rating
    const rating = $el.find(".numscore").first().text().trim() || null;

    results.push({
      title,
      url:      toAbsoluteUrl(url), // tetap ada untuk backward compat
      mangaUrl: toAbsoluteUrl(url), // konsisten dengan scrapeMangaUpdates
      slug,
      cover,
      chapter,
      rating,
      updatedTime,
    });
  });

  return results;
}

export async function scrapeMangaCover(mangaUrl, redis = null) {
  try {
    const res = await scrapeWithHeaders(mangaUrl, redis);
    const $ = cheerio.load(res.data);

    const rawCover = $(".summary_image img, .thumb img, img.wp-post-image")
      .first()
      .attr("src");

    return cleanImageUrl(toAbsoluteUrl(rawCover)) || null;
  } catch (err) {
    console.warn(`[scrapeMangaCover] Failed for ${mangaUrl}:`, err.message);
    return null;
  }
}

export async function searchIkiru(keyword, opts = {}, redis = null) {
  const safeOpts = Object.fromEntries(
    Object.entries(opts).filter(([k]) => ALLOWED_SEARCH_OPTS.includes(k)),
  );

  const cacheKey = `cache:search:${keyword}:${JSON.stringify(safeOpts)}`;

  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (Array.isArray(cached)) {
        console.log(`⚡ Cache hit "${keyword}": ${cached.length} results`);
        return cached;
      }
    } catch (err) {
      console.warn("[searchIkiru] Redis get failed:", err.message);
    }
  }

  try {
    const nonce = await fetchNonce();
    const params = new URLSearchParams({
      action: "advanced_search",
      search_nonce: nonce,
      query: keyword,
      ...safeOpts,
    });

    const headers = await baseHeaders(redis, {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: `${SITE_URL}advanced-search/`,
      "X-Requested-With": "XMLHttpRequest",
    });

    const res = await withRetry(() =>
      axios.post(`${SITE_URL}${AJAX_PATH}`, params, {
        headers,
        timeout: 15000,
      }),
    );

    const rawHtml =
      typeof res.data === "string" ? res.data : JSON.stringify(res.data);
    const results = parseAdvancedSearchHTML(rawHtml);

    if (redis && results.length > 0) {
      await redis
        .set(cacheKey, results, { ex: 600 })
        .catch((err) =>
          console.warn("[searchIkiru] Redis set failed:", err.message),
        );
    }

    console.log(`✅ Search "${keyword}": ${results.length} results`);
    return results;
  } catch (err) {
    console.error(`[searchIkiru] Search failed for "${keyword}":`, err.message);
    return [];
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
  const MAX_PAGE = 4;

  for (let page = 1; page <= MAX_PAGE; page++) {
    try {
      const endpoint = `${apiBase}/v1/manga/list?type=${type}&page=${page}&page_size=40&sort=latest&sort_order=desc`;
      const res = await axios.get(endpoint, {
        headers: {
          Accept: "application/json",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
        timeout: 10000,
      });

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

        const mangaId = row?.manga_id;
        const mangaUrl = mangaId
          ? `${SECONDARY_PUBLIC_BASE}/series/${mangaId}`
          : null;
        if (!mangaUrl) continue;

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
          source: normalized,
        });
      }
    } catch {
      break;
    }
  }

  return results.slice(0, 50);
}
