/**
 * ADD FROM URL SERVICE
 * Tambahkan manga langsung dari URL tanpa pencarian.
 * Deteksi sumber dari domain, scrape judul dari halaman.
 */

import * as cheerio from "cheerio";
import { httpGet } from "../httpClient.js";
import { HTTP_USER_AGENT } from "../scrapers/shared.js";

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
  const res = await httpGet(
    url,
    { headers: { "User-Agent": HTTP_USER_AGENT }, timeout: 12000 },
    { retries: 2, baseDelayMs: 500 },
  );
  const html = typeof res?.data === "string" ? res.data : null;
  if (!html) return null;

  const $ = cheerio.load(html);

  const selectors = [
    "h1.text-xl",
    "h1.title",
    ".series-title h1",
    "h1",
  ];
  for (const sel of selectors) {
    const title = $(sel).first().text().trim();
    if (title) return title;
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
