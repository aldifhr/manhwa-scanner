import { isCronAuthorized } from "../lib/auth.js";
import { appendCronLog, buildCronErrorLog } from "../lib/cronLogs.js";
import { runCronJob, shouldRunChannelValidation } from "../lib/cronRuntime.js";
import { loggers, logApiError, logApiHit, logApiOk } from "../lib/logger.js";
import { getAllGuildChannels, redis, writeCronStatus } from "../lib/redis.js";
import { performFullHealthCheck } from "../lib/services/health.js";
import { sendDiscordEmbed } from "../lib/discord.js";
import { z } from "zod";
import {
  createErrorResponse,
  createSuccessResponse,
} from "../lib/api/response.js";

// Validation schemas
// "links" is alias for "health" (backward compatibility)
const cronQuerySchema = z.object({
  action: z.enum(["update", "health", "links"]).default("update"),
});

const validMethods = ["GET", "POST"];
const MAX_DEAD_LINKS_DISPLAY = 15;

// Use env variable for max duration, fallback to 30s (FastCron free tier)
export const config = { maxDuration: 30 };
const logger = loggers.cron;

export { shouldRunChannelValidation };

async function handleUpdateCron(req, res, reqLogger) {
  try {
    const result = await runCronJob({ redisClient: redis, logger });
    logApiOk(reqLogger, { status: result.statusCode, ...result.logMeta });

    const standardizedBody = {
      success: result.body?.ok === true,
      data: {
        sent: result.body?.sent ?? 0,
        skipped: result.body?.skipped ?? 0,
        failed: result.body?.failed ?? 0,
        duration: result.body?.duration,
        guilds: result.body?.guilds,
        outcome: result.body?.outcome,
        shortCircuitReason: result.body?.shortCircuitReason,
        sourceHealth: result.body?.sourceHealth,
        scrapeMetrics: result.body?.scrapeMetrics,
        timingMetrics: result.body?.timingMetrics,
      },
      timestamp: new Date().toISOString(),
    };

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
  }
}

async function handleHealthCron(req, res, reqLogger) {
  const start = Date.now();
  logger.info("Starting scheduled link health check...");

  try {
    const deadLinks = await performFullHealthCheck();
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
          channelIds.map((channelId) =>
            sendDiscordEmbed(channelId, embed).catch((err) =>
              logger.warn(
                { channelId, err: err.message },
                "Failed to send dead link alert",
              ),
            ),
          ),
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

    // Log error to Redis (consistent with handleUpdateCron)
    await writeCronStatus(redis, {
      sent: 0,
      skipped: 0,
      failed: 1,
      duration: null,
      guilds: 0,
      timestamp: new Date().toISOString(),
      sourceHealth: {},
      scrapeMetrics: null,
      outcome: "fatal_error",
      shortCircuitReason: "health_check_failed",
      error: err?.message || "Health check failed",
    }).catch((e) => logger.error("[cron] Failed to write status:", e.message));

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
  if (action === "health" || action === "links") {
    return handleHealthCron(req, res, reqLogger);
  }
  return handleUpdateCron(req, res, reqLogger);
}
