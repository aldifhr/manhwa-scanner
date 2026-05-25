import { getLogger } from "../../logger.js";
import { 
  SECONDARY_CONFIG 
} from "../../config.js";
import { httpGet } from "../../httpClient.js";
import { withRetry, HTTP_USER_AGENT, SECONDARY_SOURCE_URL } from "../shared.js";
import { detectAndHealRedirect } from "../../services/url/healing.js";
import { 
  SecondaryChapterRow,
  SecondaryFullInfo,
  isAxiosLikeResponse,
  isSecondaryApiData 
} from "./types.js";
import { 
  globalRequestDeduplicator, 
  globalScrapeCacheManager, 
  globalAdaptiveLimiter 
} from "../optimizer.js";
import { extractRows, extractDetailChaptersFromMangaDetail } from "./parser.js";
import { SecondaryMangaRow, ChapterItem, ProviderResult } from "../../types.js";
import { 
  normalizeSource, 
  normalizeTitleKey,
  normalizeSourceUrl,
  SECONDARY_PUBLIC_BASE 
} from "../shared.js";
import { parseDateWithFallback } from "../../dateUtils.js";

const logger = getLogger({ scope: "secondary:api" });
export const API_BASE = (SECONDARY_SOURCE_URL || "").replace(/\/+$/, "");

export const JSON_HEADERS = {
  Accept: "application/json",
  "User-Agent": HTTP_USER_AGENT,
};


export async function fetchWithRetry(
  endpoint: string,
  headers: Record<string, string>,
  timeout: number,
  deadline = 0,
): Promise<unknown> {
  // Add a small jitter/throttle to prevent 429s from aggressive WAFs
  if (endpoint.includes("shngm.io")) {
    const jitter = Math.floor(Math.random() * 150) + 50; // 50-200ms
    await new Promise(r => setTimeout(r, jitter));
  }

  const res = await withRetry(
    async () =>
      httpGet(endpoint, {
        headers,
        timeout: Math.max(timeout, 15000), // Ensure at least 15s for slow secondary APIs
      }),
    SECONDARY_CONFIG.MAX_RETRIES,
    { deadline },
  );

  if (res && (res as any).request) {
    await detectAndHealRedirect(endpoint, res as any);
  }

  return res;
}

export async function fetchChapterPage(
  apiBase: string, 
  mangaId: string | number, 
  page: number, 
  pageSize: number, 
  deadline = 0
): Promise<SecondaryChapterRow[]> {
  const endpoint = `${apiBase}/v1/chapter/${mangaId}/list?page=${page}&page_size=${pageSize}&sort_by=chapter_number&sort_order=desc`;

  const cacheKey = `shinigami:chapters:${mangaId}:${page}`;
  const cached = await globalScrapeCacheManager.get<SecondaryChapterRow[]>(cacheKey);
  if (cached) {
    return cached;
  }

  const requestStart = Date.now();
  
  try {
    const res = await globalRequestDeduplicator.dedupe(
      cacheKey,
      () => fetchWithRetry(
        endpoint,
        JSON_HEADERS,
        SECONDARY_CONFIG.REQUEST_TIMEOUT,
        deadline,
      ),
      { useCache: true, cacheTTL: 30000 }
    );

    globalAdaptiveLimiter.recordSuccess(Date.now() - requestStart);

    if (!isAxiosLikeResponse(res)) {
      return [];
    }

    const rows = extractRows(res.data) as SecondaryChapterRow[];
    
    if (rows.length > 0) {
      await globalScrapeCacheManager.set(cacheKey, rows, 300);
    }

    return rows;
  } catch (err) {
    globalAdaptiveLimiter.recordError();
    throw err;
  }
}

export async function fetchSecondaryFullMangaInfo(
  apiBase: string, 
  mangaId: string | number, 
  deadline = 0
): Promise<SecondaryFullInfo> {
  const endpoint = `${apiBase}/v1/manga/detail/${mangaId}`;
  const res = await fetchWithRetry(endpoint, JSON_HEADERS, SECONDARY_CONFIG.REQUEST_TIMEOUT, deadline);
  
  if (!isAxiosLikeResponse(res)) {
    return { raw: {} as SecondaryMangaRow, chapters: [], meta: {} as SecondaryMangaRow };
  }
  
  const raw = isSecondaryApiData(res.data) ? res.data : {};
  const rawData = raw as { data?: unknown };
  const payload = rawData.data ?? raw;
  return {
    raw: payload as SecondaryMangaRow,
    chapters: extractDetailChaptersFromMangaDetail(raw as any, Date.now(), 168), // Default lookback
    meta: (payload as { data?: SecondaryMangaRow }).data ?? (payload as SecondaryMangaRow),
  };
}

export async function fetchUpdateList(
  apiBase: string, 
  type?: string, 
  deadline = 0, 
  lookbackHours = 24
): Promise<SecondaryMangaRow[]> {
  const all: SecondaryMangaRow[] = [];
  const pages = [1, 2, 3];
  const results = await Promise.all(pages.map(async (p) => {
    if (deadline > 0 && Date.now() >= deadline - 5000) return [];
    try {
      const typeQuery = type ? `&type=${type}` : "";
      const url = `${apiBase}/v1/manga/list?page=${p}&page_size=40&is_update=true&sort=latest${typeQuery}`;
      const res = await fetchWithRetry(url, JSON_HEADERS, SECONDARY_CONFIG.REQUEST_TIMEOUT, deadline);
      if (isAxiosLikeResponse(res)) {
        return extractRows<SecondaryMangaRow>(res.data);
      }
    } catch (err) {
      logger.warn({ type, page: p, err: (err as Error).message }, "Secondary page fetch failed");
    }
    return [];
  }));

  for (const rawRows of results) {
    if (!rawRows.length) continue;
    const last = rawRows[rawRows.length - 1];
    const lu = parseDateWithFallback(last?.latest_chapter_time ?? last?.updated_at);
    const isFresh = lu && (Date.now() - lu.getTime()) / 3600000 <= lookbackHours;
    all.push(...rawRows);
    if (lu && !isFresh) break;
  }
  return all;
}

export async function searchShngm(query: string, source = "shinigami", deadline = 0): Promise<ProviderResult<ChapterItem[]>> {
  const kw = String(query ?? "").trim().toLowerCase();
  if (!kw || !API_BASE) return { success: true, data: [] };
  const norm = normalizeSource(source);
  const typesToFetch = norm === "shinigami" ? ["project", "mirror"] as const : [norm === "mirror" ? "mirror" : "project"] as const;
  const results: ChapterItem[] = [];
  
  try {
    for (const type of typesToFetch) {
      if (deadline > 0 && Date.now() >= deadline - 1000) break;
      
      for (let p = 1; p <= 2; p++) {
        const res = await fetchWithRetry(`${API_BASE}/v1/manga/list?type=${type}&page=${p}&page_size=40&sort=latest`, JSON_HEADERS, SECONDARY_CONFIG.REQUEST_TIMEOUT, deadline);
        
        if (!isAxiosLikeResponse(res)) continue;
        
        const rows = extractRows<SecondaryMangaRow>(res.data);
        if (!rows.length) break;
        const filtered = rows.filter((r: SecondaryMangaRow) => String(r?.title || "").toLowerCase().includes(kw)).map((r: SecondaryMangaRow) => ({
          title: r.title!, 
          chapter: "Latest", 
          url: `${SECONDARY_PUBLIC_BASE}/series/${r.manga_id}`,
          mangaUrl: `${SECONDARY_PUBLIC_BASE}/series/${r.manga_id}`, 
          updatedTime: parseDateWithFallback(r.latest_chapter_time ?? r.updated_at)?.toISOString() ?? null, 
          source: norm
        } as ChapterItem));
        results.push(...filtered);
        if (results.length >= 10) break;
      }
    }
    return { success: true, data: results.slice(0, 50) };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const axiosError = err as { response?: { status?: number } };
    return {
      success: false,
      error: {
        message,
        source: norm,
        code: String(axiosError?.response?.status || ""),
      }
    };
  }
}

export async function fetchRandomShinigamiManga(source = "shinigami", { randomFn = Math.random } = {}) {
  if (!API_BASE) return null;
  const norm = normalizeSource(source);
  const type = norm === "mirror" ? "mirror" : "project";
  try {
    const res = await fetchWithRetry(`${API_BASE}/v1/manga/list?type=${type}&page=1&page_size=40&sort=latest&category_id=2,3`, JSON_HEADERS, SECONDARY_CONFIG.REQUEST_TIMEOUT);
    
    if (!isAxiosLikeResponse(res)) return null;
    
    const rows = extractRows<SecondaryMangaRow>(res.data);
    if (!rows?.length) return null;
    const r = rows[Math.floor(randomFn() * rows.length)];
    return { title: r.title!, mangaUrl: `${SECONDARY_PUBLIC_BASE}/series/${r.manga_id}`, cover: r.cover_portrait_url || r.cover_image_url || null, source: norm };
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    logger.debug({ source: norm, err: errMessage }, "Failed to fetch random manga");
    return null;
  }
}
