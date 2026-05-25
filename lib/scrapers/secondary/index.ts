export * from "./types.js";
export * from "./api.js";
export * from "./parser.js";
export * from "./logic.js";
export * from "./orchestrator.js";

// Specialized metadata fetcher for providers
import { fetchSecondaryFullMangaInfo, API_BASE, searchShngm } from "./api.js";
import { normalizeText, pickSecondaryDescription } from "../shared.js";
import { getLogger } from "../../logger.js";
import { RedisClient, ScraperProvider } from "../../types.js";
import { scrapeSecondaryUpdatesWithMeta } from "./orchestrator.js";

const logger = getLogger({ scope: "secondary:index" });

export async function fetchSecondaryMetadata(_source: string, mangaId: string | number, _redis: RedisClient | null = null) {
  if (!mangaId) return null;
  try {
    const { raw: data } = await fetchSecondaryFullMangaInfo(API_BASE, mangaId, 0);

    const synopsis = normalizeText(data?.description ?? data?.synopsis ?? "");
    const rating = (data?.user_rate !== undefined && data?.user_rate !== null) ? String(data.user_rate) : "";

    const genres: string[] = [];
    const genreTaxonomy = (data as any)?.taxonomy?.Genre || (data as any)?.genres;
    if (Array.isArray(genreTaxonomy)) {
      genreTaxonomy.forEach((g: any) => {
        if (g.name) genres.push(g.name);
      });
    }

    const cover = data?.cover_portrait_url ?? data?.cover_image_url ?? (data as any)?.cover ?? (data as any)?.image ?? null;
    
    let status = "Unknown";
    const rawStatus = data?.status ?? (data as any)?.manga_status;
    if (rawStatus === 1 || rawStatus === "1") status = "Ongoing";
    else if (rawStatus === 2 || rawStatus === "2") status = "Completed";

    const title = normalizeText(String(data?.title ?? (data as any)?.name ?? ""));

    return { title, synopsis, genres, rating, cover, status };
  } catch (err: unknown) {
    const errMessage = err instanceof Error ? err.message : String(err);
    logger.warn({ err: errMessage, mangaId }, "Failed to fetch Secondary metadata");
    return null;
  }
}

/**
 * Standard Shinigami/Secondary Provider implementation
 */
export const SecondaryProvider: ScraperProvider = {
  name: "shinigami",

  async scrapeLatest(options: any) {
    return scrapeSecondaryUpdatesWithMeta(
      options.source || "shinigami",
      {
        redis: options.redis,
        preferredMatcher: options.preferred,
        options,
        deadline: options.deadline,
      }
    );
  },

  async search(query: string, options: any = {}) {
    return await searchShngm(query, options.source || "shinigami", options.deadline || 0);
  },

  async fetchMetadata(mangaUrl: string, options: any = {}) {
    return fetchSecondaryMetadata(
      "shinigami",
      options.mangaId || "",
      options.redis
    );
  }
};
