import { Request, Response } from "express";
import { isCronAuthorized } from "../lib/auth.js";
import { runCronJob } from "../lib/cronRuntime.js";
import { redis, withDistributedLock } from "../lib/redis.js";
import { withTimeout } from "../lib/utils.js";

import { loggers, logApiError, logApiHit, logApiOk } from "../lib/logger.js";
import { performFullHealthCheck } from "../lib/services/health.js";
import {
  createErrorResponse,
  createSuccessResponse,
} from "../lib/api/response.js";
import { waitUntil } from "@vercel/functions";
import { cronQuerySchema } from "../lib/schemas.js";
import { isQStashEnabled, publishScrapeTaskToQStash } from "../lib/services/qstash.js";
import { loadCronInputs, validateCronInputs } from "../lib/cron/inputs.js";
import { prewarmMetadataCache } from "../lib/services/metadata-enrichment.js";
import { handlePrefetchMetadata } from "../lib/cron/prefetch-metadata.js";



const validMethods = ["GET", "POST"];
const CRON_EXEC_LOCK_KEY = "cron:run:lock";
const CRON_EXEC_LOCK_TTL_SEC = 360; // Reduced to 6 minutes (360s) so stale locks expire well before the next 10-minute run, preventing false-positive lock timeouts
const INTERNAL_TIMEOUT_MS = 290_000; // 290 seconds (Vercel limit for some plans, but safe with waitUntil)

const logger = loggers.cron;
const ADMIN_REPORT_CHANNEL_ID = "1500721659915665549";




function parseBoolLike(value: unknown, fallback: boolean | null = null): boolean | null {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

async function handleUpdateCron(req: Request, res: Response, reqLogger: ReturnType<typeof logApiHit>, query: Record<string, unknown> = {}) {
  try {
    const forceUnlock = parseBoolLike(query?.forceUnlock, false);
    if (forceUnlock) {
      logger.info("Force unlocking cron via API");
      await redis.del(CRON_EXEC_LOCK_KEY);
    }

    const qstashEnabled = isQStashEnabled();
    if (qstashEnabled) {
      logger.info("QStash is enabled, delegating cron to parallel workers");
      
      const inputs = await loadCronInputs({ redis });
      const validation = validateCronInputs(inputs);
      
      if (!validation.valid) {
        logger.warn({ reason: validation.reason }, "Cron inputs invalid, skipping delegation");
        return res.status(200).json({ 
          ok: true, 
          skipped: true, 
          reason: validation.reason,
          timestamp: new Date().toISOString()
        });
      }

      const activeChannelIds = [...new Set(Object.values(inputs.guildChannels))];
      if (activeChannelIds.length === 0) {
        logger.warn("No active guild channels, skipping delegation");
        return res.status(200).json({ 
          ok: true, 
          skipped: true, 
          reason: "no_active_channels",
          timestamp: new Date().toISOString()
        });
      }

      const mode = String(query?.mode || "normal").toLowerCase();
      const forceFull = mode === "full";
      const fastMode = mode === "fast";
      const parsedFastLimit = Number(query?.fastLimit);
      const fastSecondaryLimit = Number.isFinite(parsedFastLimit)
        ? Math.max(0, Math.trunc(parsedFastLimit))
        : fastMode ? 4 : 0;

      const incremental = parseBoolLike(query?.incremental, forceFull ? false : null) ?? undefined;
      const deduplicate = parseBoolLike(query?.deduplicate, forceFull ? false : null) ?? undefined;

      const scrapeOptions = {
        incremental: incremental ?? !forceFull,
        deduplicate: deduplicate ?? !forceFull,
        fullRefresh: forceFull,
        force: forceFull,
        fastSecondaryLimit,
      };

      const providersToScrape = ["ikiru", "shinigami"] as const;
      const publishPromises = providersToScrape.map(source => 
        publishScrapeTaskToQStash({
          action: "scrape_source",
          source,
          channelIds: activeChannelIds,
          options: scrapeOptions
        })
      );
      
      const publishResults = await Promise.all(publishPromises);
      const ikiruSuccess = publishResults[0];
      const shinigamiSuccess = publishResults[1];
      
      logger.info({ ikiruSuccess, shinigamiSuccess }, "Scrape tasks published to QStash");

      if (!ikiruSuccess && !shinigamiSuccess) {
        logger.error("Failed to publish any scraping task to QStash");
        return res.status(502).json({
          ok: false,
          error: "QStash delegation failed: unable to publish tasks to workers",
          delegated: {
            ikiru: false,
            shinigami: false,
          },
          timestamp: new Date().toISOString(),
        });
      }

      // Pre-warm metadata cache asynchronously in the background
      waitUntil(
        prewarmMetadataCache(redis, 10).catch(err => {
          logger.error({ err }, "Error running prewarmMetadataCache in delegated cron path");
        })
      );

      return res.status(202).json({
        ok: true,
        message: "Scraping delegated to QStash workers",
        mode,
        delegated: {
          ikiru: ikiruSuccess,
          shinigami: shinigamiSuccess,
        },
        timestamp: new Date().toISOString()
      });
    }

    // Use waitUntil to run the cron job in the background and respond immediately
    waitUntil((async () => {
      try {
        await withDistributedLock(redis, CRON_EXEC_LOCK_KEY, async () => {
          const lifecycle: { currentStep: string } = { currentStep: "initializing" };
          const mode = String(query?.mode || "normal").toLowerCase();
          const forceFull = mode === "full";
          const fastMode = mode === "fast";
          const parsedFastLimit = Number(query?.fastLimit);
          const fastSecondaryLimit = Number.isFinite(parsedFastLimit)
            ? Math.max(0, Math.trunc(parsedFastLimit))
            : fastMode ? 4 : 0;

          const incremental = parseBoolLike(query?.incremental, forceFull ? false : null) ?? undefined;
          const deduplicate = parseBoolLike(query?.deduplicate, forceFull ? false : null) ?? undefined;

          const scrapeOptions = {
            incremental: incremental ?? !forceFull,
            deduplicate: deduplicate ?? !forceFull,
            fullRefresh: forceFull,
            force: forceFull,
            fastSecondaryLimit,
          };

          const result = await withTimeout(
            runCronJob({
              redisClient: redis,
              logger,
              scrapeOptions,
              lifecycle,
              deadlineMs: INTERNAL_TIMEOUT_MS,
            }),
            INTERNAL_TIMEOUT_MS,
            `Timeout dopo ${INTERNAL_TIMEOUT_MS}ms`,
            lifecycle,
          );

          // Optimization: Skip heavy health check in the main update flow
          // This should be its own separate cron task
          /*
          if (result.statusCode === 200) {
            await performFullHealthCheck();
          }
          */
          
          // Pre-warm metadata cache for any new/incomplete whitelist entries
          try {
            await prewarmMetadataCache(redis, 10);
          } catch (prewarmErr) {
            logger.error({ err: prewarmErr }, "Failed to pre-warm metadata cache in background cron");
          }
          
          logger.info({ status: result.statusCode, ...result.logMeta }, "Cron background job finished");
        }, { ttlSec: 45, timeoutMs: 0, label: "Cron", autoRenew: true });
      } catch (err: any) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ err: message }, "Cron background job failed");
        
        // Send error report to Admin Channel
        try {
          const { sendDiscordEmbed } = await import("../lib/discord/messaging.js");
          await sendDiscordEmbed({
            title: "⚠️ Cron Background Error",
            description: `**Details:** ${message}`,
            chapter: "System Audit",
            source: "system",
            url: "", // Required by DiscordEmbedData
            type: "report",
            status: "error",
            updatedTime: new Date().toISOString()
          }, ADMIN_REPORT_CHANNEL_ID, redis);
        } catch (reportErr) {
          logger.error({ err: reportErr instanceof Error ? reportErr.message : String(reportErr) }, "Failed to send error report to Discord");
        }
      }
    })());

    return res.status(202).json({
      ok: true,
      message: "Cron job started in background",
      mode: query?.mode || "normal",
      timestamp: new Date().toISOString()
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Gagal mendapatkan lock")) {
      const ttl = await redis.ttl(CRON_EXEC_LOCK_KEY);
      const lockMessage = ttl > 0
        ? `Cron job already running. Try again in ${ttl} seconds or use forceUnlock=1`
        : `Cron job lock conflict. Silakan coba lagi dalam beberapa detik atau gunakan forceUnlock=1`;

      logApiOk(reqLogger, { status: 409, reason: "cron_locked", ttl });
      return res.status(409).json(createErrorResponse("CRON_LOCKED", lockMessage));
    }
    logApiError(reqLogger, err, { status: 500 });
    return res.status(500).json(createErrorResponse("CRON_FAILED", message));
  }
}

async function handleHealthCheck(req: Request, res: Response, reqLogger: ReturnType<typeof logApiHit>) {
  try {
    const lifecycle = { currentStep: "health-check" };
    const brokenLinks = await withTimeout(performFullHealthCheck(), INTERNAL_TIMEOUT_MS, "Health check timeout", lifecycle);
    logApiOk(reqLogger, { status: 200, brokenCount: brokenLinks.length });
    return res.status(200).json(createSuccessResponse({ brokenLinks, count: brokenLinks.length }));
  } catch (err: unknown) {
    logApiError(reqLogger, err, { status: 500 });
    return res.status(500).json(createErrorResponse("HEALTH_CHECK_FAILED", err instanceof Error ? err.message : String(err)));
  }
}

async function handleDeadLinks(req: Request, res: Response, reqLogger: ReturnType<typeof logApiHit>) {
  try {
    const brokenLinks = await redis.get("health:broken-links");
    const parsed = typeof brokenLinks === "string" ? JSON.parse(brokenLinks) : brokenLinks || [];
    logApiOk(reqLogger, { status: 200, count: parsed.length });
    return res.status(200).json(createSuccessResponse({ deadLinks: parsed }));
  } catch (err: unknown) {
    logApiError(reqLogger, err, { status: 500 });
    return res.status(500).json(createErrorResponse("LINKS_CHECK_FAILED", err instanceof Error ? err.message : String(err)));
  }
}

export { shouldRunChannelValidation } from "../lib/cron/helpers.js";

export default async function handler(req: Request, res: Response) {
  const reqLogger = logApiHit("cron", req);

  if (!validMethods.includes(req.method || "")) {
    logApiOk(reqLogger, { status: 405, reason: "method_not_allowed" });
    return res.status(405).json(createErrorResponse("METHOD_NOT_ALLOWED", "Method not allowed"));
  }

  if (!await isCronAuthorized(req)) {
    logApiOk(reqLogger, { status: 401, reason: "unauthorized" });
    return res.status(401).json(createErrorResponse("UNAUTHORIZED", "Unauthorized"));
  }

  const queryParse = cronQuerySchema.safeParse(req.query);
  if (!queryParse.success) {
    logApiOk(reqLogger, { status: 400, reason: "invalid_query" });
    return res.status(400).json(createErrorResponse("INVALID_QUERY", "Invalid query parameters"));
  }

  const query = queryParse.data;

  switch (query.action) {
    case "update":
      return handleUpdateCron(req, res, reqLogger, query);
    case "health":
      return handleHealthCheck(req, res, reqLogger);
    case "links":
      return handleDeadLinks(req, res, reqLogger);
    case "prefetch-metadata":
      return handlePrefetchMetadata(req, res);
    default:
      return res.status(400).json(createErrorResponse("INVALID_ACTION", "Invalid action"));
  }
}
