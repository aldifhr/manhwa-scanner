/**
 * Scraping and provider types
 */

import { z } from "zod";
import {
  ChapterItemSchema,
  ScraperMetricsSchema,
  SourceStateSchema,
  SourceHealthSchema,
  SecondaryMangaRowSchema,
  SecondaryApiResponseSchema,
  ProviderErrorCodeSchema,
  ProviderErrorSchema,
  MangaMetadataSchema,
  TimingMetricsSchema,
  SkipBreakdownSchema,
} from "../schemas.js";
import type { AdaptiveRateLimiter } from "../utils/adaptive-rate-limiter.js";

/**
 * Represents a single chapter update found by a scraper
 */
export type ChapterItem = z.infer<typeof ChapterItemSchema>;

/**
 * Metrics collected during a scraper run
 */
export type ScraperMetrics = z.infer<typeof ScraperMetricsSchema>;

/**
 * Execution state of a single source during orchestration
 */
export type SourceState = z.infer<typeof SourceStateSchema>;

/**
 * Persistent health state for a single source
 */
export type SourceHealth = z.infer<typeof SourceHealthSchema>;

/**
 * Raw data row from secondary providers (Shinigami, etc.)
 */
export type SecondaryMangaRow = z.infer<typeof SecondaryMangaRowSchema>;

/**
 * Generic envelope for secondary API responses
 */
export type SecondaryApiResponse<T = unknown> = z.infer<typeof SecondaryApiResponseSchema> & {
  data?: T;
  result?: T;
  items?: T;
};

/**
 * Valid codes for provider errors
 */
export type ProviderErrorCode = z.infer<typeof ProviderErrorCodeSchema>;

/**
 * Standardized error object for providers
 */
export type ProviderError = z.infer<typeof ProviderErrorSchema>;

/**
 * Detailed metadata for a manga, cached in Redis
 */
export type MangaMetadata = z.infer<typeof MangaMetadataSchema>;

/**
 * Detailed metrics for execution phases
 */
export type TimingMetrics = z.infer<typeof TimingMetricsSchema>;

/**
 * Breakdown of skipped items during scraping
 */
export type SkipBreakdown = z.infer<typeof SkipBreakdownSchema>;

/**
 * Standardized result envelope for providers
 */
export interface ProviderResult<T> {
  success: boolean;
  data?: T;
  error?: ProviderError;
}

/**
 * Options for HTTP request retry logic
 * Consolidated from httpClient.ts and scrapers/shared.ts
 * NOTE: This is the canonical definition. httpClient.ts should import from here.
 */
export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterMs?: number;
  deadline?: number;
  onRetry?: (err: unknown, attempt: number, delayMs?: number) => void;
  retryStatuses?: Set<number>;
  adaptive?: boolean;
  rateLimiter?: AdaptiveRateLimiter;
  [key: string]: unknown;
}

/**
 * Options for HTTP scraping operations
 * Renamed from ScrapeOptions in scrapers/shared.ts to avoid conflict
 */
export interface HttpScrapeOptions {
  extraHeaders?: Record<string, string>;
  source?: string;
  timeout?: number;
  retries?: number;
  deadline?: number;
  [key: string]: unknown;
}

/**
 * Options for scrape preference matching
 * Renamed from ScrapeOptions in services/scrapePreferences.ts
 */
export interface PreferenceScrapeOptions {
  preferredIkiru: {
    titles: string[];
    urls: string[];
  };
  preferredIkiruTitles: string[];
  preferredSecondaryTitles: Record<string, string[]>;
  preferredSecondaryUrls: Record<string, string[]>;
  preferredSecondaryEntries: Record<string, { title: string; url: string }[]>;
  [key: string]: unknown;
}

/**
 * Interface for all manga scraper providers
 */
export interface ScraperProvider {
  readonly name: string;
  
  /**
   * Scrape latest updates from the source
   */
  scrapeLatest(options: {
    redis?: any;
    preferred?: any;
    logger?: any;
    deadline?: number;
    force?: boolean;
    fullRefresh?: boolean;
    skipExpansion?: boolean;
  }): Promise<{ results: ChapterItem[]; state: SourceState }>;

  /**
   * Search for manga by title
   */
  search(query: string, options?: {
    redis?: any;
    deadline?: number;
  }): Promise<ProviderResult<ChapterItem[]>>;

  /**
   * Fetch detailed metadata for a specific manga
   */
  fetchMetadata(mangaUrl: string, options?: {
    redis?: any;
    deadline?: number;
    mangaId?: string | number;
  }): Promise<Partial<MangaMetadata> | null>;
}
