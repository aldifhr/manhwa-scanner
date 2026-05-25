import { getLogger } from "../../logger.js";
import { SecondaryMangaRow, ChapterItem } from "../../types.js";
import { 
  SecondaryMangaRowSchema, 
  SecondaryApiResponseSchema 
} from "../../schemas.js";
import { 
  SecondaryChapterRow, 
  TransformedChapter 
} from "./types.js";
import { 
  parseDateWithFallback 
} from "../../dateUtils.js";
import { 
  normalizeText, 
  validateChapter, 
  pickSecondaryDescription,
  normalizeSourceUrl,
  SECONDARY_PUBLIC_BASE,
  formatChapterText,
  isWithinLastHours 
} from "../shared.js";

const logger = getLogger({ scope: "secondary:transform" });

export function extractRows<T>(payload: unknown): T[] {
  const parsed = SecondaryApiResponseSchema.safeParse(payload);
  if (!parsed.success) return [];
  
  const root = parsed.data.data ?? parsed.data.result ?? parsed.data.items ?? parsed.data;
  const rows = Array.isArray(root) 
    ? root 
    : (root as any)?.rows 
      ? (root as any).rows 
      : (root as any)?.data 
        ? (root as any).data 
        : [];
  
  if (!Array.isArray(rows)) return [];
  return rows.map(r => {
    const rowParsed = SecondaryMangaRowSchema.safeParse(r);
    if (!rowParsed.success) {
      return null;
    }
    return (rowParsed.data as unknown as T);
  }).filter((r): r is T => r !== null);
}

export function transformChapterRows(
  rows: SecondaryChapterRow[], 
  now = Date.now(), 
  lookbackHours = 24
): TransformedChapter[] {
  return rows
    .map((row): TransformedChapter | null => {
      const dateRaw = row?.release_date ?? row?.created_at ?? row?.updated_at;
      if (typeof dateRaw !== "string") return null;
      const parsedTime = parseDateWithFallback(dateRaw);
      if (!parsedTime) return null;
      if (!isWithinLastHours(parsedTime, lookbackHours)) return null;

      const chapter_id = row?.chapter_id;
      const chapter_number = row?.chapter_number;
      
      if (chapter_id === undefined || chapter_number === undefined) {
        return null;
      }

      return {
        chapter_id,
        chapter_number,
        created_at: parsedTime.toISOString(),
      };
    })
    .filter((v): v is TransformedChapter => !!v);
}

export function mapChapterCandidate(
  chapter: SecondaryChapterRow | null | undefined, 
  fallbackRow: SecondaryMangaRow | null = null, 
  now = Date.now(), 
  lookbackHours = 24
) {
  const chapterId = chapter?.chapter_id ?? 
    (chapter?.chapter_number !== undefined ? chapter?.id : undefined) ?? 
    fallbackRow?.latest_chapter_id ?? 
    null;
  const chapterNumber = chapter?.chapter_number ?? chapter?.number ?? fallbackRow?.latest_chapter_number ?? null;
  const dateRaw = chapter?.release_date ?? chapter?.created_at ?? chapter?.updated_at ?? fallbackRow?.latest_chapter_time ?? fallbackRow?.updated_at ?? null;

  const parsedTime = typeof dateRaw === "string" ? parseDateWithFallback(dateRaw) : null;
  if (!chapterId || chapterNumber === null || !parsedTime) return null;
  if (!isWithinLastHours(parsedTime, lookbackHours)) return null;

  return {
    chapter_id: chapterId as string | number,
    chapter_number: chapterNumber as string | number,
    created_at: parsedTime.toISOString(),
  };
}

export function extractDetailChaptersFromMangaDetail(
  payload: any, 
  now = Date.now(), 
  lookbackHours = 24
) {
  const root = payload?.data ?? payload?.result ?? payload ?? {};
  const detail = (root as { data?: SecondaryMangaRow } & SecondaryMangaRow)?.data ?? root;

  const chapterArrayCandidates = [
    (detail as { chapters?: SecondaryChapterRow[] })?.chapters,
    (detail as { latest_chapters?: SecondaryChapterRow[] })?.latest_chapters,
    (detail as { chapter_list?: SecondaryChapterRow[] })?.chapter_list,
    (detail as { chapterList?: SecondaryChapterRow[] })?.chapterList,
  ].find((arr) => Array.isArray(arr)) as SecondaryChapterRow[] | undefined;

  if (Array.isArray(chapterArrayCandidates) && chapterArrayCandidates.length) {
    return chapterArrayCandidates
      .map((chapter) => mapChapterCandidate(chapter, detail as SecondaryMangaRow, now, lookbackHours))
      .filter((v): v is NonNullable<typeof v> => !!v);
  }

  return [];
}


export function transformChapterResults(
  row: SecondaryMangaRow,
  chapterRows: SecondaryChapterRow[],
  seen: Set<string>,
  source: string,
  mangaUrl: string,
  now = Date.now(),
  lookbackHours = 24,
) {
  const title = String(row?.title ?? "").trim();
  const cover = row?.cover_image_url ?? row?.cover_portrait_url ?? null;

  return chapterRows.map((c: SecondaryChapterRow) => {
    if (!c?.chapter_id) return null;
    const chapter = formatChapterText(c?.chapter_number);
    if (!chapter) return null;

    const parsedTime = parseDateWithFallback(c?.release_date ?? c?.created_at ?? row?.updated_at);
    if (!parsedTime || !isWithinLastHours(parsedTime, lookbackHours)) return null;

    const chapterUrl = `${SECONDARY_PUBLIC_BASE}/chapter/${c.chapter_id}`;
    if (seen.has(chapterUrl.toLowerCase().trim())) return null;
    seen.add(chapterUrl.toLowerCase().trim());

    return validateChapter({
      title, chapter, url: chapterUrl, cover, mangaUrl, 
      mangaId: row?.manga_id ?? null,
      rating: row?.user_rate ? String(row.user_rate) : "N/A",
      status: row?.status === 1 ? "Ongoing" : row?.status === 2 ? "Completed" : row?.status === 3 ? "Hiatus" : "Unknown",
      updatedTime: parsedTime.toISOString(),
      description: pickSecondaryDescription(row),
      source,
    }, logger);
  }).filter((v): v is NonNullable<typeof v> => !!v);
}

export function parseSeriesIdFromUrl(url: string | null) {
  return normalizeSourceUrl(url || "")?.match(/\/series\/([^/?#]+)/i)?.[1] || null;
}
