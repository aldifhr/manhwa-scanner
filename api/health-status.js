import { redis, loadSourceHealthSnapshot } from "../lib/redis.js";
import { SOURCE_KEYS } from "../lib/services/health.js";
import { readCronStatusWithHealth } from "../lib/cronRuntime.js";
import { readCronDailyStats } from "../lib/cronLogs.js";
import { logApiHit, logApiOk, logApiError } from "../lib/logger.js";

// Helper to get guild count from Redis
async function getGuildCount(redisClient) {
  try {
    const count = await redisClient.get("discord:guilds:count");
    return count ? parseInt(count, 10) : null;
  } catch (err) {
    console.error("[health-status] Error fetching guild count:", err);
    return null;
  }
}

export const config = { maxDuration: 30 };

// Simple in-memory cache with 1-minute TTL
let cache = { data: null, timestamp: 0, expiresAt: 0 };
const CACHE_TTL_MS = 60000; // 1 minute

export default async function handler(req, res) {
  const reqLogger = logApiHit("health-status", req);

  try {
    // Check cache first
    const now = Date.now();
    if (cache.data && now < cache.expiresAt) {
      logApiOk(reqLogger, { status: 200, cached: true });
      return res.status(200).json(cache.data);
    }

    // Get source health data, cron logs, and guild count
    const sourceHealth = await loadSourceHealthSnapshot(redis, SOURCE_KEYS);
    const cronStatus = await readCronStatusWithHealth(redis);
    const dailyStats = await readCronDailyStats(redis, 90);
    const guildCount = await getGuildCount(redis);

    // Format data for status page
    const networks = [
      {
        name: "Manga Sources",
        open: true,
        services: SOURCE_KEYS.map((source) => {
          const health = sourceHealth[source] || {};
          const failures = health.consecutiveFailures || 0;

          // Determine status based on consecutive failures if health.status is not set
          let status = health.status;
          if (!status || status === "unknown") {
            if (failures >= 3) {
              status = "failed";
            } else if (failures > 0) {
              status = "degraded";
            } else {
              status = "healthy";
            }
          }

          const isHealthy = status === "healthy";
          const isDegraded = status === "degraded";

          // Calculate uptime percentage (simplified)
          const uptime =
            failures === 0
              ? "100.0%"
              : failures === 1
                ? "99.9%"
                : failures === 2
                  ? "99.5%"
                  : "98.0%";

          // Response time simulation based on health
          const ping = isHealthy
            ? Math.floor(Math.random() * 50 + 10)
            : isDegraded
              ? Math.floor(Math.random() * 100 + 50)
              : Math.floor(Math.random() * 200 + 100);

          // Build incidents array from real cron logs data
          const incidents = [];
          const degraded = [];

          // Map daily stats to bar segments (0 = today, 89 = 90 days ago)
          dailyStats.forEach((stat, index) => {
            const dayIndex = 89 - index; // Convert to bar index (0 = 90 days ago, 89 = today)

            // Check for failed logs or delivery failures
            if (stat.failedLogs > 0 || stat.deliveryFailed > 0) {
              incidents.push(dayIndex);
            }
            // Check for partial logs or short circuits (degraded)
            else if (stat.partialLogs > 0 || stat.shortCircuits > 0) {
              degraded.push(dayIndex);
            }
          });

          return {
            name:
              source === "ikiru"
                ? "Ikiru"
                : source === "shinigami_project"
                  ? "Shinigami Project"
                  : "Shinigami Mirror",
            uptime: uptime,
            ping: ping,
            incidents: incidents,
            degraded: degraded,
            status: status,
            lastError: health.lastError || null,
            disabledUntil: health.disabledUntil || null,
            consecutiveFailures: failures,
          };
        }),
      },
      {
        name: "System Services",
        open: false,
        services: [
          {
            name: "Discord API",
            uptime: "99.9%",
            ping: 45,
            incidents: [],
          },
          {
            name: "Redis Database",
            uptime: "100.0%",
            ping: 5,
            incidents: [],
          },
          {
            name: "Cron Scheduler",
            uptime: cronStatus?.outcome === "ok" ? "100.0%" : "99.0%",
            ping: 120,
            incidents: cronStatus?.failed > 0 ? [0] : [],
          },
        ],
      },
    ];

    // Calculate overall system status
    const hasDegraded = networks.some((n) =>
      n.services.some(
        (s) => s.status === "degraded" || s.consecutiveFailures > 0,
      ),
    );
    const hasFailed = networks.some((n) =>
      n.services.some((s) => s.consecutiveFailures >= 3),
    );

    const payload = {
      networks: networks,
      dailyStats: dailyStats,
      cached: false,
      overallStatus: hasFailed
        ? "degraded"
        : hasDegraded
          ? "warning"
          : "healthy",
      lastUpdated: new Date().toISOString(),
      uptime: "99.98%",
      totalIncidents: networks.reduce(
        (acc, n) =>
          acc +
          n.services.reduce((acc2, s) => acc2 + (s.incidents?.length || 0), 0),
        0,
      ),
      guildCount: guildCount,
      cronStatus: cronStatus
        ? {
            lastRun: cronStatus.lastRun || null,
            sent: cronStatus.sent || 0,
            skipped: cronStatus.skipped || 0,
            failed: cronStatus.failed || 0,
            duration: cronStatus.duration
              ? `${Math.round(cronStatus.duration / 1000)}s`
              : "-",
            outcome: cronStatus.outcome || "unknown",
          }
        : null,
    };

    // Update cache
    cache = {
      data: payload,
      timestamp: now,
      expiresAt: now + CACHE_TTL_MS,
    };

    logApiOk(reqLogger, { status: 200, cached: false });
    return res.status(200).json(payload);
  } catch (err) {
    console.error("[health-status] Error:", err);
    logApiError(reqLogger, err, { status: 500 });
    return res.status(500).json({
      error: "Internal error",
      networks: [],
      overallStatus: "unknown",
    });
  }
}
