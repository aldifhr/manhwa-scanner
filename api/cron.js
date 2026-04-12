import { isCronAuthorized } from "../lib/auth.js";
import { appendCronLog, buildCronErrorLog } from "../lib/cronLogs.js";
import { runCronJob, shouldRunChannelValidation } from "../lib/cronRuntime.js";
import { loggers, logApiError, logApiHit, logApiOk } from "../lib/logger.js";
import { getAllGuildChannels, redis, writeCronStatus } from "../lib/redis.js";
import { performFullHealthCheck } from "../lib/services/health.js";
import { sendDiscordEmbed } from "../lib/discord.js";
import { rateLimiters } from "../lib/rateLimiter.js";
import { z } from "zod";
import {
  createErrorResponse,
  createSuccessResponse,
} from "../lib/api/response.js";

// Validation schemas
// "links" is alias for "health" (backward compatibility)
const cronQuerySchema = z.object({
  action: z.enum(["update", "health", "links"]).default("update"),
  mode: z.enum(["normal", "full", "fast"]).optional(),
  incremental: z.enum(["0", "1", "false", "true"]).optional(),
  deduplicate: z.enum(["0", "1", "false", "true"]).optional(),
  fastLimit: z.string().optional(),
});

const validMethods = ["GET", "POST"];
const MAX_DEAD_LINKS_DISPLAY = 15;
const CRON_EXEC_LOCK_KEY = "cron:run:lock";
const CRON_EXEC_LOCK_TTL_SEC = 60;
const HEALTH_STATUS_KEY = "health:last_status";
// Keep timeout close to function maxDuration (30s) to avoid false "fatal"
// while long-running scrape/dispatch is still legitimately completing.
const INTERNAL_TIMEOUT_MS = 28_000;

// Use env variable for max duration, fallback to 30s (FastCron free tier)
export const config = { maxDuration: 30 };
const logger = loggers.cron;

export { shouldRunChannelValidation };

function withTimeout(promise, timeoutMs = INTERNAL_TIMEOUT_MS, lifecycle = null) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const phaseInfo = lifecycle?.currentStep ? ` during ${lifecycle.currentStep}` : "";
      reject(new Error(`Timeout after ${timeoutMs}ms${phaseInfo}`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function acquireCronExecutionLock() {
  const lockToken = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const acquired = await redis.set(CRON_EXEC_LOCK_KEY, lockToken, {
    nx: true,
    ex: CRON_EXEC_LOCK_TTL_SEC,
  });
  if (acquired !== "OK") return null;
  return lockToken;
}

async function releaseCronExecutionLock(lockToken) {
  if (!lockToken) return;
  try {
    const current = await redis.get(CRON_EXEC_LOCK_KEY);
    if (current === lockToken) {
      await redis.del(CRON_EXEC_LOCK_KEY);
    }
  } catch (err) {
    logger.warn({ err: err.message }, "Failed releasing cron execution lock");
  }
}

async function writeHealthStatus(payload) {
  try {
    await redis.set(HEALTH_STATUS_KEY, JSON.stringify(payload));
  } catch (err) {
    logger.error("[health] Failed to write health status:", err.message);
  }
}

function parseBoolLike(value, fallback = null) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

async function handleUpdateCron(req, res, reqLogger, query = {}) {
  const lockToken = await acquireCronExecutionLock();
  if (!lockToken) {
    logApiOk(reqLogger, { status: 409, reason: "cron_locked" });
    return res
      .status(409)
      .json(
        createErrorResponse("CRON_LOCKED", "Cron job already running"),
      );
  }

  try {
    const mode = String(query?.mode || "normal").toLowerCase();
    const forceFull = mode === "full";
    const fastMode = mode === "fast";
    const parsedFastLimit = Number(query?.fastLimit);
    const fastSecondaryLimit = Number.isFinite(parsedFastLimit)
      ? Math.max(0, Math.trunc(parsedFastLimit))
      : fastMode
        ? 4
        : 0;
    const incremental =
      parseBoolLike(query?.incremental, forceFull ? false : null) ?? undefined;
    const deduplicate =
      parseBoolLike(query?.deduplicate, forceFull ? false : null) ?? undefined;

    const scrapeOptions = {
      incremental,
      deduplicate,
      fullRefresh: forceFull,
      force: forceFull,
      fastSecondaryLimit,
    };

    const lifecycle = { currentStep: "initializing" };
    const result = await withTimeout(
      runCronJob({
        redisClient: redis,
        logger,
        scrapeOptions,
        lifecycle,
        deadlineMs: INTERNAL_TIMEOUT_MS,
      }),
      INTERNAL_TIMEOUT_MS,
      lifecycle,
    );
    logApiOk(reqLogger, { status: result.statusCode, ...result.logMeta });

    const standardizedBody = {
      success: result.body?.ok === true,
      data: {
        sent: result.body?.sent ?? 0,
        skipped: result.body?.skipped ?? 0,
        skipBreakdown: result.body?.skipBreakdown ?? null,
        failed: result.body?.failed ?? 0,
        enqueued: result.body?.enqueued ?? 0,
        duration: result.body?.duration ?? null,
        guilds: result.body?.guilds ?? 0,
        whitelist: result.body?.whitelist ?? null,
        scraped: result.body?.scraped ?? null,
        outcome: result.body?.outcome ?? null,
        shortCircuitReason: result.body?.shortCircuitReason ?? null,
        sourceHealth: result.body?.sourceHealth ?? null,
        scrapeMetrics: result.body?.scrapeMetrics ?? null,
        timingMetrics: result.body?.timingMetrics ?? null,
        error: result.body?.error ?? null,
        scrapeOptionsUsed: scrapeOptions,
      },
      timestamp: new Date().toISOString(),
    };

    // Hot-start worker trigger (fire & forget)
    if (standardizedBody.data.enqueued > 0) {
      const baseUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `http://${req.headers.host}`;
      const workerUrl = `${baseUrl}/api/worker?token=${process.env.WORKER_TOKEN}`;

      fetch(workerUrl).catch(err => {
        logger.warn({ err: err.message }, "Failed to hot-start worker");
      });
    }

    return res.status(result.statusCode).json(standardizedBody);
  } catch (err) {
    logger.error({ err: err.message }, "fatal");
    const statusPayload = {
      sent: 0,
      skipped: 0,
      failed: 1,
      duration: null,
      guilds: 0,
      timestamp: new Date().toISOString(),
      sourceHealth: {},
      scrapeMetrics: null,
      outcome: "fatal_error",
      shortCircuitReason: "fatal_error",
      error: err?.message || "Internal error",
    };
    await writeCronStatus(redis, statusPayload).catch((err) => {
      logger.error("[cron] Failed to write status:", err.message);
    });
    await appendCronLog(
      redis,
      buildCronErrorLog(err, {
        code: "cron_fatal",
        type: "runtime_error",
        source: "cron",
      }),
    ).catch((err) => {
      logger.error("[cron] Failed to append cron log:", err.message);
    });
    logApiError(reqLogger, err, { status: 500 });
    return res
      .status(500)
      .json(
        createErrorResponse(
          "CRON_FATAL",
          process.env.NODE_ENV === "production"
            ? "Internal error"
            : err.message,
        ),
      );
  } finally {
    await releaseCronExecutionLock(lockToken);
  }
}

async function handleHealthCron(req, res, reqLogger) {
  const start = Date.now();
  logger.info("Starting scheduled link health check...");

  try {
    const deadLinks = await withTimeout(
      performFullHealthCheck(),
      INTERNAL_TIMEOUT_MS,
    );
    const duration = ((Date.now() - start) / 1000).toFixed(1);

    logger.info({ dead: deadLinks.length, duration }, "Link check complete");

    if (deadLinks.length > 0) {
      const guildChannels = await getAllGuildChannels().catch(() => ({}));
      const channelIds = Object.values(guildChannels || {}).filter(Boolean);

      if (channelIds.length > 0) {
        const deadListStr = deadLinks
          .slice(0, MAX_DEAD_LINKS_DISPLAY)
          .map((d) => `• **${d.title}** (${d.source}): ${d.url}`)
          .join("\n");
        const suffix =
          deadLinks.length > MAX_DEAD_LINKS_DISPLAY
            ? `\n...dan ${deadLinks.length - MAX_DEAD_LINKS_DISPLAY} lainnya.`
            : "";
        const embed = {
          title: "⚠️ Laporan Link Mati (Bi-Weekly)",
          description: `Ditemukan **${deadLinks.length}** link yang tidak aktif di whitelist.\n\n${deadListStr}${suffix}`,
          color: 0xe74c3c,
          footer: { text: "Hapus link mati menggunakan /remove <Judul>." },
          timestamp: new Date().toISOString(),
        };

        await Promise.all(
          channelIds.map(async (channelId) => {
            const res = await sendDiscordEmbed(embed, channelId);
            if (res && (res.status === 403 || res.status === 404)) {
              const guildChannels = await getAllGuildChannels().catch(() => ({}));
              const guildId = Object.keys(guildChannels).find(
                (gid) => guildChannels[gid] === channelId,
              );
              if (guildId) {
                logger.warn(
                  { guildId, channelId, status: res.status },
                  "CLEANUP (Health): Deleting stale channel",
                );
                await deleteGuildChannel(guildId).catch((e) =>
                  logger.error(
                    { gid: guildId, err: e.message },
                    "Failed cleanup",
                  ),
                );
              }
            } else if (!res.success) {
              logger.warn(
                { channelId, err: res.error },
                "Failed to send dead link alert",
              );
            }
          }),
        );
      }
    }

    logApiOk(reqLogger, { status: 200, dead: deadLinks.length });
    return res.status(200).json(
      createSuccessResponse({
        deadLinks: deadLinks.length,
        duration: `${duration}s`,
        checkedAt: new Date().toISOString(),
      }),
    );
  } catch (err) {
    logger.error({ err: err.message }, "Scheduled link check failed");

    // Keep health status separate so it does not overwrite cron update status.
    await writeHealthStatus({
      failed: 1,
      timestamp: new Date().toISOString(),
      outcome: "health_check_failed",
      error: err?.message || "Health check failed",
    });

    await appendCronLog(
      redis,
      buildCronErrorLog(err, {
        code: "health_check_fatal",
        type: "runtime_error",
        source: "health",
      }),
    ).catch((e) => logger.error("[cron] Failed to append cron log:", e.message));

    logApiError(reqLogger, err, { status: 500 });
    return res
      .status(500)
      .json(
        createErrorResponse(
          "HEALTH_CHECK_FAILED",
          process.env.NODE_ENV === "production"
            ? "Internal error"
            : err.message,
        ),
      );
  }
}

export default async function handler(req, res) {
  const reqLogger = logApiHit("cron", req);

  // Method validation
  if (!validMethods.includes(req.method)) {
    logApiOk(reqLogger, { status: 405, reason: "method_not_allowed" });
    return res
      .status(405)
      .json(createErrorResponse("METHOD_NOT_ALLOWED", "Method not allowed"));
  }

  if (!isCronAuthorized(req)) {
    logApiOk(reqLogger, { status: 401, reason: "unauthorized" });
    return res
      .status(401)
      .json(createErrorResponse("UNAUTHORIZED", "Unauthorized"));
  }

  // Per-key rate limiting for cron endpoint.
  const auth = String(req.headers.authorization || "");
  const ip = String(
    req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown",
  )
    .split(",")[0]
    .trim();
  const limiterKey = auth ? `auth:${auth.slice(-16)}` : `ip:${ip}`;
  try {
    await rateLimiters.cron.consume(limiterKey);
  } catch (rejRes) {
    const retryAfter = Math.max(
      1,
      Math.round(Number(rejRes?.msBeforeNext || 1000) / 1000),
    );
    logApiOk(reqLogger, { status: 429, reason: "rate_limited", retryAfter });
    return res.status(429).json(
      createErrorResponse(
        "CRON_RATE_LIMITED",
        `Too many cron requests. Retry in ${retryAfter}s.`,
      ),
    );
  }

  // Query parameter validation with Zod
  const parseResult = cronQuerySchema.safeParse(req.query);
  if (!parseResult.success) {
    logApiOk(reqLogger, { status: 400, reason: "invalid_query", errors: parseResult.error.errors });
    return res
      .status(400)
      .json(createErrorResponse(
        "INVALID_QUERY",
        "Invalid query parameters",
        process.env.NODE_ENV === "development" ? parseResult.error.errors : undefined,
      ));
  }

  const { action } = parseResult.data;
  if (action === "update" && req.method !== "POST") {
    logApiOk(reqLogger, { status: 405, reason: "update_requires_post" });
    return res
      .status(405)
      .json(createErrorResponse("METHOD_NOT_ALLOWED", "Use POST for update"));
  }

  if (action === "health" || action === "links") {
    return handleHealthCron(req, res, reqLogger);
  }
  return handleUpdateCron(req, res, reqLogger, parseResult.data);
}
