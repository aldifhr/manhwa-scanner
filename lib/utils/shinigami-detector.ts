/**
 * Shinigami Source Detector
 * Utility untuk mendeteksi apakah manga ada di project, mirror, atau keduanya
 * 
 * Detection strategies:
 * 1. Search-based: Cari manga by keyword, lalu check detail untuk setiap result
 * 2. ID-based: Langsung check detail dengan manga ID
 */

import { httpGet } from "../httpClient.js";
import { HTTP_USER_AGENT, SECONDARY_SOURCE_URL } from "../scrapers/shared.js";

const API_BASE = (SECONDARY_SOURCE_URL || "https://api.shngm.io").replace(/\/+$/, "");

const JSON_HEADERS = {
  Accept: "application/json",
  "User-Agent": HTTP_USER_AGENT,
};

export type ShinigamiSource = "project" | "mirror" | "both" | "none";

export interface SourceDetectionResult {
  mangaId: string;
  source: ShinigamiSource;
  title?: string;
  found: boolean;
  projectTitle?: string;
  mirrorTitle?: string;
  projectData?: unknown;
  mirrorData?: unknown;
}

export interface SearchDetectionResult {
  query: string;
  results: SearchSourceResult[];
}

export interface SearchSourceResult {
  mangaId: string;
  title: string;
  source: ShinigamiSource;
  projectData?: unknown;
  mirrorData?: unknown;
}

export interface SourceDetectionOptions {
  timeout?: number;
  retries?: number;
}

export interface SearchOptions extends SourceDetectionOptions {
  pageSize?: number;
  maxResults?: number;
}

// ============================================================================
// ID-based Detection (existing)
// ============================================================================

/**
 * Extract manga ID dari berbagai format URL Shinigami
 */
export function extractShinigamiMangaId(input: string): string | null {
  // UUID format: a1b2c3d4-e5f6-7890-abcd-ef1234567890
  const uuidMatch = input.match(/\/(?:series|manga|komik)\/([a-f0-9-]{36})/i);
  if (uuidMatch) return uuidMatch[1];

  // Slug format: shingeki-no-kyojin
  const slugMatch = input.match(/\/(?:series|manga|komik)\/([^/?#]+)/i);
  if (slugMatch) return slugMatch[1];

  // Raw UUID
  if (/^[a-f0-9-]{36}$/i.test(input)) return input;

  // Raw slug
  if (/^[a-z0-9-]+$/i.test(input)) return input;

  return null;
}

interface TypeItem {
  taxonomy_id: number;
  slug: string;
  name: string;
}

interface MangaDetailResponse {
  title?: string;
  name?: string;
  Type?: TypeItem[];
  taxonomy?: Record<string, TypeItem[]>;
  [key: string]: unknown;
}

function extractMangaDetail(data: unknown): MangaDetailResponse | null {
  const root = (data as any)?.data ?? (data as any)?.result ?? data;
  if (!root || typeof root !== "object") return null;
  return root as MangaDetailResponse;
}

function detectSourceFromTypes(
  types: TypeItem[] | undefined,
  taxonomy?: Record<string, TypeItem[]>
): { isProject: boolean; isMirror: boolean } {
  // Check direct Type array
  if (Array.isArray(types)) {
    const isProject = types.some(t => t.slug === "project" || t.name?.toLowerCase() === "project");
    const isMirror = types.some(t => t.slug === "mirror" || t.name?.toLowerCase() === "mirror");
    if (isProject || isMirror) return { isProject, isMirror };
  }
  
  // Check taxonomy.Type (Shinigami API structure)
  if (taxonomy?.Type && Array.isArray(taxonomy.Type)) {
    const isProject = taxonomy.Type.some(t => t.slug === "project" || t.name?.toLowerCase() === "project");
    const isMirror = taxonomy.Type.some(t => t.slug === "mirror" || t.name?.toLowerCase() === "mirror");
    return { isProject, isMirror };
  }
  
  return { isProject: false, isMirror: false };
}

/**
 * Fetch manga detail dan detect source dari field "Type"
 * 1 API call untuk tahu keduanya
 */
export async function fetchMangaDetailAndDetect(
  mangaId: string,
  options: SourceDetectionOptions = {}
): Promise<{
  found: boolean;
  title?: string;
  source: ShinigamiSource;
  types?: TypeItem[];
  rawData?: unknown;
}> {
  const { timeout = 10000, retries = 2 } = options;

  try {
    const res = await httpGet(
      `${API_BASE}/v1/manga/detail/${mangaId}`,
      { headers: JSON_HEADERS, timeout },
      { retries, baseDelayMs: 500 }
    );

    const data = extractMangaDetail(res?.data);
    
    if (!data || (!data.title && !data.name)) {
      return { found: false, source: "none" };
    }

    const title = data.title || data.name;
    const resolvedTypes = data.Type || data.taxonomy?.Type || [];
    const { isProject, isMirror } = detectSourceFromTypes(data.Type, data.taxonomy);

    let source: ShinigamiSource;
    if (isProject && isMirror) source = "both";
    else if (isProject) source = "project";
    else if (isMirror) source = "mirror";
    else source = "none";

    return {
      found: true,
      title: String(title).trim(),
      source,
      types: resolvedTypes,
      rawData: data,
    };
  } catch {
    return { found: false, source: "none" };
  }
}

/**
 * Check apakah manga ada di database utama Shinigami
 */
export async function checkProject(
  mangaId: string,
  options: SourceDetectionOptions = {}
): Promise<{ exists: boolean; title?: string; data?: unknown }> {
  const result = await fetchMangaDetailAndDetect(mangaId, options);
  return {
    exists: result.found && (result.source === "project" || result.source === "both"),
    title: result.title,
    data: result.rawData,
  };
}

/**
 * Check apakah manga ada di database sekunder Shinigami
 */
export async function checkMirror(
  mangaId: string,
  options: SourceDetectionOptions = {}
): Promise<{ exists: boolean; title?: string; data?: unknown }> {
  const result = await fetchMangaDetailAndDetect(mangaId, options);
  return {
    exists: result.found && (result.source === "mirror" || result.source === "both"),
    title: result.title,
    data: result.rawData,
  };
}

/**
 * Detect source dari manga ID
 * Hanya 1 API call dengan parsing field "Type"
 */
export async function detectSource(
  mangaId: string,
  options: SourceDetectionOptions = {}
): Promise<SourceDetectionResult> {
  const result = await fetchMangaDetailAndDetect(mangaId, options);

  if (!result.found) {
    return {
      mangaId,
      source: "none",
      found: false,
    };
  }

  const { isProject, isMirror } = detectSourceFromTypes(result.types, (result.rawData as any)?.taxonomy);

  let source: ShinigamiSource;
  if (isProject && isMirror) source = "both";
  else if (isProject) source = "project";
  else if (isMirror) source = "mirror";
  else source = "none";

  return {
    mangaId,
    source,
    found: true,
    title: result.title,
    projectTitle: isProject ? result.title : undefined,
    mirrorTitle: isMirror ? result.title : undefined,
    projectData: isProject ? result.rawData : undefined,
    mirrorData: isMirror ? result.rawData : undefined,
  };
}

/**
 * Detect source dari URL atau input string
 */
export async function detectSourceFromInput(
  input: string,
  options: SourceDetectionOptions = {}
): Promise<SourceDetectionResult | null> {
  const mangaId = extractShinigamiMangaId(input);
  if (!mangaId) return null;

  return detectSource(mangaId, options);
}

// ============================================================================
// Search-based Detection (NEW)
// ============================================================================

interface SearchApiItem {
  manga_id?: string;
  title?: string;
  id?: string;
  name?: string;
}

function extractSearchResults(data: unknown): SearchApiItem[] {
  const root = (data as any)?.data ?? (data as any)?.result ?? (data as any)?.items ?? data;
  const rows = Array.isArray(root) ? root : (root as any)?.data;
  if (!Array.isArray(rows)) return [];

  return rows.map((r: any) => ({
    manga_id: r?.manga_id || r?.id,
    title: r?.title || r?.name,
  })).filter((r: SearchApiItem) => r.manga_id && r.title);
}

/**
 * Search manga di project
 * API: /v1/manga/list?type=project&q={keyword}
 */
export async function searchProject(
  keyword: string,
  options: SearchOptions = {}
): Promise<SearchApiItem[]> {
  const { timeout = 10000, retries = 2, pageSize = 10 } = options;

  try {
    const res = await httpGet(
      `${API_BASE}/v1/manga/list?type=project&q=${encodeURIComponent(keyword)}&page=1&page_size=${pageSize}`,
      { headers: JSON_HEADERS, timeout },
      { retries, baseDelayMs: 500 }
    );

    return extractSearchResults(res?.data);
  } catch {
    return [];
  }
}

/**
 * Search manga di mirror
 * API: /v1/manga/list?type=mirror&q={keyword}
 */
export async function searchMirror(
  keyword: string,
  options: SearchOptions = {}
): Promise<SearchApiItem[]> {
  const { timeout = 10000, retries = 2, pageSize = 10 } = options;

  try {
    const res = await httpGet(
      `${API_BASE}/v1/manga/list?type=mirror&q=${encodeURIComponent(keyword)}&page=1&page_size=${pageSize}`,
      { headers: JSON_HEADERS, timeout },
      { retries, baseDelayMs: 500 }
    );

    return extractSearchResults(res?.data);
  } catch {
    return [];
  }
}

/**
 * Search-based detection
 * Cari manga by keyword di kedua source, lalu cross-check hasilnya
 */
export async function detectSourceBySearch(
  keyword: string,
  options: SearchOptions = {}
): Promise<SearchDetectionResult> {
  const { maxResults = 5 } = options;

  // Search di kedua source secara parallel
  const [projectResults, mirrorResults] = await Promise.all([
    searchProject(keyword, options),
    searchMirror(keyword, options),
  ]);

  // Buat map untuk tracking
  const projectMap = new Map(projectResults.map(r => [r.manga_id!, r]));
  const mirrorMap = new Map(mirrorResults.map(r => [r.manga_id!, r]));

  // Collect semua unique manga IDs
  const allIds = new Set([...projectMap.keys(), ...mirrorMap.keys()]);

  // Build result dengan cross-check
  const results: SearchSourceResult[] = [];
  for (const mangaId of allIds) {
    const inProject = projectMap.has(mangaId);
    const inMirror = mirrorMap.has(mangaId);

    let source: ShinigamiSource;
    if (inProject && inMirror) source = "both";
    else if (inProject) source = "project";
    else source = "mirror";

    results.push({
      mangaId,
      title: projectMap.get(mangaId)?.title || mirrorMap.get(mangaId)?.title || "Unknown",
      source,
      projectData: projectMap.get(mangaId),
      mirrorData: mirrorMap.get(mangaId),
    });

    if (results.length >= maxResults) break;
  }

  return { query: keyword, results };
}

// ============================================================================
// Utility Class
// ============================================================================

/**
 * Utility class untuk batch detection
 */
export class ShinigamiSourceDetector {
  private options: SourceDetectionOptions;

  constructor(options: SourceDetectionOptions = {}) {
    this.options = { timeout: 10000, retries: 2, ...options };
  }

  /**
   * Detect single manga by ID
   */
  async detect(mangaId: string): Promise<SourceDetectionResult> {
    return detectSource(mangaId, this.options);
  }

  /**
   * Detect dari URL atau input
   */
  async detectFromInput(input: string): Promise<SourceDetectionResult | null> {
    return detectSourceFromInput(input, this.options);
  }

  /**
   * Search-based detection
   */
  async searchAndDetect(keyword: string, maxResults = 5): Promise<SearchDetectionResult> {
    return detectSourceBySearch(keyword, { ...this.options, maxResults });
  }

  /**
   * Batch detect multiple manga IDs
   */
  async detectBatch(mangaIds: string[]): Promise<SourceDetectionResult[]> {
    const results: SourceDetectionResult[] = [];

    // Run sequentially to avoid rate limiting
    for (const mangaId of mangaIds) {
      try {
        const result = await this.detect(mangaId);
        results.push(result);
      } catch {
        results.push({ mangaId, source: "none", found: false });
      }
    }

    return results;
  }

  /**
   * Check apakah manga ada di project
   */
  async isInProject(mangaId: string): Promise<boolean> {
    const result = await checkProject(mangaId, this.options);
    return result.exists;
  }

  /**
   * Check apakah manga ada di mirror
   */
  async isInMirror(mangaId: string): Promise<boolean> {
    const result = await checkMirror(mangaId, this.options);
    return result.exists;
  }

  /**
   * Get recommended source untuk manga
   * Priority: project > mirror > none
   */
  async getRecommendedSource(mangaId: string): Promise<"project" | "mirror" | null> {
    const result = await this.detect(mangaId);

    if (result.source === "project" || result.source === "both") return "project";
    if (result.source === "mirror") return "mirror";
    return null;
  }
}

// Default instance
export const shinigamiDetector = new ShinigamiSourceDetector();
