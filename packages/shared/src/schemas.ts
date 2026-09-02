import { z } from "zod";

// Dual-naming helper: backend may send snake or camel (migration period)
function dual<T extends z.ZodTypeAny>(snake: string, camel: string, base: T) {
  return z
    .object({ [snake]: base.optional(), [camel]: base.optional() })
    .transform((o) => (o as Record<string, unknown>)[snake] ?? (o as Record<string, unknown>)[camel]);
}

export const excludedTitleSchema = z
  .object({
    id: z.string().nullable().optional(),
    title_key: z.string().nullable().optional(),
    titleKey: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    source: z.string().nullable().optional(),
    created_at: z.string().nullable().optional(),
    createdAt: z.string().nullable().optional(),
    cover: z.string().nullable().optional(),
    series_url: z.string().nullable().optional(),
    seriesUrl: z.string().nullable().optional(),
  })
  .transform((r) => ({
    id: (r.title_key as string) || (r.titleKey as string) || (r.id as string) || "",
    titleKey: (r.title_key as string) || (r.titleKey as string) || (r.id as string) || "",
    title: (r.title as string | null) ?? null,
    source: (r.source as string) || "all",
    createdAt: (r.created_at as string | null) || (r.createdAt as string | null) || null,
    cover: (r.cover as string | null) ?? null,
    seriesUrl: (r.series_url as string | null) || (r.seriesUrl as string | null) || null,
  }));

export const whitelistSchema = z
  .object({
    title_key: z.string().optional(),
    titleKey: z.string().optional(),
    title: z.string().optional(),
    source: z.string().optional(),
    cover: z.string().nullable().optional(),
    series_url: z.string().nullable().optional(),
    seriesUrl: z.string().nullable().optional(),
  })
  .passthrough()
  .transform((r) => ({
    ...r,
    titleKey: (r.title_key as string) ?? (r.titleKey as string) ?? "",
    seriesUrl: (r.series_url as string) ?? (r.seriesUrl as string) ?? "",
  }));

export const rssItemSchema = z
  .object({
    title_key: z.string().optional(),
    titleKey: z.string().optional(),
    chapter_url: z.string().optional(),
    chapterUrl: z.string().optional(),
  })
  .passthrough()
  .transform((r) => ({
    ...r,
    titleKey: (r.title_key as string) ?? (r.titleKey as string) ?? "",
    chapterUrl: (r.chapter_url as string) ?? (r.chapterUrl as string) ?? "",
  }));

export type ExcludedTitleParsed = z.infer<typeof excludedTitleSchema>;
