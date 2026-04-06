import { loadSourceHealthSnapshot, redis } from "../lib/redis.js";
import { SOURCE_KEYS } from "../lib/services/health.js";
import { readCronLogs } from "../lib/redis.js";
import { logApiError, logApiHit, logApiOk } from "../lib/logger.js";
import { isMonitorAuthorized } from "../lib/auth.js";
import {
  getCutoffTime,
  getTimestampMs,
  sortByDateDesc,
} from "../lib/dateUtils.js";

export const config = { maxDuration: 30 };

const DISCORD_NOTIFICATION_FAILURES_KEY = "discord:notification_failures";

async function fetchCronErrorLogs(redisClient, daysBack = 7) {
  try {
    const logs = await readCronLogs(redisClient, 0, 99);
    if (!logs || !Array.isArray(logs)) return [];

    const cutoffTime = getCutoffTime(daysBack);
    const errors = [];

    for (const log of logs) {
      try {
        const entry = typeof log === "string" ? JSON.parse(log) : log;
        const timestamp = entry.timestamp || entry.createdAt;

        if (timestamp && getTimestampMs(timestamp) < cutoffTime) continue;

        if (
          entry.level === "error" ||
          entry.tag === "failed" ||
          entry.type === "error" ||
          entry.deliveryFailed > 0 ||
          entry.result === "failed"
        ) {
          errors.push({
            id: `cron-${entry.timestamp || Date.now()}`,
            type: "cron_error",
            severity: entry.deliveryFailed > 0 ? "high" : "medium",
            title: entry.title || "Cron Job Error",
            message:
              entry.message ||
              entry.summary ||
              `Failed: ${entry.chaptersFailed || 0} chapters`,
            timestamp: timestamp || new Date().toISOString(),
            source: entry.source || "system",
            details: {
              chaptersFailed: entry.chaptersFailed || 0,
              deliveryFailed: entry.deliveryFailed || 0,
              duration: entry.duration,
              error: entry.error,
            },
          });
        }
      } catch (parseErr) {
        continue;
      }
    }

    return errors;
  } catch (err) {
    console.error("[notices] Error fetching cron logs:", err);
    return [];
  }
}

async function fetchHealthCheckFailures(redisClient, daysBack = 7) {
  try {
    const sourceHealth = await loadSourceHealthSnapshot(
      redisClient,
      SOURCE_KEYS,
    );
    const failures = [];
    const cutoffTime = getCutoffTime(daysBack);

    for (const [source, health] of Object.entries(sourceHealth)) {
      if (!health) continue;

      if (health.status === "unhealthy" || health.consecutiveFailures > 0) {
        const lastError = health.lastError;
        const lastCheckedAt = health.lastCheckedAt;

        if (lastCheckedAt && getTimestampMs(lastCheckedAt) < cutoffTime)
          continue;

        failures.push({
          id: `health-${source}-${lastCheckedAt || Date.now()}`,
          type: "health_check_failure",
          severity: health.consecutiveFailures > 3 ? "high" : "medium",
          title: `Source Health: ${source}`,
          message:
            lastError || `${health.consecutiveFailures} consecutive failures`,
          timestamp: lastCheckedAt || new Date().toISOString(),
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
  } catch (err) {
    console.error("[notices] Error fetching health checks:", err);
    return [];
  }
}

async function fetchDiscordNotificationFailures(redisClient, daysBack = 7) {
  try {
    const cutoffTime = getCutoffTime(daysBack);
    const failures = [];

    const recentFailures = await redisClient.lrange(
      DISCORD_NOTIFICATION_FAILURES_KEY,
      0,
      49,
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
          timestamp: timestamp || new Date().toISOString(),
          source: "discord",
          details: {
            channelId: entry.channelId,
            error: entry.error,
            chapterTitle: entry.chapterTitle,
            guildId: entry.guildId,
          },
        });
      } catch (parseErr) {
        continue;
      }
    }

    return failures;
  } catch (err) {
    console.error("[notices] Error fetching Discord failures:", err);
    return [];
  }
}

function determineStatus(notices) {
  if (notices.length === 0) return "healthy";

  const hasHighSeverity = notices.some((n) => n.severity === "high");
  const hasMediumSeverity = notices.some((n) => n.severity === "medium");

  if (hasHighSeverity) return "critical";
  if (hasMediumSeverity) return "warning";
  return "healthy";
}

export default async function handler(req, res) {
  const reqLogger = logApiHit("notices", req);

  if (!isMonitorAuthorized(req)) {
    logApiOk(reqLogger, { status: 401, reason: "unauthorized" });
    return res.status(401).json({
      success: false,
      error: {
        code: "UNAUTHORIZED",
        message: "Unauthorized",
      },
      timestamp: new Date().toISOString(),
    });
  }

  if (req.method !== "GET") {
    return res.status(405).json({
      success: false,
      error: {
        code: "METHOD_NOT_ALLOWED",
        message: "Method not allowed",
      },
      timestamp: new Date().toISOString(),
    });
  }

  try {
    const daysBack = Math.min(30, Math.max(1, Number(req.query.days) || 7));

    const [cronErrors, healthFailures, discordFailures] = await Promise.all([
      fetchCronErrorLogs(redis, daysBack),
      fetchHealthCheckFailures(redis, daysBack),
      fetchDiscordNotificationFailures(redis, daysBack),
    ]);

    // Sort notices by date descending and prepare for grouping
    const sortedNotices = sortByDateDesc(
      [...cronErrors, ...healthFailures, ...discordFailures],
      "timestamp",
    ).slice(0, 50);

    // Pre-compute timestamps and dates for grouping
    const allNotices = sortedNotices.map((notice) => ({
      ...notice,
      _timestampMs: getTimestampMs(notice.timestamp),
      _date: notice.timestamp.split("T")[0],
    }));

    // Group by date using pre-computed _date
    const groupedByDate = allNotices.reduce((acc, notice) => {
      if (!acc[notice._date]) acc[notice._date] = [];
      acc[notice._date].push(notice);
      return acc;
    }, {});

    // Clean up temporary properties
    allNotices.forEach((notice) => {
      delete notice._timestampMs;
      delete notice._date;
    });

    const status = determineStatus(allNotices);
    const hasNotices = allNotices.length > 0;

    const response = {
      success: true,
      data: {
        hasNotices,
        status, // 'healthy', 'warning', 'critical'
        daysBack,
        totalCount: allNotices.length,
        byType: {
          cronErrors: cronErrors.length,
          healthFailures: healthFailures.length,
          discordFailures: discordFailures.length,
        },
        notices: allNotices,
        groupedByDate,
      },
      timestamp: new Date().toISOString(),
    };

    logApiOk(reqLogger, {
      status: 200,
      noticesCount: allNotices.length,
      hasErrors: cronErrors.length > 0,
      hasHealthFailures: healthFailures.length > 0,
    });

    return res.status(200).json(response);
  } catch (err) {
    console.error("[notices] API error:", err);
    logApiError(reqLogger, err);

    return res.status(500).json({
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to fetch notices",
      },
      timestamp: new Date().toISOString(),
    });
  }
}
