import { fetchDashboardSnapshot } from "../lib/redis.js";
import { logApiHit, logApiOk, logApiError, getLogger } from "../lib/logger.js";
import { prepareAuthorizedGet } from "../lib/api/response.js";
import { STATUS_CACHE_SEC } from "../lib/config.js";

const logger = getLogger({ scope: "api:dashboard" });

export default async function handler(req, res) {
  const reqLogger = logApiHit("dashboard-snapshot", req);

  const prepared = prepareAuthorizedGet(req, res, {
    defaultCacheTtl: STATUS_CACHE_SEC,
    rawCacheTtl: 0, // No browser-side caching for real-time dashboard
    maxAgeCap: 0,
  });

  if (!prepared) return;

  try {
    const snapshot = await fetchDashboardSnapshot();

    logApiOk(reqLogger, {
      status: 200,
      whitelist: snapshot.whitelistCount,
      queue: snapshot.queueLength,
    });

    return res.status(200).json(snapshot);
  } catch (err) {
    logger.error({ err: err.message }, "Failed to fetch dashboard snapshot");
    logApiError(reqLogger, err, { status: 500 });
    return res.status(500).json({ error: "Internal error", details: err.message });
  }
}
