import { z } from "zod";
import { rewriteCoverUrl } from "@/lib/utils";

// Backend RSS rows mix snake_case and camelCase. Normalize to camelCase so the
// frontend only ever reads one shape. Keys NOT in this map pass through as-is.
const SNAKE_TO_CAMEL: Record<string, string> = {
  title_key: "titleKey",
  canonical_title_key: "canonicalTitleKey",
  chapter_label: "chapterLabel",
  chapter_number: "chapterNumber",
  chapter_url: "chapterUrl",
  series_url: "seriesUrl",
  is_sent: "isSent",
  is_whitelisted: "isWhitelisted",
  created_at: "createdAt",
  sent_at: "sentAt",
  updated_at: "updatedAt",
};

const camelizeKeys = (raw: unknown): unknown => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    out[SNAKE_TO_CAMEL[k] ?? k] = v;
  }
  return out;
};

const strOrNum = z.union([z.string(), z.number()]);

/** Coerce a boolean without the "false" string trap: z.coerce.boolean() maps
 *  Boolean("false") → true. Only accept real booleans / "true"/"false" / 0|1. */
const strictBoolean = z
  .union([
    z.boolean(),
    z.literal("true"),
    z.literal("false"),
    z.literal(0),
    z.literal(1),
  ])
  .nullish()
  .catch(undefined);

/**
 * Validate + normalize a single RSS feed row. Every field is lenient
 * (`.catch`/`.nullish`) so a malformed/missing field degrades instead of
 * blowing up the whole feed. Cross-field fallbacks (url ← chapterUrl,
 * cover rewrite) mirror the old manual normalization in /api/rss.
 */
export const rssItemSchema = z
  .preprocess(
    camelizeKeys,
    z.object({
      title: z.string().catch(""),
      titleKey: z
        .string()
        .nullish()
        .catch(() => undefined),
      canonicalTitleKey: z
        .string()
        .nullish()
        .catch(() => undefined),
      isSent: z
        .preprocess(
          (v) =>
            v === "true" || v === 1
              ? true
              : v === "false" || v === 0
                ? false
                : v,
          strictBoolean
        )
        .nullish()
        .catch(() => undefined),
      chapter: z
        .string()
        .nullish()
        .catch(() => undefined),
      chapterLabel: z
        .string()
        .nullish()
        .catch(() => undefined),
      chapterNumber: z
        .union([z.null(), z.coerce.number()])
        .nullish()
        .catch(() => undefined),
      url: z
        .string()
        .nullish()
        .catch(() => undefined),
      chapterUrl: z
        .string()
        .nullish()
        .catch(() => undefined),
      source: z.string().catch(""),
      cover: z
        .string()
        .nullish()
        .catch(() => undefined),
      origin: z
        .string()
        .nullish()
        .catch(() => undefined),
      type: z
        .string()
        .nullish()
        .catch(() => undefined),
      seriesUrl: z
        .string()
        .nullish()
        .catch(() => undefined),
      status: z
        .string()
        .nullish()
        .catch(() => undefined),
      rating: strOrNum.nullish().catch(() => undefined),
      genres: z.array(z.string()).catch([]),
      description: z
        .string()
        .nullish()
        .catch(() => undefined),
      isWhitelisted: z
        .preprocess(
          (v) =>
            v === "true" || v === 1
              ? true
              : v === "false" || v === 0
                ? false
                : v,
          strictBoolean
        )
        .nullish()
        .catch(() => undefined),
      createdAt: z
        .string()
        .nullish()
        .catch(() => undefined),
      sentAt: z
        .string()
        .nullish()
        .catch(() => undefined),
      lastCheckedChapter: z
        .union([z.null(), z.coerce.number()])
        .nullish()
        .catch(() => undefined),
      latestSentChapter: z
        .union([z.null(), z.coerce.number()])
        .nullish()
        .catch(() => undefined),
      latestChapter: z
        .union([z.null(), z.coerce.number()])
        .nullish()
        .catch(() => undefined),
    })
  )
  .transform((d) => ({
    ...d,
    cover: d.cover ? rewriteCoverUrl(d.cover) : null,
    url: d.url ?? d.chapterUrl ?? undefined,
    chapterUrl: d.chapterUrl ?? undefined,
    seriesUrl: d.seriesUrl ?? undefined,
  }));
