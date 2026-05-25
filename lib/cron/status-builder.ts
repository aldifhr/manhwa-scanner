/**
 * Cron job status payload building
 */

import { getLogger } from "../logger.js";
import { writeCronStatus, appendLiveEvent } from "../services/storage.js";
import { appendCronLog } from "../cronLogs.js";
import type {
  RedisClient,
  CronStatus,
  SourceHealth,
  ScraperMetrics,
  TimingMetrics,
  SkipBreakdown,
} from "../types.js";
import { finalizeTimingMetrics } from "./helpers.js";

const logger = getLogger({ scope: "cron:status" });

export interface StatusBuildOptions {
  redis: RedisClient;
  start: number;
  sent: number;
  skipped: number;
  failed: number;
  enqueued?: number;
  guilds: number;
  whitelist: number;
  hibernated?: number;
  incrementalSaved?: number;
  sourceHealth: Record<string, SourceHealth>;
  scrapeMetrics?: Record<string, ScraperMetrics | null>;
  timingMetrics: TimingMetrics;
  skipBreakdown?: SkipBreakdown | null;
}

export interface ErrorStatusOptions {
  redis: RedisClient;
  start: number;
  error: string;
  step?: string;
}

/**
 * Build success status payload
 */
export function buildSuccessStatus(
  options: StatusBuildOptions,
): CronStatus {
  const {
    start,
    sent,
    skipped,
    failed,
    enqueued = 0,
    guilds,
    whitelist,
    hibernated = 0,
    incrementalSaved = 0,
    sourceHealth,
    scrapeMetrics,
    timingMetrics,
    skipBreakdown = null,
  } = options;

  const duration = ((Date.now() - start) / 1000).toFixed(1);

  return {
    sent,
    skipped,
    failed,
    enqueued,
    duration,
    guilds,
    whitelist,
    hibernated,
    incrementalSaved,
    timestamp: new Date().toISOString(),
    sourceHealth,
    scrapeMetrics,
    timingMetrics: finalizeTimingMetrics(start, timingMetrics),
    outcome: failed > 0 ? "partial" : "ok",
    shortCircuitReason: null,
    skipBreakdown,
    tag: failed > 0 ? "partial" : "sent",
    message: `Cron completed: ${sent} sent, ${skipped} skipped${failed > 0 ? `, ${failed} failed` : ""}`,
  };
}

/**
 * Build error/panic status payload
 */
export function buildErrorStatus(
  options: ErrorStatusOptions,
): CronStatus {
  const { start, error, step } = options;
  const duration = ((Date.now() - start) / 1000).toFixed(1);

  return {
    sent: 0,
    skipped: 0,
    failed: 0,
    duration,
    guilds: 0,
    whitelist: 0,
    timestamp: new Date().toISOString(),
    outcome: "panic_error",
    error: step ? `${error} during ${step}` : error,
    shortCircuitReason: "unhandled_exception",
    tag: "failed",
    message: step ? `Critical error: ${error} during ${step}` : `Critical error: ${error}`,
  };
}

/**
 * Write success status to Redis and log
 */
export async function writeSuccessStatus(
  options: StatusBuildOptions,
): Promise<void> {
  const statusPayload = buildSuccessStatus(options);

  await Promise.all([
    appendCronLog(options.redis, statusPayload as any).catch(
      (err: unknown) => {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "Failed to append cron log",
        );
      },
    ),
    writeCronStatus(options.redis, statusPayload),
  ]);

  // Log summary
  logger.info(
    {
      duration: statusPayload.duration,
      sent: statusPayload.sent,
      skipped: statusPayload.skipped,
      failed: statusPayload.failed,
      guilds: statusPayload.guilds,
    },
    "Cron completed",
  );

  // Live event
  await appendLiveEvent(options.redis, {
    message: `Cron finished: Sent ${statusPayload.sent} chapters to ${statusPayload.guilds} guilds in ${statusPayload.duration}s`,
    type: "success",
  });
}

/**
 * Write error status to Redis
 */
export async function writeErrorStatus(
  options: ErrorStatusOptions,
): Promise<void> {
  const errorStatus = buildErrorStatus(options);

  try {
    await writeCronStatus(options.redis, errorStatus);
  } catch (err: unknown) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Failed to write panic status",
    );
  }
}
