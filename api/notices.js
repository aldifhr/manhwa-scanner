import {
  loadSourceHealthSnapshot,
  redis,
  readCronLogs,
} from "../lib/redis.js";
import { SOURCE_KEYS } from "../lib/services/health.js";
import { logApiError, logApiHit, logApiOk } from "../lib/logger.js";
import { isMonitorAuthorized } from "../lib/auth.js";
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

// Consistent limits with incidents.js
const NOTICES_FETCH_LIMIT = 200;
const NOTICES_DISPLAY_LIMIT = 50;
const NOTICES_DEFAULT_DAYS = 30;
const NOTICES_MAX_DAYS = 90;
const DISCORD_FAILURES_FETCH_LIMIT = 100;

export const config = { maxDuration: 30 };

const DISCORD_NOTIFICATION_FAILURES_KEY = "discord:notification_failures";

async function fetchCronErrorLogs(redisClient, daysBack = 7) {
  try {
    // Consistent with incidents.js (fetch 200)
    const logs = await readCronLogs(redisClient, 0, NOTICES_FETCH_LIMIT - 1);
    if (!logs || !Array.isArray(logs)) return [];

    const cutoffTime = getCutoffTime(daysBack);
    const errors = [];

    for (let index = 0; index < logs.length; index++) {
      const log = logs[index];
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
          // Add index to prevent ID collision
          errors.push({
            id: `cron-${entry.timestamp || Date.now()}-${index}`,
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

    // Consistent with incidents.js (fetch 100)
    const recentFailures = await redisClient.lrange(
      DISCORD_NOTIFICATION_FAILURES_KEY,
      0,
      DISCORD_FAILURES_FETCH_LIMIT - 1,
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

  // Method check first (consistent with other handlers)
  if (req.method !== "GET") {
    logApiOk(reqLogger, { status: 405, reason: "method_not_allowed" });
    return res
      .status(405)
      .json(createErrorResponse("METHOD_NOT_ALLOWED", "Method not allowed"));
  }

  if (!isMonitorAuthorized(req)) {
    logApiOk(reqLogger, { status: 401, reason: "unauthorized" });
    return res
      .status(401)
      .json(createErrorResponse("UNAUTHORIZED", "Unauthorized"));
  }

  try {
    // Consistent daysBack cap with incidents.js
    const daysBack = Math.min(
      NOTICES_MAX_DAYS,
      Math.max(1, Number(req.query.days) || NOTICES_DEFAULT_DAYS),
    );

    const [cronErrors, healthFailures, discordFailures] = await Promise.all([
      fetchCronErrorLogs(redis, daysBack),
      fetchHealthCheckFailures(redis, daysBack),
      fetchDiscordNotificationFailures(redis, daysBack),
    ]);

    // Sort notices by date descending and prepare for grouping
    const sortedNotices = sortByDateDesc(
      [...cronErrors, ...healthFailures, ...discordFailures],
      "timestamp",
    ).slice(0, NOTICES_DISPLAY_LIMIT);

    // Pre-compute timestamps and dates for grouping with safe null check
    const noticesWithMeta = sortedNotices.map((notice) => {
      const timestamp = notice.timestamp;
      const timestampMs = isValidDate(timestamp) ? getTimestampMs(timestamp) : 0;
      const date = timestamp && timestamp.split ? timestamp.split("T")[0] : "unknown";
      return { notice, timestampMs, date };
    });

    // Group by date using pre-computed date
    const groupedByDate = noticesWithMeta.reduce((acc, { notice, date }) => {
      if (!acc[date]) acc[date] = [];
      acc[date].push(notice);
      return acc;
    }, {});

    // Extract clean notices (without temp properties)
    const allNotices = noticesWithMeta.map(({ notice }) => notice);

    const status = determineStatus(allNotices);
    const hasNotices = allNotices.length > 0;

    const response = {
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
    };

    logApiOk(reqLogger, {
      status: 200,
      noticesCount: allNotices.length,
      hasErrors: cronErrors.length > 0,
      hasHealthFailures: healthFailures.length > 0,
    });

    return res.status(200).json(createSuccessResponse(response));
  } catch (err) {
    logApiError(reqLogger, err, { status: 500 });
    return res
      .status(500)
      .json(
        createErrorResponse(
          "NOTICES_FETCH_FAILED",
          process.env.NODE_ENV === "production"
            ? "Failed to fetch notices"
            : err.message,
        ),
      );
  }
}
