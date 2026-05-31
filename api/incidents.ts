import { env } from "../lib/config/env.js";
import type { Request, Response } from "express";
import {
  INCIDENT_CACHE_KEY,
  DISCORD_NOTIFICATION_FAILURES_KEY,
  SOURCE_KEYS,
  LOGS_API_CACHE_KEY,
} from "../lib/constants/redis.js";
import {
  daysBackQuerySchema,
  parseQueryParams,
} from "../lib/validation.js";
import { logApiError, logApiHit, logApiOk } from "../lib/logger.js";
import { getLogger } from "../lib/logger.js";
import { isMonitorAuthorized } from "../lib/auth.js";
import { INCIDENT_CACHE_TTL } from "../lib/config.js";
import {
  getCutoffTime,
  getTimestampMs,
  sortByDateDesc,
  isValidDate,
} from "../lib/dateUtils.js";
import {
  createErrorResponse,
  createSuccessResponse,
} from "../lib/api/response.js";
import {
  readCronLogs,
  loadSourceHealthSnapshot,
  readObjectCache,
  writeObjectCache,
} from "../lib/services/storage.js";
import { redis } from "../lib/redis.js";

const logger = getLogger({ scope: "api" });

const LAST_24H_CUTOFF_DAYS = 1;
export const config = { maxDuration: 30 };

interface IncidentEntry {
  id: string;
  type: string;
  severity: string;
  title: string;
  message: string;
  timestamp: string | null;
  duration: string | null;
  resolved: boolean;
  resolvedAt: string | null;
  source: string;
  details: Record<string, unknown>;
}

function safeParse(data: unknown, defaultValue: Record<string, unknown> | null = null): Record<string, unknown> | null {
  if (!data) return defaultValue;
  if (typeof data === "object" && !Array.isArray(data)) return data as Record<string, unknown>;
  if (data === "[object Object]") return defaultValue;
  if (typeof data !== "string") return defaultValue;
  try {
    const parsed: unknown = JSON.parse(data);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return defaultValue;
  } catch {
    return defaultValue;
  }
}

// ==========================================
// Incident Fetchers
// ==========================================

async function fetchCronIncidents(redisClient: typeof redis, daysBack = 30) {
  try {
    const logs = await readCronLogs(redisClient, 0, 199);
    if (!logs || !Array.isArray(logs)) return [];

    const cutoffTime = getCutoffTime(daysBack);
    const incidents: IncidentEntry[] = [];

    for (let index = 0; index < logs.length; index++) {
      const log = logs[index];
      try {
        const entry = typeof log === "string" ? JSON.parse(log) : log;
        const timestamp = entry.timestamp || entry.time || entry.createdAt;

        if (!timestamp || getTimestampMs(timestamp) < cutoffTime) continue;

        const isError =
          entry.level === "error" ||
          entry.tag === "failed" ||
          entry.type === "error" ||
          (entry.deliveryFailed || 0) > 0 ||
          entry.result === "failed" ||
          (entry.shortCircuits || 0) > 0;

        if (!isError) continue;

        const severity =
          (entry.deliveryFailed || 0) > 0
            ? "critical"
            : (entry.shortCircuits || 0) > 0
              ? "high"
              : "medium";

        incidents.push({
          id: `cron-${entry.timestamp || Date.now()}-${index}`,
          type: "cron_failure",
          severity: severity,
          title: entry.title || "Cron Job Failure",
          message:
            entry.message ||
            entry.summary ||
            `Failed: ${entry.chaptersFailed || 0} chapters`,
          timestamp: timestamp,
          duration: entry.duration || null,
          resolved: true,
          resolvedAt: entry.resolvedAt || null,
          source: entry.source || "system",
          details: {
            chaptersFailed: entry.chaptersFailed || 0,
            deliveryFailed: entry.deliveryFailed || 0,
            shortCircuits: entry.shortCircuits || 0,
            error: entry.error || null,
          },
        });
      } catch {
        continue;
      }
    }

    return incidents;
  } catch (err) {
    logger.error({ err }, "[incidents] Error fetching cron incidents:");
    return [];
  }
}

async function fetchHealthIncidents(redisClient: typeof redis, daysBack = 30) {
  try {
    const sourceHealth = await loadSourceHealthSnapshot(redisClient, SOURCE_KEYS);
    const incidents: IncidentEntry[] = [];
    const cutoffTime = getCutoffTime(daysBack);

    for (const [source, health] of Object.entries(sourceHealth)) {
      const consecutiveFailures = health.consecutiveFailures || 0;
      if (consecutiveFailures === 0 && health.status === "healthy") continue;

      const lastCheckedAt = health.lastCheckedAt;
      if (!lastCheckedAt || getTimestampMs(lastCheckedAt) < cutoffTime) continue;

      const severity =
        consecutiveFailures > 5
          ? "critical"
          : consecutiveFailures > 3
            ? "high"
            : "medium";

      incidents.push({
        id: `health-${source}-${lastCheckedAt}`,
        type: "health_failure",
        severity,
        title: `Source Down: ${source}`,
        message: health.lastError || `${consecutiveFailures} consecutive check failures`,
        timestamp: lastCheckedAt,
        duration: null,
        resolved: health.status === "healthy",
        resolvedAt: health.status === "healthy" ? health.lastSuccessAt : null,
        source,
        details: {
          consecutiveFailures,
          status: health.status,
          lastError: health.lastError || null,
          disabledUntil: health.disabledUntil || null,
        },
      });
    }

    return incidents;
  } catch (err) {
    logger.error({ err }, "[incidents] Error fetching health incidents:");
    return [];
  }
}

async function fetchDiscordIncidents(redisClient: typeof redis, daysBack = 30) {
  try {
    const cutoffTime = getCutoffTime(daysBack);
    const failures: string[] = await redisClient.lrange(
      DISCORD_NOTIFICATION_FAILURES_KEY,
      0,
      99,
    );

    if (!failures || !Array.isArray(failures)) return [];

    const incidents: IncidentEntry[] = [];

    for (const failure of failures) {
      try {
        const entry = safeParse(failure);
        if (!entry) continue;

        const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : null;
        if (!timestamp || getTimestampMs(timestamp) < cutoffTime) continue;

        incidents.push({
          id: `discord-${entry.channelId || "unknown"}-${timestamp}`,
          type: "discord_failure",
          severity: "high",
          title: "Discord Notification Failed",
          message: typeof entry.error === "string" ? entry.error : "Failed to send chapter notification",
          timestamp,
          duration: null,
          resolved: false,
          resolvedAt: null,
          source: "discord",
          details: {
            channelId: entry.channelId || null,
            guildId: entry.guildId || null,
            chapterTitle: entry.chapterTitle || null,
            error: entry.error || null,
          },
        });
      } catch {
        continue;
      }
    }

    return incidents;
  } catch (err) {
    logger.error({ err }, "[incidents] Error fetching Discord incidents:");
    return [];
  }
}

function calculateStats(incidents: IncidentEntry[]) {
  const stats = {
    total: incidents.length,
    byType: {} as Record<string, number>,
    bySeverity: {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    },
    byStatus: {
      resolved: 0,
      ongoing: 0,
    },
  };

  for (const incident of incidents) {
    stats.byType[incident.type] = (stats.byType[incident.type] || 0) + 1;
    stats.bySeverity[incident.severity as keyof typeof stats.bySeverity] =
      (stats.bySeverity[incident.severity as keyof typeof stats.bySeverity] || 0) + 1;

    if (incident.resolved) {
      stats.byStatus.resolved++;
    } else {
      stats.byStatus.ongoing++;
    }
  }

  return stats;
}

// ==========================================
// Notices Fetchers
// ==========================================

async function fetchCronErrorLogs(redisClient: typeof redis, daysBack = 7) {
  try {
    const logs = await readCronLogs(redisClient, 0, 199);
    if (!logs || !Array.isArray(logs)) return [];

    const cutoffTime = getCutoffTime(daysBack);
    const errors: any[] = [];

    for (let index = 0; index < logs.length; index++) {
      const log = logs[index];
      try {
        const entry = typeof log === "string" ? JSON.parse(log) : log;
        const timestamp = entry.timestamp || entry.time || entry.createdAt;

        if (timestamp && getTimestampMs(timestamp) < cutoffTime) continue;

        if (
          entry.level === "error" ||
          entry.tag === "failed" ||
          entry.type === "error" ||
          (entry.deliveryFailed || 0) > 0 ||
          entry.result === "failed"
        ) {
          errors.push({
            id: `cron-${entry.timestamp || Date.now()}-${index}`,
            type: "cron_error",
            severity: (entry.deliveryFailed || 0) > 0 ? "high" : "medium",
            title: entry.title || "Cron Job Error",
            message:
              entry.message ||
              entry.summary ||
              `Failed: ${entry.chaptersFailed || 0} chapters`,
            timestamp: timestamp || null,
            source: entry.source || "system",
            details: {
              chaptersFailed: entry.chaptersFailed || 0,
              deliveryFailed: entry.deliveryFailed || 0,
              duration: entry.duration,
              error: entry.error,
            },
          });
        }
      } catch {
        continue;
      }
    }

    return errors;
  } catch (err: unknown) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "[notices] Error fetching cron logs:");
    return [];
  }
}

async function fetchHealthCheckFailures(redisClient: typeof redis, daysBack = 7) {
  try {
    const sourceHealth = (await loadSourceHealthSnapshot(
      redisClient,
      SOURCE_KEYS,
    )) as Record<string, any>;
    const failures: any[] = [];
    const cutoffTime = getCutoffTime(daysBack);

    for (const [source, health] of Object.entries(sourceHealth)) {
      if (!health) continue;

      if (health.status === "unhealthy" || (health.consecutiveFailures || 0) > 0) {
        const lastError = health.lastError;
        const lastCheckedAt = health.lastCheckedAt;

        if (lastCheckedAt && getTimestampMs(lastCheckedAt) < cutoffTime)
          continue;

        failures.push({
          id: `health-${source}-${lastCheckedAt || Date.now()}`,
          type: "health_check_failure",
          severity: (health.consecutiveFailures || 0) > 3 ? "high" : "medium",
          message:
            lastError || `${health.consecutiveFailures} consecutive failures`,
          timestamp: lastCheckedAt || null,
          source: source,
          details: {
            consecutiveFailures: health.consecutiveFailures || 0,
            status: health.status,
            lastError: lastError,
            disabledUntil: health.disabledUntil,
          },
        });
      }
    }

    return failures;
  } catch (err: unknown) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "[notices] Error fetching health checks:");
    return [];
  }
}

async function fetchDiscordNotificationFailures(redisClient: typeof redis, daysBack = 7) {
  try {
    const cutoffTime = getCutoffTime(daysBack);
    const failures: any[] = [];

    const recentFailures: string[] = await redisClient.lrange(
      DISCORD_NOTIFICATION_FAILURES_KEY,
      0,
      99,
    );

    if (!recentFailures || !Array.isArray(recentFailures)) return [];

    for (const failure of recentFailures) {
      try {
        const entry =
          typeof failure === "string" ? JSON.parse(failure) : failure;
        const timestamp = entry.timestamp;

        if (timestamp && getTimestampMs(timestamp) < cutoffTime) continue;

        failures.push({
          id: `discord-${entry.channelId || "unknown"}-${timestamp || Date.now()}`,
          type: "discord_notification_failure",
          severity: "high",
          title: "Discord Notification Failed",
          message: entry.error || "Failed to send Discord notification",
          timestamp: timestamp || null,
          source: "discord",
          details: {
            channelId: entry.channelId,
            error: entry.error,
            chapterTitle: entry.chapterTitle,
            guildId: entry.guildId,
          },
        });
      } catch {
        continue;
      }
    }

    return failures;
  } catch (err: unknown) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "[notices] Error fetching Discord failures:");
    return [];
  }
}

function determineStatus(notices: any[]) {
  if (notices.length === 0) return "healthy";

  const hasHighSeverity = notices.some((n) => n.severity === "high");
  const hasMediumSeverity = notices.some((n) => n.severity === "medium");

  if (hasHighSeverity) return "critical";
  if (hasMediumSeverity) return "warning";
  return "healthy";
}

// ==========================================
// Handlers
// ==========================================

async function handleIncidents(req: Request, res: Response, reqLogger: any) {
  try {
    const v = parseQueryParams(daysBackQuerySchema, req.query);
    if (!v.success) {
      logApiOk(reqLogger, { status: 400, reason: "invalid_query" });
      return res.status(400).json(createErrorResponse("INVALID_QUERY", v.errors[0]));
    }

    const { days: daysBack, resolved } = v.data;
    const includeResolved = resolved !== "false";

    const cacheKey = `${INCIDENT_CACHE_KEY}:${daysBack}:${includeResolved}`;
    const cached = await readObjectCache(redis, cacheKey);
    if (cached) {
      logApiOk(reqLogger, { status: 200, cached: true });
      return res.status(200).json(createSuccessResponse(cached));
    }

    const [cronIncidents, healthIncidents, discordIncidents] =
      await Promise.all([
        fetchCronIncidents(redis, daysBack),
        fetchHealthIncidents(redis, daysBack),
        fetchDiscordIncidents(redis, daysBack),
      ]);

    const wrappedIncidents: { incident: IncidentEntry; timestampMs: number }[] = [];
    const groupedByDate: Record<string, IncidentEntry[]> = {};
    let last24hCount = 0;
    const cutoff24h = getCutoffTime(LAST_24H_CUTOFF_DAYS);

    for (const incidents of [
      cronIncidents,
      healthIncidents,
      discordIncidents,
    ]) {
      for (const incident of incidents) {
        if (includeResolved || !incident.resolved) {
          const timestampMs = getTimestampMs(incident.timestamp);
          wrappedIncidents.push({ incident, timestampMs });

          const date = new Date(timestampMs).toISOString().split("T")[0];
          if (!groupedByDate[date]) groupedByDate[date] = [];
          groupedByDate[date].push(incident);

          if (timestampMs > cutoff24h) {
            last24hCount++;
          }
        }
      }
    }

    wrappedIncidents.sort((a, b) => b.timestampMs - a.timestampMs);
    const allIncidents = wrappedIncidents.map((w) => w.incident);

    const dates = Object.keys(groupedByDate).sort().reverse();
    const stats = calculateStats(allIncidents);

    const response = {
      daysBack: daysBack,
      totalCount: allIncidents.length,
      recent24h: last24hCount,
      ongoingCount: stats.byStatus.ongoing,
      stats: stats,
      timeline: dates.map((date) => ({
        date: date,
        displayDate: new Date(date).toLocaleDateString("id-ID", {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
        }),
        incidentCount: groupedByDate[date].length,
        incidents: groupedByDate[date],
      })),
    };

    await writeObjectCache(redis, cacheKey, response, INCIDENT_CACHE_TTL);

    logApiOk(reqLogger, {
      status: 200,
      cached: false,
      totalIncidents: allIncidents.length,
      recent24h: last24hCount,
      ongoing: stats.byStatus.ongoing,
    });

    return res.status(200).json(createSuccessResponse(response));
  } catch (err: unknown) {
    logApiError(reqLogger, err, { status: 500 });
    return res
      .status(500)
      .json(
        createErrorResponse(
          "INCIDENTS_FETCH_FAILED",
          env.NODE_ENV === "production"
            ? "Failed to fetch incidents"
            : err instanceof Error ? err.message : String(err),
        ),
      );
  }
}

async function handleNotices(req: Request, res: Response, reqLogger: any) {
  try {
    const v = parseQueryParams(daysBackQuerySchema, req.query);
    if (!v.success) {
      logApiOk(reqLogger, { status: 400, reason: "invalid_query" });
      return res.status(400).json(createErrorResponse("INVALID_QUERY", v.errors[0]));
    }

    const { days: daysBack } = v.data;

    const [cronErrors, healthFailures, discordFailures] = await Promise.all([
      fetchCronErrorLogs(redis, daysBack),
      fetchHealthCheckFailures(redis, daysBack),
      fetchDiscordNotificationFailures(redis, daysBack),
    ]);

    const sortedNotices = sortByDateDesc(
      [...cronErrors, ...healthFailures, ...discordFailures],
      "timestamp",
    ).slice(0, 50);

    const noticesWithMeta = sortedNotices.map((notice: any) => {
      const timestamp = notice.timestamp;
      const timestampMs = isValidDate(timestamp) ? getTimestampMs(timestamp) : 0;
      const date = timestamp && timestamp.split ? timestamp.split("T")[0] : "unknown";
      return { notice, timestampMs, date };
    });

    const groupedByDate = noticesWithMeta.reduce((acc: any, { notice, date }) => {
      if (!acc[date]) acc[date] = [];
      acc[date].push(notice);
      return acc;
    }, {});

    const allNotices = noticesWithMeta.map(({ notice }) => notice);
    const status = determineStatus(allNotices);
    const hasNotices = allNotices.length > 0;

    const response = {
      hasNotices,
      status,
      daysBack,
      totalCount: allNotices.length,
      byType: {
        cronErrors: cronErrors.length,
        healthFailures: healthFailures.length,
        discordFailures: discordFailures.length,
      },
      notices: allNotices,
      groupedByDate,
    };

    logApiOk(reqLogger, {
      status: 200,
      noticesCount: allNotices.length,
      hasErrors: cronErrors.length > 0,
      hasHealthFailures: healthFailures.length > 0,
    });

    return res.status(200).json(createSuccessResponse(response));
  } catch (err: unknown) {
    logApiError(reqLogger, err, { status: 500 });
    return res
      .status(500)
      .json(
        createErrorResponse(
          "NOTICES_FETCH_FAILED",
          env.NODE_ENV === "production"
            ? "Failed to fetch notices"
            : err instanceof Error ? err.message : String(err),
        ),
      );
  }
}

export default async function handler(req: Request, res: Response) {
  const urlObj = new URL(req.url || "", `http://${req.headers.host || "localhost"}`);
  const action = urlObj.searchParams.get("action");
  const isNotices = action === "notices" || urlObj.pathname.includes("/notices");

  const reqLogger = logApiHit(isNotices ? "notices" : "incidents", req);

  // Apply Serverless Rate Limiting
  const ip = req.headers["x-real-ip"] || req.headers["x-forwarded-for"] || req.ip || "unknown";
  const clientIp = Array.isArray(ip) ? ip[0] : ip;
  try {
    const { rateLimiters } = await import("../lib/rateLimiter.js");
    await rateLimiters.standard.consume(clientIp);
  } catch (err: any) {
    logApiOk(reqLogger, { status: 429, reason: "rate_limited" });
    return res.status(429).json(createErrorResponse("TOO_MANY_REQUESTS", "Rate limit exceeded. Please try again later."));
  }

  const isPublicRead =
    String(req.query?.public || "").toLowerCase() === "1" ||
    String(req.query?.public || "").toLowerCase() === "true";

  if (req.method !== "GET") {
    logApiOk(reqLogger, { status: 405, reason: "method_not_allowed" });
    return res
      .status(405)
      .json(createErrorResponse("METHOD_NOT_ALLOWED", "Method not allowed"));
  }

  if (!isPublicRead && !isMonitorAuthorized(req as any)) {
    logApiOk(reqLogger, { status: 401, reason: "unauthorized" });
    return res
      .status(401)
      .json(createErrorResponse("UNAUTHORIZED", "Unauthorized"));
  }

  if (isNotices) {
    return handleNotices(req, res, reqLogger);
  } else {
    return handleIncidents(req, res, reqLogger);
  }
}
