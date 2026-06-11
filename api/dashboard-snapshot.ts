import { fetchDashboardSnapshot } from "../lib/services/storage.js";
import { logApiHit, logApiOk, logApiError, getLogger } from "../lib/logger.js";
import { createSuccessResponse, createErrorResponse } from "../lib/api/response.js";
import { STATUS_CACHE_SEC } from "../lib/config.js";
import { isMonitorAuthorized } from "../lib/auth.js";
import { redis } from "../lib/redis.js";
import { 
  readRecentChapters, 
  readCronLogs,
  loadWhitelist 
} from "../lib/services/storage.js";
import { readCronDailyStats } from "../lib/cronLogs.js";
import { SOURCE_KEYS } from "../lib/constants/redis.js";
import { getSupabasePing, getDiscordPing, getRedisPing, formatResponseTime, getProviderMetrics } from "../lib/services/health.js";
import { findCronJob, getCronNextRuns, getCronLogs, FastCronExecutionResult } from "../lib/services/fastcron.js";
import type { Request, Response } from "express";

const logger = getLogger({ scope: "api:dashboard" });



/**
 * Get analytics data for dashboard
 */
async function getAnalyticsData() {
  try {
    const [recentChapters, logs, whitelist] = await Promise.all([
      readRecentChapters(redis, 0, 999),
      readCronLogs(redis, 0, 99),
      loadWhitelist(redis),
    ]);

    // Top manga
    const mangaMap = new Map<string, number>();
    for (const chapter of recentChapters) {
      const title = (chapter as Record<string, unknown>).title as string || "Unknown";
      mangaMap.set(title, (mangaMap.get(title) || 0) + 1);
    }
    const topManga = Array.from(mangaMap.entries())
      .map(([title, count]) => ({ title, chapters: count }))
      .sort((a, b) => b.chapters - a.chapters)
      .slice(0, 5);

    // Source stats
    const sourceMap = new Map<string, number>();
    for (const chapter of recentChapters) {
      const source = (chapter as Record<string, unknown>).source as string || "unknown";
      sourceMap.set(source, (sourceMap.get(source) || 0) + 1);
    }
    const sourceStats = Array.from(sourceMap.entries())
      .map(([source, count]) => ({ source, chapters: count }))
      .sort((a, b) => b.chapters - a.chapters);

    // Performance
    let totalDuration = 0;
    let totalChapters = 0;
    let totalRuns = 0;
    for (const log of logs) {
      const entry = typeof log === "string" ? JSON.parse(log) : log;
      if (entry.duration) {
        totalDuration += parseFloat(entry.duration) || 0;
        totalRuns++;
      }
      if (entry.sent) {
        totalChapters += parseInt(entry.sent) || 0;
      }
    }

    // Trends (last 7 days)
    const dailyCount = new Map<string, number>();
    for (const chapter of recentChapters) {
      const ch = chapter as Record<string, unknown>;
      const timestamp = ch.sentAt || ch.enqueuedAt;
      if (!timestamp || typeof timestamp !== "string") continue;
      const date = new Date(timestamp).toISOString().split("T")[0];
      dailyCount.set(date, (dailyCount.get(date) || 0) + 1);
    }
    const last7Days: Array<{ date: string; chapters: number }> = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split("T")[0];
      last7Days.push({
        date: dateStr,
        chapters: dailyCount.get(dateStr) || 0,
      });
    }

    const avgChaptersPerDay = last7Days.length > 0 
      ? Math.round((last7Days.reduce((sum, day) => sum + day.chapters, 0) / last7Days.length) * 10) / 10
      : 0;

    return {
      overview: {
        totalChaptersSent: recentChapters.length,
        totalMangaTracked: whitelist.length,
        averageChaptersPerDay: avgChaptersPerDay,
        avgCronDuration: totalRuns > 0 ? Math.round(totalDuration / totalRuns * 10) / 10 : 0,
      },
      topManga,
      sourceStats,
      trends: last7Days,
    };
  } catch (err) {
    logger.error({ err }, "Failed to get analytics data");
    return {
      overview: {
        totalChaptersSent: 0,
        totalMangaTracked: 0,
        averageChaptersPerDay: 0,
        avgCronDuration: 0,
      },
      topManga: [],
      sourceStats: [],
      trends: [],
    };
  }
}

// Removed Edge Runtime - using Node.js runtime for Redis support
// export const config = {
//   runtime: "edge",
// };

export default async function handler(req: Request, res: Response) {
  const reqLogger = logApiHit("dashboard-snapshot", req);

  try {
    // Auth check
    const authorized = await isMonitorAuthorized(req);
    if (!authorized) {
      const ua = req.headers["user-agent"]?.substring(0, 50) || "";
      logger.warn({ ua }, "Dashboard snapshot auth failed");
      
      logApiOk(reqLogger, { status: 401 });
      return res.status(401).json(createErrorResponse("UNAUTHORIZED", "Unauthorized"));
    }

    // Fetch FastCron data
    let fastCronData: Record<string, unknown> | null = null;
    try {
      const job = await findCronJob("ikiru");
      if (job) {
        const [nextRuns, logs] = await Promise.all([
          getCronNextRuns(job.id),
          getCronLogs(job.id),
        ]);

        fastCronData = {
          jobFound: true,
          jobId: job.id,
          jobName: job.name,
          nextRun: nextRuns && nextRuns.length > 0 ? {
            timestamp: nextRuns[0],
            minutesRemaining: Math.max(0, Math.round((nextRuns[0] * 1000 - Date.now()) / 60000)),
            formattedTime: formatMinutes(Math.max(0, Math.round((nextRuns[0] * 1000 - Date.now()) / 60000))),
          } : null,
          latestExecution: logs && logs.length > 0 ? (() => {
            const log0 = logs[0] as FastCronExecutionResult;
            const execMs = Math.round((log0.result?.executionTime || 0) * 1000);
            return {
              responseTimeMs: execMs,
              responseTime: formatResponseTime(execMs),
              httpStatus: log0.result?.httpStatus,
              success: log0.result?.status === 0,
              lastRunTimestamp: log0.result?.time,
            };
          })() : null,
        };
      } else {
        fastCronData = { jobFound: false };
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.debug({ err: msg }, "FastCron fetch failed");
      fastCronData = { jobFound: false, error: msg };
    }

    // Fetch analytics data
    let analyticsData: Awaited<ReturnType<typeof getAnalyticsData>> | null = null;
    try {
      analyticsData = await getAnalyticsData();
    } catch (err: unknown) {
      logger.debug({ err: err instanceof Error ? err.message : String(err) }, "Analytics fetch failed");
      analyticsData = {
        overview: {
          totalChaptersSent: 0,
          totalMangaTracked: 0,
          averageChaptersPerDay: 0,
          avgCronDuration: 0,
        },
        topManga: [],
        sourceStats: [],
        trends: [],
      };
    }

    let snapshot: Awaited<ReturnType<typeof fetchDashboardSnapshot>>;
    try {
      snapshot = await fetchDashboardSnapshot();
      // Filter source health to only known sources (ignore stale/legacy keys)
      if (snapshot.sourceHealth && typeof snapshot.sourceHealth === "object") {
        const filtered: Record<string, unknown> = {};
        for (const key of SOURCE_KEYS) {
          if (key in snapshot.sourceHealth) {
            filtered[key] = (snapshot.sourceHealth as Record<string, unknown>)[key];
          }
        }
        snapshot.sourceHealth = filtered;
      }
    } catch (redisErr: unknown) {
      logger.error({ err: redisErr instanceof Error ? redisErr.message : String(redisErr) }, "Redis fetch failed, using empty snapshot");
      snapshot = {
        cronStatus: null,
        sourceHealth: {},
        recommendations: [],
        lastHealthCheck: null,
        recentChapters: [],
        recentLogs: [],
        liveEvents: [],
        whitelist: [],
        whitelistCount: 0,
        queueLength: 0,
        queueItems: [],
        timestamp: new Date().toISOString(),
      };
    }

    // Fetch current system health for dashboard
    const [supabasePing, discordPing, redisPing, providerMetrics] = await Promise.all([
      getSupabasePing(),
      getDiscordPing(),
      getRedisPing(),
      getProviderMetrics(),
    ]);

    const systemServices = [
      { 
        name: "Discord API", 
        ping: formatResponseTime(discordPing), 
        status: (discordPing !== null && discordPing < 5000) ? "healthy" : "degraded", 
      },
      { 
        name: "Redis Database", 
        ping: formatResponseTime(redisPing), 
        status: (redisPing ?? 0) < 1000 ? "healthy" : "failed" 
      },
      {
        name: "Supabase DB",
        ping: formatResponseTime(supabasePing),
        status: (supabasePing !== null) ? "healthy" : "failed",
      },
    ];

    const dailyStats = await readCronDailyStats(redis, 7, new Date(), true).catch(() => []);

    // Concurrently check if there are active Redis run locks indicating running background workers
    const [lockIkiru, lockShinigami] = await Promise.all([
      redis.exists("cron:run:lock:ikiru").catch(() => 0),
      redis.exists("cron:run:lock:shinigami").catch(() => 0)
    ]);
    const activeWorkers: string[] = [];
    if (lockIkiru === 1) activeWorkers.push("ikiru");
    if (lockShinigami === 1) activeWorkers.push("shinigami");

    // Add FastCron, Analytics, and Active Worker status to snapshot
    const enrichedSnapshot = {
      ...snapshot,
      fastCron: fastCronData,
      analytics: analyticsData,
      dailyStats,
      activeWorkers,
      networks: [
        { name: "System Services", services: systemServices }
      ],
      providerMetrics,
    };

    logApiOk(reqLogger, {
      status: 200,
      whitelist: snapshot.whitelistCount,
      queue: snapshot.queueLength,
      fastCronFound: fastCronData?.jobFound || false,
    });

    res.setHeader("Cache-Control", `private, max-age=${Math.min(STATUS_CACHE_SEC, 30)}, stale-while-revalidate=${STATUS_CACHE_SEC}`);
    return res.status(200).json(createSuccessResponse(enrichedSnapshot));
    
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ 
      err: message,
      type: err instanceof Error ? err.constructor?.name : typeof err,
    }, "Failed to fetch dashboard snapshot");
    logApiError(reqLogger, err, { status: 500 });
    
    return res.status(500).json(createErrorResponse("INTERNAL_ERROR", message));
  }
}

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
