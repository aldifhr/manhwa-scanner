import { isCronAuthorized } from "../lib/auth.js";
import { buildCronErrorLog, appendCronLog } from "../lib/cronLogs.js";
import { runCronJob, shouldRunChannelValidation } from "../lib/cronRuntime.js";
import { getLogger } from "../lib/logger.js";
import { writeCronStatus } from "../lib/monitorStore.js";
import { redis } from "../lib/redis.js";
import { logApiError, logApiHit, logApiOk } from "../lib/requestLog.js";

export const config = { maxDuration: 60 };
const logger = getLogger({ scope: "cron" });

export { shouldRunChannelValidation };

export default async function handler(req, res) {
  const reqLogger = logApiHit("cron", req);

  if (!["GET", "POST"].includes(req.method)) {
    logApiOk(reqLogger, { status: 405, reason: "method_not_allowed" });
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!isCronAuthorized(req)) {
    logApiOk(reqLogger, { status: 401, reason: "unauthorized" });
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const result = await runCronJob({
      redisClient: redis,
      logger,
    });
    logApiOk(reqLogger, { status: result.statusCode, ...result.logMeta });
    return res.status(result.statusCode).json(result.body);
  } catch (err) {
    logger.error({ err: err.message }, "fatal");
    const statusPayload = {
      sent: 0,
      skipped: 0,
      failed: 1,
      duration: null,
      guilds: 0,
      timestamp: new Date().toISOString(),
      sourceHealth: {},
      scrapeMetrics: null,
      outcome: "fatal_error",
      shortCircuitReason: "fatal_error",
      error: err?.message || "Internal error",
    };
    await writeCronStatus(redis, statusPayload).catch(() => {});
    await appendCronLog(redis, buildCronErrorLog(err, {
      code: "cron_fatal",
      type: "runtime_error",
      source: "cron",
    })).catch(() => {});
    logApiError(reqLogger, err, { status: 500 });
    return res.status(500).json({ error: "Internal error" });
  }
}
