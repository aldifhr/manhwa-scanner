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
    title_key: z.string().min(1).nullable().optional(),
    titleKey: z.string().min(1).nullable().optional(),
    title: z.string().nullable().optional(),
    source: z.enum(["ikiru", "shinigami", "voratoon"]).nullable().optional(),
    created_at: z.string().nullable().optional(),
    createdAt: z.string().nullable().optional(),
    cover: z.string().nullable().optional(),
    series_url: z.string().url().nullable().optional(),
    seriesUrl: z.string().url().nullable().optional(),
  })
  .passthrough()
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
    title_key: z.string().min(1).optional(),
    titleKey: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    source: z.enum(["ikiru", "shinigami", "voratoon"]).optional(),
    cover: z.string().nullable().optional(),
    series_url: z.string().url().nullable().optional(),
    seriesUrl: z.string().url().nullable().optional(),
  })
  .passthrough()
  .transform((r) => ({
    ...r,
    titleKey: (r.title_key as string) ?? (r.titleKey as string) ?? "",
    seriesUrl: (r.series_url as string) ?? (r.seriesUrl as string) ?? "",
  }));

export const rssItemSchema = z
  .object({
    title_key: z.string().min(1).optional(),
    titleKey: z.string().min(1).optional(),
    chapter_url: z.string().url().optional(),
    chapterUrl: z.string().url().optional(),
  })
  .passthrough()
  .transform((r) => ({
    ...r,
    titleKey: (r.title_key as string) ?? (r.titleKey as string) ?? "",
    chapterUrl: (r.chapter_url as string) ?? (r.chapterUrl as string) ?? "",
  }));

export type ExcludedTitleParsed = z.infer<typeof excludedTitleSchema>;
