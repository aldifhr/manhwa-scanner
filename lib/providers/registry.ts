import { MangaProvider } from "./base.js";
import { ChapterItem, RedisClient, ProviderResult } from "../types.js";
import { getLogger } from "../logger.js";

const logger = getLogger({ scope: "provider-registry" });

/**
 * Central registry for all Manga Providers
 */
class ProviderRegistry {
  private providers: Map<string, MangaProvider> = new Map();

  /**
   * Register a new provider
   */
  register(provider: MangaProvider) {
    if (this.providers.has(provider.id)) {
      return;
    }
    this.providers.set(provider.id, provider);
    logger.info({ providerId: provider.id, displayName: provider.displayName }, "Provider registered");
  }

  /**
   * Get a specific provider by ID
   */
  getProvider(id: string): MangaProvider | undefined {
    return this.providers.get(id);
  }

  /**
   * Get all registered providers, sorted by priority
   */
  getAllProviders(): MangaProvider[] {
    return Array.from(this.providers.values()).sort((a, b) => b.priority - a.priority);
  }

  /**
   * Search across all providers simultaneously
   */
  async searchAll(query: string, redis: RedisClient | null): Promise<ChapterItem[]> {
    const providers = this.getAllProviders();
    const results = await Promise.allSettled(
      providers.map(p => p.search(query, redis))
    );

    const items: ChapterItem[] = [];
    results.forEach((res, index) => {
      const provider = providers[index];
      if (res.status === "fulfilled") {
        const result = res.value;
        if (result.success && Array.isArray(result.data)) {
          // Tag results with their source if not already tagged
          const providerItems = result.data.map(item => ({
            ...item,
            source: item.source || provider.id
          }));
          items.push(...providerItems);
        }
      }
    });

    // Deduplicate by title + source
    const seen = new Set<string>();
    return items.filter(item => {
      const key = `${item.title.toLowerCase().trim()}_${item.source}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * Resolve a URL to manga info by finding the appropriate provider
   */
  async resolveUrl(url: string): Promise<ProviderResult<{ title: string | null; source: string | null }>> {
    const providers = this.getAllProviders();
    const provider = providers.find(p => p.canHandleUrl(url));

    if (!provider) {
      return {
        success: false,
        error: {
          message: "Domain atau format URL tidak didukung oleh provider manapun.",
          source: "registry",
          code: "UNSUPPORTED_DOMAIN"
        }
      };
    }

    try {
      const result = await provider.resolveUrl(url);
      if (result.success) {
        // Use detected source from provider if available, otherwise fallback to provider.id
        const detectedSource = result.data?.source || provider.id;
        return {
          success: true,
          data: {
            title: result.data?.title || null,
            source: detectedSource
          }
        };
      }
      return {
        success: false,
        error: result.error || {
          message: "Provider returned failure",
          source: provider.id,
          code: "PROVIDER_ERROR"
        }
      };
    } catch (err) {
      return {
        success: false,
        error: {
          message: `Gagal memproses URL: ${err instanceof Error ? err.message : String(err)}`,
          source: provider.id,
          code: "PROVIDER_ERROR"
        }
      };
    }
  }
}

// Singleton instance
export const mangaProviderRegistry = new ProviderRegistry();
