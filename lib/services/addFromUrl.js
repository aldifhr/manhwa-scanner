/**
 * ADD FROM URL SERVICE
 * Tambahkan manga langsung dari URL tanpa pencarian.
 * Deteksi sumber dari domain, scrape judul dari halaman.
 */

import * as cheerio from "cheerio";
import { httpGet } from "../httpClient.js";
import { HTTP_USER_AGENT, SECONDARY_SOURCE_URL } from "../scrapers/shared.js";

const DOMAIN_SOURCE_MAP = [
  { pattern: /ikiru\.wtf/i,          source: "ikiru" },
  { pattern: /shinigami-id\.com/i,   source: "shinigami_project" },
  { pattern: /shinigami\.moe/i,      source: "shinigami_project" },
  { pattern: /shinigami\.asia/i,     source: "shinigami_project" },
  { pattern: /shinigami\.ink/i,      source: "shinigami_mirror" },
  { pattern: /komikcast/i,           source: "ikiru" },
];

/**
 * Deteksi sumber dari URL.
 * @returns {string|null} source key atau null jika tidak dikenal
 */
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

/**
 * Scrape judul manga dari halaman Ikiru.
 */
async function scrapeIkiruTitle(url) {
  const res = await httpGet(
    url,
    { headers: { "User-Agent": HTTP_USER_AGENT }, timeout: 12000 },
    { retries: 2, baseDelayMs: 500 },
  );
  const html = typeof res?.data === "string" ? res.data : null;
  if (!html) return null;

  const $ = cheerio.load(html);

  // Coba berbagai selector judul di Ikiru
  const selectors = [
    "h1.entry-title",
    ".post-title h1",
    "h1.manga-title",
    "h1",
  ];
  for (const sel of selectors) {
    const title = $(sel).first().text().trim();
    if (title) return title;
  }
  return null;
}

/**
 * Scrape judul manga dari halaman Shinigami (HTML).
 */
async function scrapeShingmTitle(url) {
  // Attempt to hit the Shinigami API directly if URL contains a UUID (bypass Cloudflare 403)
  const uuidMatch = url.match(/\/(?:series|manga|komik)\/([a-f0-9-]{36})/i);
  if (uuidMatch && uuidMatch[1]) {
    try {
      const apiRes = await httpGet(`${SECONDARY_SOURCE_URL.replace(/\/+$/, "")}/v1/manga/detail/${uuidMatch[1]}`, {
        headers: { "User-Agent": HTTP_USER_AGENT, "Accept": "application/json" },
        timeout: 10000
      });
      const apiTitle = apiRes?.data?.data?.title || apiRes?.data?.result?.title;
      if (apiTitle) return String(apiTitle).trim();
    } catch (err) {
      console.warn(`[scrapeShingmTitle] API fallback failed for ${uuidMatch[1]}:`, err.message);
    }
  }

  // Fallback to HTML scraping if API fails or no UUID found
  try {
    const res = await httpGet(
      url,
      {
        headers: {
          "User-Agent": HTTP_USER_AGENT,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "none",
          "Sec-Fetch-User": "?1",
          "Upgrade-Insecure-Requests": "1",
        },
        timeout: 15000,
      },
      { retries: 2, baseDelayMs: 1000 },
    );

    if (res?.status === 403) {
      throw new Error("Akses diblokir oleh Cloudflare (403). Coba gunakan URL lain atau hubungi admin.");
    }

    const html = typeof res?.data === "string" ? res.data : null;
    if (!html) return null;

    const $ = cheerio.load(html);

    const selectors = [
      "h1.text-xl",
      "h1.title",
      "h1.post-title",
      ".series-title h1",
      "h1",
    ];
    for (const sel of selectors) {
      const title = $(sel).first().text().trim();
      if (title && title.length > 2 && !/shinigami/i.test(title) && title !== "undefined") {
        return title;
      }
    }

    // Fallback for SvelteKit/Nuxt client-rendered pages (JSON ld or script tags)
    const titleMatch = html.match(/"title":"([^\\"]+)"/g);
    if (titleMatch && titleMatch.length > 0) {
      for (const match of titleMatch) {
        const extracted = match.replace(/"title":"|"/g, "");
        if (
          extracted &&
          extracted.length > 2 &&
          !/shinigami/i.test(extracted) &&
          extracted !== "Home" &&
          extracted !== "undefined"
        ) {
          return extracted;
        }
      }
    }

    // Fallback regex for standard title tag
    const titleTagMatch = html.match(/<title[^>]*>(.*?)<\/title>/is);
    if (titleTagMatch && titleTagMatch[1]) {
      let t = titleTagMatch[1].trim();
      t = t.replace(/\s*-\s*Shinigami(\s*Scans|id|project|mirror)?.*$/i, "").trim();
      if (t && t.length > 2 && t !== "undefined") return t;
    }
  } catch (err) {
    if (err.message.includes("403")) throw err;
    console.warn(`[scrapeShingmTitle] HTML fallback failed for ${url}:`, err.message);
  }

  return null;
}

/**
 * Entry point: tambah manga dari URL langsung.
 * @returns {{ title: string|null, source: string|null, error: string|null }}
 */
export async function resolveAddFromUrl(url) {
  const cleanUrl = String(url || "").trim();
  if (!cleanUrl.startsWith("http")) {
    return { title: null, source: null, error: "URL tidak valid. Pastikan dimulai dengan http:// atau https://" };
  }

  const source = detectSourceFromUrl(cleanUrl);
  if (!source) {
    return {
      title: null,
      source: null,
      error: "Domain URL tidak dikenali. URL harus dari Ikiru, Shinigami Project, atau Shinigami Mirror.",
    };
  }

  let title = null;
  try {
    if (source === "ikiru") {
      title = await scrapeIkiruTitle(cleanUrl);
    } else {
      title = await scrapeShingmTitle(cleanUrl);
    }
  } catch (err) {
    return { title: null, source, error: `Gagal membaca halaman: ${err.message}` };
  }

  if (!title) {
    return { title: null, source, error: "Tidak dapat menemukan judul manga dari URL ini. Pastikan URL mengarah ke halaman series, bukan chapter." };
  }

  return { title, source, error: null };
}
