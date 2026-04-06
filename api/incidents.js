import { redis, readCronLogs } from "../lib/redis.js";
import { SOURCE_KEYS } from "../lib/services/health.js";
import { loadSourceHealthSnapshot } from "../lib/redis.js";
import { logApiHit, logApiOk, logApiError } from "../lib/logger.js";
import { isMonitorAuthorized } from "../lib/auth.js";
import { INCIDENT_CACHE_TTL } from "../lib/config.js";
import {
  getTimestampMs,
  getCutoffTime,
  isValidDate,
  sortByDateDesc,
} from "../lib/dateUtils.js";

export const config = { maxDuration: 30 };

const DISCORD_NOTIFICATION_FAILURES_KEY = "discord:notification_failures";
const INCIDENT_CACHE_KEY = "cache:api:incidents:v1";

function safeParse(data, defaultValue = null) {
  if (!data) return defaultValue;
  if (typeof data === "object") return data;
  if (data === "[object Object]") return defaultValue;
  try {
    return JSON.parse(data);
  } catch {
    return defaultValue;
  }
}

async function fetchCronIncidents(redisClient, daysBack = 30) {
  try {
    const logs = await readCronLogs(redisClient, 0, 199);
    if (!logs || !Array.isArray(logs)) return [];

    const cutoffTime = getCutoffTime(daysBack);
    const incidents = [];

    for (const log of logs) {
      try {
        const entry = typeof log === "string" ? JSON.parse(log) : log;
        const timestamp = entry.timestamp || entry.createdAt;

        if (!timestamp || getTimestampMs(timestamp) < cutoffTime) continue;

        const isError =
          entry.level === "error" ||
          entry.tag === "failed" ||
          entry.type === "error" ||
          entry.deliveryFailed > 0 ||
          entry.result === "failed" ||
          entry.shortCircuits > 0;

        if (!isError) continue;

        const severity =
          entry.deliveryFailed > 0
            ? "critical"
            : entry.shortCircuits > 0
              ? "high"
              : "medium";

        incidents.push({
          id: `cron-${entry.timestamp || Date.now()}`,
          type: "cron_failure",
          severity: severity,
          title: entry.title || "Cron Job Failure",
          message:
            entry.message ||
            entry.summary ||
            `Failed: ${entry.chaptersFailed || 0} chapters`,
          timestamp: timestamp,
          duration: entry.duration || null,
          resolved: true, // Past errors are considered resolved
          resolvedAt: entry.resolvedAt || null,
          source: entry.source || "system",
          details: {
            chaptersFailed: entry.chaptersFailed || 0,
            deliveryFailed: entry.deliveryFailed || 0,
            shortCircuits: entry.shortCircuits || 0,
            error: entry.error || null,
          },
        });
      } catch (parseErr) {
        continue;
      }
    }

    return incidents;
  } catch (err) {
    console.error("[incidents] Error fetching cron incidents:", err);
    return [];
  }
}

async function fetchHealthIncidents(redisClient, daysBack = 30) {
  try {
    const sourceHealth = await loadSourceHealthSnapshot(
      redisClient,
      SOURCE_KEYS,
    );
    const incidents = [];
    const cutoffTime = getCutoffTime(daysBack);

    for (const [source, health] of Object.entries(sourceHealth)) {
      if (!health) continue;

      if (
        (health.consecutiveFailures || 0) === 0 &&
        health.status !== "unhealthy"
      )
        continue;

      const lastCheckedAt = health.lastCheckedAt;
      if (!lastCheckedAt || getTimestampMs(lastCheckedAt) < cutoffTime)
        continue;

      const severity =
        health.consecutiveFailures > 5
          ? "critical"
          : health.consecutiveFailures > 3
            ? "high"
            : "medium";

      incidents.push({
        id: `health-${source}-${lastCheckedAt}`,
        type: "health_failure",
        severity: severity,
        title: `Source Down: ${source}`,
        message:
          health.lastError ||
          `${health.consecutiveFailures} consecutive check failures`,
        timestamp: lastCheckedAt,
        duration: null, // Unknown duration
        resolved: health.status === "healthy", // Resolved if currently healthy
        resolvedAt: health.status === "healthy" ? health.lastSuccessAt : null,
        source: source,
        details: {
          consecutiveFailures: health.consecutiveFailures || 0,
          status: health.status,
          lastError: health.lastError || null,
          disabledUntil: health.disabledUntil || null,
        },
      });
    }

    return incidents;
  } catch (err) {
    console.error("[incidents] Error fetching health incidents:", err);
    return [];
  }
}

async function fetchDiscordIncidents(redisClient, daysBack = 30) {
  try {
    const cutoffTime = getCutoffTime(daysBack);
    const failures = await redisClient.lrange(
      DISCORD_NOTIFICATION_FAILURES_KEY,
      0,
      99,
    );

    if (!failures || !Array.isArray(failures)) return [];

    const incidents = [];

    for (const failure of failures) {
      try {
        const entry = safeParse(failure);
        if (!entry) continue;

        const timestamp = entry.timestamp;
        if (!timestamp || getTimestampMs(timestamp) < cutoffTime) continue;

        incidents.push({
          id: `discord-${entry.channelId || "unknown"}-${timestamp}`,
          type: "discord_failure",
          severity: "high",
          title: "Discord Notification Failed",
          message: entry.error || "Failed to send chapter notification",
          timestamp: timestamp,
          duration: null,
          resolved: false, // Assume unresolved unless manually cleared
          resolvedAt: null,
          source: "discord",
          details: {
            channelId: entry.channelId || null,
            guildId: entry.guildId || null,
            chapterTitle: entry.chapterTitle || null,
            error: entry.error || null,
          },
        });
      } catch (parseErr) {
        continue;
      }
    }

    return incidents;
  } catch (err) {
    console.error("[incidents] Error fetching Discord incidents:", err);
    return [];
  }
}

function groupByDate(incidents) {
  return incidents.reduce((acc, incident) => {
    const timestampMs = getTimestampMs(incident.timestamp);
    if (isNaN(timestampMs)) return acc;
    const date = new Date(timestampMs).toISOString().split("T")[0];
    if (!acc[date]) acc[date] = [];
    acc[date].push(incident);
    return acc;
  }, {});
}

function calculateStats(incidents) {
  const stats = {
    total: incidents.length,
    byType: {},
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

    stats.bySeverity[incident.severity] =
      (stats.bySeverity[incident.severity] || 0) + 1;

    if (incident.resolved) {
      stats.byStatus.resolved++;
    } else {
      stats.byStatus.ongoing++;
    }
  }

  return stats;
}

export default async function handler(req, res) {
  const reqLogger = logApiHit("incidents", req);

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
    const daysBack = Math.min(90, Math.max(1, Number(req.query.days) || 30));
    const includeResolved = req.query.resolved !== "false";

    const [cronIncidents, healthIncidents, discordIncidents] =
      await Promise.all([
        fetchCronIncidents(redis, daysBack),
        fetchHealthIncidents(redis, daysBack),
        fetchDiscordIncidents(redis, daysBack),
      ]);

    // Pre-compute timestamps and combine operations for efficiency
    const allIncidents = [];
    const groupedByDate = {};
    let last24hCount = 0;
    const cutoff24h = getCutoffTime(0, 24);

    // Process all incidents in a single pass
    for (const incidents of [
      cronIncidents,
      healthIncidents,
      discordIncidents,
    ]) {
      for (const incident of incidents) {
        if (includeResolved || !incident.resolved) {
          // Pre-compute timestamp for sorting and filtering
          incident._timestampMs = getTimestampMs(incident.timestamp);
          allIncidents.push(incident);

          // Group by date
          const date = new Date(incident.timestamp).toISOString().split("T")[0];
          if (!groupedByDate[date]) groupedByDate[date] = [];
          groupedByDate[date].push(incident);

          // Count last 24h
          if (incident._timestampMs > cutoff24h) {
            last24hCount++;
          }
        }
      }
    }

    // Sort once using pre-computed timestamps
    allIncidents.sort((a, b) => b._timestampMs - a._timestampMs);

    // Clean up temporary property
    allIncidents.forEach((i) => delete i._timestampMs);

    const dates = Object.keys(groupedByDate).sort().reverse();
    const stats = calculateStats(allIncidents);

    const response = {
      success: true,
      data: {
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
        incidents: allIncidents.slice(0, 50), // Flat list (first 50)
      },
      timestamp: new Date().toISOString(),
    };

    logApiOk(reqLogger, {
      status: 200,
      totalIncidents: allIncidents.length,
      recent24h: last24hCount,
      ongoing: stats.byStatus.ongoing,
    });

    return res.status(200).json(response);
  } catch (err) {
    console.error("[incidents] API error:", err);
    logApiError(reqLogger, err);

    return res.status(500).json({
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to fetch incidents",
      },
      timestamp: new Date().toISOString(),
    });
  }
}
