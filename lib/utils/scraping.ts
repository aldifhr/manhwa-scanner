/**
 * Common scraping utilities shared across providers
 */

import { parse } from "node-html-parser";
import { httpGet } from "../httpClient.js";
import { HTTP_USER_AGENT } from "../scrapers/shared.js";
import { getLogger } from "../logger.js";

const logger = getLogger({ scope: "scraping-utils" });

/**
 * Configuration for HTML title scraping
 */
export interface TitleScrapingConfig {
  /** URL to scrape */
  url: string;
  /** CSS selectors to try in order */
  selectors: string[];
  /** Fallback title if scraping fails */
  fallbackTitle?: string | null;
  /** Request timeout in milliseconds */
  timeout?: number;
  /** Number of retries */
  retries?: number;
  /** Additional headers */
  headers?: Record<string, string>;
}

/**
 * Result of title scraping operation
 */
export interface TitleScrapingResult {
  /** Extracted title or fallback */
  title: string | null;
  /** Error message if scraping failed */
  error?: string;
  /** Whether fallback was used */
  usedFallback: boolean;
}

/**
 * Generic HTML title scraper with fallback support
 * 
 * Attempts to extract title from HTML using provided CSS selectors.
 * Falls back to provided title if scraping fails.
 * 
 * @param config - Scraping configuration
 * @returns Scraping result with title and metadata
 */
export async function scrapeHtmlTitle(
  config: TitleScrapingConfig
): Promise<TitleScrapingResult> {
  const {
    url,
    selectors,
    fallbackTitle = null,
    timeout = 8000,
    retries = 1,
    headers = {},
  } = config;

  try {
    const res = await httpGet(
      url,
      {
        headers: {
          "User-Agent": HTTP_USER_AGENT,
          ...headers,
        },
        timeout,
      },
      { retries, baseDelayMs: 400 }
    );

    const html = typeof res?.data === "string" ? res.data : null;
    if (!html) {
      return {
        title: fallbackTitle,
        error: "Empty response",
        usedFallback: true,
      };
    }

    const root = parse(html);

    // Try each selector in order
    for (const selector of selectors) {
      const element = root.querySelector(selector);
      const title = element?.textContent?.trim();
      if (title) {
        return {
          title,
          error: undefined,
          usedFallback: false,
        };
      }
    }

    // No selector matched
    return {
      title: fallbackTitle,
      error: "No matching selector found",
      usedFallback: true,
    };
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.warn(
      { url, err: errorMessage },
      "HTML title scrape failed, using fallback"
    );

    return {
      title: fallbackTitle,
      error: errorMessage,
      usedFallback: true,
    };
  }
}

/**
 * Extract title from URL slug
 */
export function titleFromSlug(slug: string): string | null {
  if (!slug) return null;

  return slug
    .replace(/[-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter((word) => !/^\d+$/.test(word)) // Remove pure numbers
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Extract slug from URL path
 */
export function extractSlugFromUrl(
  url: string,
  pathSegment: string
): string | null {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const segmentIndex = parts.findIndex(
      (part) => part.toLowerCase() === pathSegment.toLowerCase()
    );

    if (segmentIndex >= 0 && segmentIndex < parts.length - 1) {
      return parts[segmentIndex + 1];
    }

    return null;
  } catch {
    return null;
  }
}
