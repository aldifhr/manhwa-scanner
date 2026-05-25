import { redis } from "../lib/redis.js";
import {
  DISCORD_GUILDS_COUNT_KEY,
  NOTIFICATION_QUEUE_KEY,
  NOTIFICATION_PROCESSING_QUEUE_KEY,
  SOURCE_KEYS,
} from "../lib/constants/redis.js";
import { loadSourceHealthSnapshot } from "../lib/services/storage.js";
import { readCronStatusWithHealth } from "../lib/cronRuntime.js";
import { readCronDailyStats, CronDailyStats } from "../lib/cronLogs.js";
import { logApiError, logApiHit, logApiOk, getLogger } from "../lib/logger.js";
import { HEALTH_CACHE_TTL_MS } from "../lib/config.js";
import { isMonitorAuthorized } from "../lib/auth.js";
import { createEdgeResponse, createErrorResponse } from "../lib/api/response.js";
import { supabase } from "../lib/supabase.js";
import { mangaProviderRegistry } from "../lib/providers/registry.js";
import { initializeAllProviders } from "../lib/boot.js";
import { getSupabasePing, getDiscordPing, getRedisPing, getQueueStats, formatResponseTime, getProviderMetrics } from "../lib/services/health.js";

import { findCronJob, getCronNextRuns, getCronLogs, FastCronExecutionResult } from "../lib/services/fastcron.js";

const logger = getLogger({ scope: "health-status" });



function formatMinutes(minutes: number): string {
  if (minutes < 1) return "Soon";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

export const config = {
  runtime: "edge",
};

const SOURCE_NAMES: Record<string, string> = {
  ikiru: "Ikiru",
  shinigami: "Shinigami",
};

function calculateUptime(stats: CronDailyStats[], fallbackRuns: number = 0, fallbackFails: number = 0): string {
  if (!stats || stats.length === 0) {
    if (fallbackRuns > 0) {
      const pct = ((fallbackRuns - fallbackFails) / fallbackRuns) * 100;
      return `${pct.toFixed(1)}%`;
    }
    return "—";
  }

  let totalNum = 0;
  let failedNum = 0;
  let hasAnyActivity = false;

  for (const day of stats) {
    // Per-source keys (source:ikiru etc.) are not written — logs use source:dispatch.
    // Always compute uptime from overall daily totals.
    totalNum += day.runs || 0;
    failedNum += (day.failedLogs || 0) + (day.deliveryFailed || 0);
    if ((day.runs || 0) > 0) hasAnyActivity = true;
  }

  // Include fallback data for today if stats are stale
  if (fallbackRuns > 0 && totalNum === 0) {
    totalNum = fallbackRuns;
    failedNum = fallbackFails;
    hasAnyActivity = true;
  }

  if (!hasAnyActivity || totalNum === 0) return "—";

  const pct = ((totalNum - failedNum) / totalNum) * 100;
  return `${pct.toFixed(2)}%`;
}

const CACHE_KEY = "api:health-status:cache:v1";

export default async function handler(req: Request) {
  const reqLogger = logApiHit("health-status", req);

  // Extract query params
  let realtime = false;
  try {
    const url = new URL(req.url);
    realtime = url.searchParams.get("realtime") === "true" || url.searchParams.get("realtime") === "1";
  } catch {
    const urlStr = String(req.url || "");
    const queryIndex = urlStr.indexOf("?");
    if (queryIndex !== -1) {
      const params = new URLSearchParams(urlStr.slice(queryIndex + 1));
      realtime = params.get("realtime") === "true" || params.get("realtime") === "1";
    }
  }

  try {
    const authorized = await isMonitorAuthorized(req);
    if (!authorized) {
      return createEdgeResponse(createErrorResponse("UNAUTHORIZED", "Unauthorized"), 401);
    }

    if (!realtime) {
      const cached = await redis.get(CACHE_KEY);
      if (cached) {
        const parsed = typeof cached === "string" ? JSON.parse(cached) : cached;
        logApiOk(reqLogger, { status: 200, cached: true });
        return createEdgeResponse({ ...parsed, cached: true });
      }
    }

    // Fetch FastCron data
    let fastCronStatus: Record<string, unknown> | null = null;
    try {
      const job = await findCronJob("ikiru");
      if (job) {
        const [nextRuns, logs] = await Promise.all([
          getCronNextRuns(job.id),
          getCronLogs(job.id),
        ]);
        const log0 = logs && logs.length > 0 ? logs[0] as FastCronExecutionResult : null;
        fastCronStatus = {
          jobFound: true,
          nextRun: nextRuns && nextRuns.length > 0 ? {
            minutesRemaining: Math.max(0, Math.round((nextRuns[0] * 1000 - Date.now()) / 60000)),
            formattedTime: formatMinutes(Math.max(0, Math.round((nextRuns[0] * 1000 - Date.now()) / 60000))),
          } : null,
          latestExecution: log0 ? {
            responseTimeMs: Math.round((log0.result?.executionTime || 0) * 1000),
            responseTime: formatResponseTime(Math.round((log0.result?.executionTime || 0) * 1000)),
            success: log0.result?.status === 0,
          } : null,
        };
      }
    } catch (err: unknown) {
      logger.debug({ err: err instanceof Error ? err.message : String(err) }, "FastCron fetch failed");
    }

    const [
      sourceHealth,
      cronStatus,
      dailyStats,
      guildCount,
      redisPing,
      queueStats,
      discordPing,
      supabasePing,
      providerMetrics,
    ] = await Promise.all([
      loadSourceHealthSnapshot(redis, SOURCE_KEYS),
      readCronStatusWithHealth(redis),
      readCronDailyStats(redis, 7, new Date(), true).then(s => s || []),
      redis.get(DISCORD_GUILDS_COUNT_KEY).then(c => c ? parseInt(c as string, 10) : null),
      getRedisPing(),
      getQueueStats(),
      getDiscordPing(),
      getSupabasePing(),
      getProviderMetrics(),
    ]);

    // Get current run data for fallback when historical stats not yet available
    const cronStatus_ = cronStatus as Record<string, unknown> | null;
    const cronRunCount = Number(cronStatus_?.sent || 0);
    const cronFailCount = Number(cronStatus_?.failed || 0);
    const hasLiveData = cronRunCount > 0;

    const overallUptime = calculateUptime(dailyStats, hasLiveData ? cronRunCount : 0, hasLiveData ? cronFailCount : 0);

    const mangaSources = await Promise.all(SOURCE_KEYS.map(async source => {
      const h = sourceHealth[source];
      const failures = h?.consecutiveFailures || 0;
      
      // Fetch last update time from health monitor keys
      const lastUpdateKey = `health:last_update:${source}`;
      const lastUpdateStr = await redis.get(lastUpdateKey);
      const lastUpdateAt = lastUpdateStr ? parseInt(lastUpdateStr as string, 10) : null;
      
      const STALE_THRESHOLD_MS = 6 * 60 * 60 * 1000;
      const isStale = lastUpdateAt ? (Date.now() - lastUpdateAt > STALE_THRESHOLD_MS) : true;

      const status = h?.status
        ? (failures >= 3 ? "failed" : h.status)
        : (failures >= 3 ? "failed" : (failures > 0 ? "degraded" : "healthy"));

      const incidents: string[] = [];
      const degraded: string[] = [];
      dailyStats.forEach(stat => {
        const raw = (stat as unknown as { raw?: Record<string, number> }).raw || {};
        if (Number(raw[`source:${source}:tag:failed`])) incidents.push(stat.date);
        else if (Number(raw[`source:${source}:tag:partial`])) degraded.push(stat.date);
      });

      const indicator = status === "healthy"
        ? (isStale ? "yellow" : "green")
        : (status === "degraded" ? "yellow" : "red");

      // Use source-specific data from health if available
      const sourceFails = h?.consecutiveFailures || 0;

      return {
        name: SOURCE_NAMES[source] ?? source,
        uptime: calculateUptime(dailyStats, 0, sourceFails),
        ping: formatResponseTime(h?.responseTime ?? null),
        rawResponseTime: h?.responseTime ?? null,
        incidents,
        degraded,
        status: isStale && status === "healthy" ? "stale" : status,
        indicator,
        lastUpdateAt,
        isStale,
        lastError: h?.lastError || null,
        disabledUntil: h?.disabledUntil || null,
        consecutiveFailures: failures,
      };
    }));

    let cronDurationMs: number | null = null;
    if (cronStatus?.duration) {
      const parsedDuration = parseFloat(String(cronStatus.duration));
      if (!isNaN(parsedDuration)) {
        cronDurationMs = Math.round(parsedDuration * 1000);
      }
    }

    const systemServices: any[] = [
      {
        name: "Discord API",
        uptime: overallUptime,
        ping: formatResponseTime(discordPing),
        incidents: [],
        status: (discordPing !== null && discordPing < 5000) ? "healthy" : "degraded",
        note: "Verified via gateway"
      },
      {
        name: "Redis Database",
        uptime: (redisPing ?? 0) < 1000 ? overallUptime : "0.00%",
        ping: formatResponseTime(redisPing),
        incidents: [],
        status: (redisPing ?? 0) < 1000 ? "healthy" : "failed"
      },
      {
        name: "Cron Scheduler",
        uptime: overallUptime,
        ping: (fastCronStatus?.latestExecution as { responseTimeMs?: number })?.responseTimeMs
          ? formatResponseTime((fastCronStatus!.latestExecution as { responseTimeMs: number }).responseTimeMs)
          : formatResponseTime(cronDurationMs),
        incidents: cronStatus_?.outcome === "failed" ? [new Date().toISOString().split("T")[0]] : [],
        status: cronStatus_?.outcome === "failed" ? "failed" : "healthy",
        note: fastCronStatus?.nextRun
          ? `Next run: ${(fastCronStatus.nextRun as Record<string, unknown>).formattedTime}`
          : `Last run: ${cronStatus_?.timestamp ? new Date(String(cronStatus_.timestamp)).toLocaleString("id-ID") : "never"}`,
      },
      {
        name: "Supabase DB",
        uptime: overallUptime,
        ping: formatResponseTime(supabasePing),
        incidents: [], 
        status: (supabasePing !== null) ? "healthy" : "failed",
        note: "Primary persistence"
      },
    ];

    const networks = [
      { name: "Manga Sources", open: true, services: mangaSources },
      { name: "System Services", open: false, services: systemServices },
    ];

    const hasFailed = networks.some(n => n.services.some(s => s.status === "failed" || (s.consecutiveFailures || 0) >= 3));
    const hasDegraded = networks.some(n => n.services.some(s => s.status === "degraded" || ((s.consecutiveFailures || 0) > 0 && (s.consecutiveFailures || 0) < 3)));

    const payload = {
      networks,
      dailyStats,
      cached: false,
      overallStatus: hasFailed ? "critical" : (hasDegraded ? "degraded" : "healthy"),
      lastUpdated: new Date().toISOString(),
      uptime: overallUptime,
      totalIncidents: networks.reduce((acc, n) => acc + n.services.reduce((a2, s) => a2 + s.incidents.length, 0), 0),
      queueStats,
      guildCount,
      cronStatus: cronStatus_ ? {
        lastRun: cronStatus_.lastRun || null,
        sent: cronStatus_.sent || 0,
        skipped: cronStatus_.skipped || 0,
        failed: cronStatus_.failed || 0,
        duration: cronStatus_.duration ? `${Math.round(Number(cronStatus_.duration))}s` : "-",
        outcome: cronStatus_.outcome || "unknown",
      } : null,
      fastCron: fastCronStatus,
      providerMetrics,
    };

    if (!realtime) {
      await redis.set(CACHE_KEY, JSON.stringify(payload), { ex: Math.floor(HEALTH_CACHE_TTL_MS / 1000) });
    }

    logApiOk(reqLogger, { status: 200, cached: false });
    return createEdgeResponse(payload);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({
      err: message,
      type: err instanceof Error ? err.constructor?.name : typeof err,
    }, "[health-status] Error");
    logApiError(reqLogger, err, { status: 500 });
    return createEdgeResponse(
      { error: "Internal error", details: message, networks: [], overallStatus: "unknown" },
      500
    );
  }
}
