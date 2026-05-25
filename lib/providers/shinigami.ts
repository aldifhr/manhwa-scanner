import { httpGet } from "../httpClient.js";
import { HTTP_USER_AGENT, SECONDARY_SOURCE_URL } from "../scrapers/shared.js";
import { getLogger } from "../logger.js";
import { MangaProvider } from "./base.js";
import { 
  searchShngm, 
  scrapeSecondaryUpdatesWithMeta, 
  fetchSecondaryMetadata 
} from "../scrapers/secondary/index.js";
import { 
  ChapterItem, 
  RedisClient, 
  ProviderResult, 
  MangaMetadata, 
  SourceState 
} from "../types.js";
import { detectSource, extractShinigamiMangaId } from "../utils/shinigami-detector.js";
import { MetricsTracker } from "./metrics.js";

const logger = getLogger({ scope: "provider:shinigami" });
const shinigamiMetrics = new MetricsTracker();

async function scrapeShngmTitle(url: string): Promise<string | null> {
  const uuidMatch = url.match(/\/(?:series|manga|komik)\/([a-f0-9-]{36})/i);
  if (uuidMatch && uuidMatch[1]) {
    try {
      const apiRes = await httpGet(
        `${SECONDARY_SOURCE_URL.replace(/\/+$/, "")}/v1/manga/detail/${uuidMatch[1]}`,
        {
          headers: {
            "User-Agent": HTTP_USER_AGENT,
            Accept: "application/json",
          },
          timeout: 8000,
        },
      );
      const apiTitle = apiRes?.data?.data?.title || apiRes?.data?.result?.title;
      if (apiTitle) return String(apiTitle).trim();
    } catch (err: unknown) {
      logger.debug(
        { uuid: uuidMatch[1], err: err instanceof Error ? err.message : String(err) },
        "UUID API failed (API-only mode)",
      );
      return null;
    }
  }
  return null;
}

export const shinigamiProvider: MangaProvider = {
  id: "shinigami",
  displayName: "Shinigami",
  priority: 25,

  async initialize(redis: RedisClient) {
    await shinigamiMetrics.load(redis, "shinigami");
  },

  async search(query: string, redis: RedisClient | null): Promise<ProviderResult<ChapterItem[]>> {
    return searchShngm(query, "shinigami");
  },

  canHandleUrl(url: string): boolean {
    const str = String(url || "").toLowerCase();
    return str.includes("shinigami") && /\/(series|manga|komik)\/[^/]+/i.test(str);
  },

  async resolveUrl(url: string): Promise<ProviderResult<{ title: string | null; source?: string; metadata?: MangaMetadata }>> {
    if (/\/chapter\b/i.test(url)) {
      return {
        success: false,
        error: {
          message: "URL Chapter Shinigami tidak diperbolehkan. Mohon masukkan URL halaman Series utama.",
          source: "shinigami"
        }
      };
    }

    const uuid = extractShinigamiMangaId(url);
    const isUuid = uuid && /^[a-f0-9-]{36}$/i.test(uuid);
    if (!isUuid || !uuid) {
      return {
        success: false,
        error: {
          message: "Format URL Shinigami tidak valid. Gunakan format `/series/<uuid-36-karakter>`",
          source: "shinigami"
        }
      };
    }

    // 1. Use the extremely fast API detail check
    try {
      const detection = await detectSource(uuid, { timeout: 4000, retries: 1 });
      if (detection.found && detection.title) {
        return {
          success: true,
          data: {
            title: detection.title,
            source: "shinigami"
          }
        };
      }
    } catch (err) {
      logger.warn({ uuid, err: err instanceof Error ? err.message : String(err) }, "Fast UUID detection failed");
    }

    // 2. Fallback to secondary title scrape
    const title = await scrapeShngmTitle(url);
    if (title) {
      return { success: true, data: { title, source: "shinigami" } };
    }

    return {
      success: false,
      error: {
        message: "Manga tidak ditemukan di Shinigami database.",
        source: "shinigami"
      }
    };
  },

  async scrapeUpdates(options: {
    redis: RedisClient | null;
    preferredMatcher?: any;
    logger?: any;
    force?: boolean;
    fullRefresh?: boolean;
    skipExpansion?: boolean;
    deadline?: number;
  }): Promise<{ results: ChapterItem[]; state: SourceState }> {
    const { redis, preferredMatcher, logger, ...rest } = options;
    const start = Date.now();

    try {
      const { results, state: catchState } = await scrapeSecondaryUpdatesWithMeta("shinigami", {
        preferredMatcher,
        redis,
        options: rest,
        deadline: rest.deadline
      });

      const duration = Date.now() - start;
      shinigamiMetrics.record(duration, catchState.status === "healthy");
      if (redis) shinigamiMetrics.persist(redis, "shinigami").catch(() => {});

      return { results, state: catchState };
    } catch (err) {
      shinigamiMetrics.record(Date.now() - start, false);
      throw err;
    }
  },

  async fetchMetadata(url: string, redis: RedisClient | null): Promise<MangaMetadata | null> {
    const match = url.match(/\/(?:series|manga|komik)\/([^/?#]+)/i);
    const mangaId = match ? match[1] : url;
    
    const raw = await fetchSecondaryMetadata("shinigami", mangaId, redis);
    if (!raw) return null;

    return {
      title: raw.title || "",
      source: "shinigami",
      url,
      cover: raw.cover,
      description: raw.synopsis,
      rating: raw.rating,
      status: raw.status,
      lastUpdated: new Date().toISOString(),
      genres: raw.genres
    };
  },

  getMetrics() {
    return shinigamiMetrics.getMetrics();
  }
};
