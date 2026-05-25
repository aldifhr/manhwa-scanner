import { SecondaryMangaRow } from "../../types.js";

export interface DetailState {
  count: number;
  circuitOpen: boolean;
}

export interface SecondaryChapterRow {
  chapter_id?: string | number;
  chapter_number?: string | number;
  release_date?: string;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface TransformedChapter {
  chapter_id: string | number;
  chapter_number: string | number;
  created_at: string;
}

export interface SecondaryFullInfo {
  raw: SecondaryMangaRow;
  chapters: {
    chapter_id: string | number;
    chapter_number: string | number;
    created_at: string;
  }[];
  meta: SecondaryMangaRow;
}

export interface SecondaryApiData {
  data?: unknown;
}

export interface AxiosLikeResponse {
  data: unknown;
}

export function isAxiosLikeResponse(obj: unknown): obj is AxiosLikeResponse {
  return obj !== null && typeof obj === "object" && "data" in obj;
}

export function isSecondaryApiData(obj: unknown): obj is SecondaryApiData {
  return obj !== null && typeof obj === "object";
}
