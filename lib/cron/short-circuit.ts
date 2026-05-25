/**
 * Cron job short-circuit / early exit handlers
 */

import { getLogger } from "../logger.js";
import { writeCronStatus } from "../services/storage.js";
import { appendCronLogThrottled } from "../cronLogs.js";
import type { RedisClient, CronStatus, SourceHealth, TimingMetrics } from "../types.js";
import { finalizeTimingMetrics } from "./helpers.js";

const logger = getLogger({ scope: "cron:short-circuit" });

export interface ShortCircuitOptions {
  redis: RedisClient;
  start: number;
  reason: string;
  whitelist: number;
  guilds: number;
  sourceHealth: Record<string, SourceHealth>;
  timingMetrics: TimingMetrics;
  message?: string;
  details?: string;
  logThrottleSec?: number;
}

export interface ShortCircuitResult {
  statusCode: number;
  body: Record<string, unknown>;
  logMeta: Record<string, unknown>;
}

/**
 * Build short circuit status payload
 */
export function buildShortCircuitStatus(options: {
  reason: string;
  start: number;
  guilds: number;
  whitelist: number;
  sourceHealth: Record<string, SourceHealth>;
  timingMetrics: TimingMetrics;
}): Omit<CronStatus, "timestamp"> {
  const { reason, start, guilds, whitelist, sourceHealth, timingMetrics } = options;

  return {
    sent: 0,
    skipped: 0,
    failed: 0,
    duration: ((Date.now() - start) / 1000).toFixed(1),
    guilds,
    whitelist,
    hibernated: 0,
    incrementalSaved: 0,
    sourceHealth,
    timingMetrics,
    outcome: "short_circuit",
    shortCircuitReason: reason,
  };
}

/**
 * Handle short-circuit exit with proper logging and status
 */
export async function handleShortCircuit(
  options: ShortCircuitOptions,
): Promise<ShortCircuitResult> {
  const {
    redis,
    start,
    reason,
    whitelist,
    guilds,
    sourceHealth,
    timingMetrics,
    message,
    logThrottleSec = 300,
  } = options;

  const statusPayload = buildShortCircuitStatus({
    reason,
    start,
    guilds,
    whitelist,
    sourceHealth,
    timingMetrics: finalizeTimingMetrics(start, timingMetrics),
  });

  await writeCronStatus(redis, statusPayload);

  // Log the short circuit
  const logCode = reason;
  const logMessage = message || getShortCircuitMessage(reason);

  await appendCronLogThrottled(
    redis,
    {
      tag: "info",
      code: logCode,
      type: "short_circuit",
      source: "cron",
      message: logMessage,
    },
    logThrottleSec,
  );

  logger.info({ reason, guilds, whitelist }, `Cron short-circuit: ${reason}`);

  return {
    statusCode: 200,
    body: {
      ok: true,
      ...statusPayload,
      message: logMessage,
    },
    logMeta: { reason },
  };
}

function getShortCircuitMessage(reason: string): string {
  const messages: Record<string, string> = {
    no_whitelist: "Cron skipped because whitelist is empty.",
    no_guilds: "Cron skipped because no guild channels found.",
    no_active_guilds: "Cron skipped because no active guilds were available.",
    queue_backpressure: "Cron skipped due to queue backpressure.",
    already_running: "Cron is already running in another instance.",
  };
  return messages[reason] || `Cron short-circuit: ${reason}`;
}

/**
 * Check if result is a short-circuit response
 */
export function isShortCircuitResult(
  result: unknown,
): result is ShortCircuitResult {
  return (
    typeof result === "object" &&
    result !== null &&
    "logMeta" in result &&
    typeof (result as ShortCircuitResult).logMeta === "object"
  );
}
