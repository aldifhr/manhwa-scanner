import { loadSourceHealthSnapshot, redis } from "../lib/redis.js";
import { SOURCE_KEYS } from "../lib/services/health.js";
import { readCronStatusWithHealth } from "../lib/cronRuntime.js";
import { readCronDailyStats } from "../lib/cronLogs.js";
import { logApiError, logApiHit, logApiOk } from "../lib/logger.js";
import {
  HEALTH_CACHE_TTL_MS,
  UPTIME_CALCULATION_TIERS,
} from "../lib/config.js";

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

const HEALTH_STATUS_CACHE_KEY = "api:health-status:cache";
const CACHE_TTL_MS = HEALTH_CACHE_TTL_MS;

function calculateUptime(failures) {
  if (failures === 0) return UPTIME_CALCULATION_TIERS.PERFECT.value;
  if (failures === 1) return UPTIME_CALCULATION_TIERS.EXCELLENT.value;
  if (failures === 2) return UPTIME_CALCULATION_TIERS.GOOD.value;
  return UPTIME_CALCULATION_TIERS.DEGRADED.value;
}

export default async function handler(req, res) {
  const reqLogger = logApiHit("health-status", req);

  try {
    const now = Date.now();

    // Check Redis cache first
    const cached = await redis.get(HEALTH_STATUS_CACHE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached);
      logApiOk(reqLogger, { status: 200, cached: true });
      return res.status(200).json({ ...parsed, cached: true });
    }

    const sourceHealth = await loadSourceHealthSnapshot(redis, SOURCE_KEYS);
    const cronStatus = await readCronStatusWithHealth(redis);
    const dailyStats = await readCronDailyStats(redis, 90);
    const guildCount = await getGuildCount(redis);

    const networks = [
      {
        name: "Manga Sources",
        open: true,
        services: SOURCE_KEYS.map((source) => {
          const health = sourceHealth[source] || {};
          const failures = health.consecutiveFailures || 0;

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

          const uptime = calculateUptime(failures);
          const ping =
            health.responseTime || (isHealthy ? 30 : isDegraded ? 75 : 150);

          const incidents = [];
          const degraded = [];

          dailyStats.forEach((stat, index) => {
            const dayIndex = 89 - index; // Convert to bar index (0 = 90 days ago, 89 = today)

            if (stat.failedLogs > 0 || stat.deliveryFailed > 0) {
              incidents.push(dayIndex);
            } else if (stat.partialLogs > 0 || stat.shortCircuits > 0) {
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
            uptime: calculateUptime(1),
            ping: 45,
            incidents: [],
          },
          {
            name: "Redis Database",
            uptime: calculateUptime(0),
            ping: 5,
            incidents: [],
          },
          {
            name: "Cron Scheduler",
            uptime: calculateUptime(cronStatus?.failed > 0 ? 1 : 0),
            ping: 120,
            incidents: cronStatus?.failed > 0 ? [0] : [],
          },
        ],
      },
    ];

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

    // Store in Redis cache
    await redis.set(HEALTH_STATUS_CACHE_KEY, JSON.stringify(payload), {
      ex: Math.floor(CACHE_TTL_MS / 1000),
    });

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
