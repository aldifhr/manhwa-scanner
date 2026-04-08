import {
  readCronLogs,
  redis,
  loadSourceHealthSnapshot,
  readObjectCache,
  writeObjectCache,
} from "../lib/redis.js";
import { SOURCE_KEYS } from "../lib/services/health.js";
import { logApiError, logApiHit, logApiOk } from "../lib/logger.js";
import { getLogger } from "../lib/logger.js";
import { isMonitorAuthorized } from "../lib/auth.js";
import { INCIDENT_CACHE_TTL } from "../lib/config.js";
import {
  getCutoffTime,
  getTimestampMs,
  isValidDate,
  sortByDateDesc,
} from "../lib/dateUtils.js";
import {
  createErrorResponse,
  createSuccessResponse,
} from "../lib/api/response.js";

// Named constant for 24h cutoff
const LAST_24H_CUTOFF_DAYS = 1;

const logger = getLogger({ scope: "api" });

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

    for (let index = 0; index < logs.length; index++) {
      const log = logs[index];
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

        // Add index to prevent ID collision
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
    logger.error("[incidents] Error fetching cron incidents:", err);
    return [];
  }
}

// Note: This returns current health snapshot, not historical incidents
// If service recovered, it won't appear here even if it failed earlier
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

      // Only include currently failing sources (snapshot, not historical)
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
    logger.error("[incidents] Error fetching health incidents:", err);
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
    logger.error("[incidents] Error fetching Discord incidents:", err);
    return [];
  }
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
    const daysBack = Math.min(90, Math.max(1, Number(req.query.days) || 30));
    const includeResolved = req.query.resolved !== "false";

    // Check cache first
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

    // Use safe wrapper approach (no mutation of original objects)
    const wrappedIncidents = [];
    const groupedByDate = {};
    let last24hCount = 0;
    const cutoff24h = getCutoffTime(LAST_24H_CUTOFF_DAYS);

    // Process all incidents in a single pass
    for (const incidents of [
      cronIncidents,
      healthIncidents,
      discordIncidents,
    ]) {
      for (const incident of incidents) {
        if (includeResolved || !incident.resolved) {
          // Wrap with pre-computed timestamp (no mutation)
          const timestampMs = getTimestampMs(incident.timestamp);
          wrappedIncidents.push({ incident, timestampMs });

          // Group by date using safe date parsing
          const date = new Date(timestampMs).toISOString().split("T")[0];
          if (!groupedByDate[date]) groupedByDate[date] = [];
          groupedByDate[date].push(incident);

          // Count last 24h
          if (timestampMs > cutoff24h) {
            last24hCount++;
          }
        }
      }
    }

    // Sort using wrapper, then extract original objects
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
      // Note: Removed flat incidents list to avoid duplicate data with timeline
    };

    // Cache the response
    await writeObjectCache(redis, cacheKey, response, INCIDENT_CACHE_TTL);

    logApiOk(reqLogger, {
      status: 200,
      cached: false,
      totalIncidents: allIncidents.length,
      recent24h: last24hCount,
      ongoing: stats.byStatus.ongoing,
    });

    return res.status(200).json(createSuccessResponse(response));
  } catch (err) {
    logApiError(reqLogger, err, { status: 500 });
    return res
      .status(500)
      .json(
        createErrorResponse(
          "INCIDENTS_FETCH_FAILED",
          process.env.NODE_ENV === "production"
            ? "Failed to fetch incidents"
            : err.message,
        ),
      );
  }
}
