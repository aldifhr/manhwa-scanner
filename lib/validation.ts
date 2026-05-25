import { z } from "zod";

// Common validation schemas

// Discord ID validation (snowflake)
export const discordIdSchema = z
  .string()
  .regex(/^\d{17,20}$/, "Invalid Discord ID");

// Date string validation
export const dateStringSchema = z
  .string()
  .datetime({ offset: true })
  .or(z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/));

// URL validation
export const urlSchema = z
  .string()
  .url("Invalid URL format")
  .max(2048, "URL too long");

// Title validation
export const titleSchema = z
  .string()
  .min(1, "Title required")
  .max(200, "Title too long");

// Chapter validation
export const chapterSchema = z
  .string()
  .min(1, "Chapter required")
  .max(50, "Chapter too long");

// Source validation
export const sourceSchema = z.enum([
  "ikiru",
  "shinigami",
  "unknown",
]);

// API Query Parameters
export const daysBackQuerySchema = z.object({
  days: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .optional()
    .default(30)
    .pipe(z.number().int().min(1).max(90)),
  resolved: z.enum(["true", "false"]).optional(),
});

export const pageQuerySchema = z.object({
  page: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .optional()
    .default(1)
    .pipe(z.number().int().min(1)),
});

// Discord Interaction Schemas
// Recursive option schema for subcommands
const discordOptionSchema: z.ZodType<any> = z.lazy(() =>
  z.object({
    name: z.string(),
    type: z.number().int().optional(),
    value: z.union([z.string(), z.number(), z.boolean()]).optional(),
    options: z.array(discordOptionSchema).optional(),
    focused: z.boolean().optional(),
  })
);

export const discordInteractionSchema = z.object({
  id: discordIdSchema,
  application_id: discordIdSchema,
  token: z.string().optional(),
  type: z.number().int(),
  data: z
    .object({
      name: z.string().optional(),
      options: z.array(discordOptionSchema).optional(),
      custom_id: z.string().optional(),
      component_type: z.number().int().optional(),
    })
    .optional(),
  member: z
    .object({
      user: z
        .object({
          id: discordIdSchema,
          username: z.string(),
        })
        .optional(),
    })
    .optional(),
  user: z
    .object({
      id: discordIdSchema,
      username: z.string(),
    })
    .optional(),
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
  status: z
    .enum(["Ongoing", "Completed", "Hiatus", "Dropped", "Unknown"])
    .optional(),
});

// Whitelist entry validation
export const whitelistEntrySchema = z.object({
  title: titleSchema,
  sources: z
    .array(
      z.object({
        source: sourceSchema,
        url: urlSchema.optional(),
        mark: z.enum(["Active", "Dead", "Unstable"]).optional(),
      }),
    )
    .min(1, "At least one source required"),
});

// Cron log entry validation
export const cronLogEntrySchema = z.object({
  time: dateStringSchema.optional(),
  tag: z
    .enum(["sent", "failed", "partial", "skipped", "info", "error"])
    .default("info"),
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

export type ValidationResult<T> =
  | { success: true; data: T }
  | { success: false; errors: string[] };

/**
 * Helper function to safely parse with zod.
 */
export function safeParse<T>(schema: z.ZodSchema<T>, data: any): ValidationResult<T> {
  const result = schema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  const errors = result.error.issues.map(
    (e: z.ZodIssue) => `${e.path.join(".")}: ${e.message}`,
  );
  return {
    success: false,
    errors,
  };
}

/**
 * Shared helper to validate data from Redis/JSON using Zod schemas.
 * Returns null and logs a warning on validation failure.
 */
export function validateData<T>(
  schema: z.ZodSchema<T>,
  data: unknown,
  context: string,
  logger: { warn: (obj: any, msg: string) => void }
): T | null {
  if (data === null || data === undefined) return null;

  const result = schema.safeParse(data);
  if (result.success) {
    return result.data;
  }

  logger.warn(
    {
      context,
      errors: result.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`),
      sample: typeof data === "string" ? data.substring(0, 100) : "object",
    },
    "Data validation failed"
  );
  return null;
}

/**
 * Helper to parse query params.
  * Note: Query params are always strings from HTTP. We only convert booleans here,
 * letting Zod schemas handle their own .transform() for numbers.
 */
export function parseQueryParams<T>(schema: z.ZodSchema<T>, query: any): ValidationResult<T> {
  try {
    const transformed: any = {};

    for (const [key, value] of Object.entries(query)) {
      if (value === "true" || value === "false") {
        transformed[key] = value === "true";
      } else {
        // Keep as string (or original value) - let Zod handle number transforms
        transformed[key] = value;
      }
    }

    return safeParse(schema, transformed);
  } catch (err: any) {
    return { success: false, errors: [err.message] };
  }
}

/**
 * Validate and throw if invalid.
 */
export function validateOrThrow<T>(schema: z.ZodSchema<T>, data: any, context = ""): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const errors = result.error.issues
      .map((e: z.ZodIssue) => `${e.path.join(".")}: ${e.message}`)
      .join(", ");
    throw new Error(
      `${context ? `${context} - ` : ""}Validation failed: ${errors}`,
    );
  }
  return result.data;
}

/**
 * Partial validation (for updates).
 */
export function partialValidate<T extends z.ZodObject<any>>(
  schema: T,
  data: any,
): ValidationResult<z.infer<T>> {
  return safeParse(schema.partial() as unknown as z.ZodSchema<z.infer<T>>, data);
}
