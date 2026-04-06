import { z } from "zod";

// Common validation schemas

// Discord ID validation (snowflake)
export const discordIdSchema = z.string().regex(/^\d{17,20}$/, "Invalid Discord ID");

// Date string validation
export const dateStringSchema = z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/));

// URL validation
export const urlSchema = z.string().url("Invalid URL format").max(2048, "URL too long");

// Title validation
export const titleSchema = z.string().min(1, "Title required").max(200, "Title too long");

// Chapter validation
export const chapterSchema = z.string().min(1, "Chapter required").max(50, "Chapter too long");

// Source validation
export const sourceSchema = z.enum(["ikiru", "shinigami_project", "shinigami_mirror", "unknown"]);

// API Query Parameters
export const daysBackQuerySchema = z.object({
  days: z.string().regex(/^\d+$/).transform(Number).pipe(
    z.number().int().min(1).max(90).default(30)
  ).optional(),
  resolved: z.enum(["true", "false"]).optional(),
});

export const pageQuerySchema = z.object({
  page: z.string().regex(/^\d+$/).transform(Number).pipe(
    z.number().int().min(1).default(1)
  ).optional(),
});

// Discord Interaction Schemas
export const discordInteractionSchema = z.object({
  id: discordIdSchema,
  application_id: discordIdSchema,
  type: z.number().int(),
  data: z.object({
    name: z.string(),
    options: z.array(z.object({
      name: z.string(),
      value: z.union([z.string(), z.number(), z.boolean()]),
    })).optional(),
  }).optional(),
  member: z.object({
    user: z.object({
      id: discordIdSchema,
      username: z.string(),
    }).optional(),
  }).optional(),
  user: z.object({
    id: discordIdSchema,
    username: z.string(),
  }).optional(),
});

// Manga entry validation
export const mangaEntrySchema = z.object({
  title: titleSchema,
  chapter: chapterSchema,
  url: urlSchema,
  mangaUrl: urlSchema.optional(),
  cover: urlSchema.optional().or(z.literal("")),
  source: sourceSchema,
  updatedTime: dateStringSchema.optional(),
  rating: z.number().min(0).max(5).optional(),
  status: z.enum(["Ongoing", "Completed", "Hiatus", "Dropped", "Unknown"]).optional(),
});

// Whitelist entry validation
export const whitelistEntrySchema = z.object({
  title: titleSchema,
  sources: z.array(z.object({
    source: sourceSchema,
    url: urlSchema.optional(),
    mark: z.enum(["Active", "Dead", "Unstable"]).optional(),
  })).min(1, "At least one source required"),
});

// Cron log entry validation
export const cronLogEntrySchema = z.object({
  time: dateStringSchema.optional(),
  tag: z.enum(["sent", "failed", "partial", "skipped", "info", "error"]).default("info"),
  code: z.string().optional(),
  type: z.string().optional(),
  source: sourceSchema.optional(),
  title: titleSchema.optional(),
  count: z.number().int().optional(),
  failed: z.number().int().optional(),
  message: z.string().max(1000).optional(),
  level: z.enum(["info", "warn", "error"]).optional(),
});

// Health check validation
export const healthCheckSchema = z.object({
  status: z.enum(["healthy", "degraded", "unhealthy", "unknown"]),
  consecutiveFailures: z.number().int().min(0).default(0),
  lastCheckedAt: dateStringSchema.optional(),
  lastError: z.string().optional(),
  responseTime: z.number().int().optional(),
});

// Pagination params
export const paginationSchema = z.object({
  page: z.number().int().min(1).default(1),
  perPage: z.number().int().min(1).max(100).default(10),
});

// Notification mode
export const notificationModeSchema = z.enum(["follows", "all", "none"]);

// User settings validation
export const userSettingsSchema = z.object({
  notify_mode: notificationModeSchema.default("follows"),
  mutedTitles: z.array(titleSchema).default([]),
});

// Helper function to safely parse with zod
export function safeParse(schema, data) {
  const result = schema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    errors: result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`)
  };
}

// Helper to parse query params
export function parseQueryParams(schema, query) {
  try {
    const transformed = {};

    for (const [key, value] of Object.entries(query)) {
      if (value === "true" || value === "false") {
        transformed[key] = value === "true";
      } else if (!isNaN(value) && value !== "") {
        transformed[key] = Number(value);
      } else {
        transformed[key] = value;
      }
    }

    return safeParse(schema, transformed);
  } catch (err) {
    return { success: false, errors: [err.message] };
  }
}

// Validate and throw if invalid
export function validateOrThrow(schema, data, context = "") {
  const result = schema.safeParse(data);
  if (!result.success) {
    const errors = result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(", ");
    throw new Error(`${context ? context + " - " : ""}Validation failed: ${errors}`);
  }
  return result.data;
}

// Partial validation (for updates)
export function partialValidate(schema, data) {
  return safeParse(schema.partial(), data);
}
