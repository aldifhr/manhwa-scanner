import { 
  ChapterItem, 
  RedisClient, 
  ProviderResult, 
  MangaMetadata,
  SourceState
} from "../types.js";

/**
 * Unified interface for a Manga Source Provider.
 * Combines search, URL resolution, and scraping capabilities.
 */
export interface MangaProvider {
  /** Unique identifier for the provider (e.g., 'ikiru', 'shinigami') */
  id: string;
  
  /** Human-readable name */
  displayName: string;
  
  /** Priority for URL resolution (higher is checked first) */
  priority: number;

  /**
   * Initialize the provider (e.g., load metrics from Redis)
   */
  initialize?(redis: RedisClient): Promise<void>;

  /**
   * Search for manga by title query
   */
  search(query: string, redis: RedisClient | null): Promise<ProviderResult<ChapterItem[]>>;

  /**
   * Check if this provider can handle a specific URL
   */
  canHandleUrl(url: string): boolean;

  /**
   * Resolve a URL into standardized manga info
   */
  resolveUrl(url: string): Promise<ProviderResult<{ title: string | null; source?: string; metadata?: MangaMetadata }>>;

  /**
   * Scrape recent updates from the provider
   */
  scrapeUpdates(options: {
    redis: RedisClient | null;
    preferredMatcher?: any;
    logger?: any;
    force?: boolean;
    fullRefresh?: boolean;
    skipExpansion?: boolean;
    deadline?: number;
  }): Promise<{ results: ChapterItem[]; state: SourceState }>;

  /**
   * Optional: Fetch detailed metadata for a specific manga
   */
  fetchMetadata?(url: string, redis: RedisClient | null): Promise<MangaMetadata | null>;

  /**
   * Get latest performance metrics for this provider
   */
  getMetrics?(): {
    avgResponseTimeMs: number;
    lastSuccessAt: string | null;
    totalScrapes: number;
    successRate: number;
  };
}
