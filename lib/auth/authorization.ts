/**
 * Authorization checks for different endpoints
 */

import { getLogger } from "../logger.js";
import { getHeader } from "./http.js";
import { getCronSecret, getDashboardPassword } from "./config.js";
import { isDashboardSessionAuthorized, getSessionCookieHeader, getClearSessionCookieHeader } from "./session.js";
import { env } from "../config/env.js";
import type { RequestLike } from "./http.js";

const logger = getLogger({ scope: "auth:authorization" });

/**
 * Check if monitor endpoint is authorized
 * Accepts: Bearer token (CRON_SECRET or DASHBOARD_PASSWORD) or valid session
 */
export async function isMonitorAuthorized(req: RequestLike): Promise<boolean> {
  const provided = getHeader(req, "authorization");
  logger.debug({ authHeader: provided?.substring(0, 20) }, "isMonitorAuthorized check");

  // Accept Bearer token - CRON_SECRET or DASHBOARD_PASSWORD
  if (provided?.startsWith("Bearer ")) {
    const token = provided.substring(7);

    const cronSecret = getCronSecret();
    if (cronSecret && token === cronSecret) return true;

    const dashboardPassword = getDashboardPassword();
    if (dashboardPassword && token === dashboardPassword) return true;
  }

  // Fall back to session check
  return await isDashboardSessionAuthorized(req);
}

/**
 * Check if cron endpoint is authorized
 * Accepts: Bearer CRON_SECRET or (if ALLOW_DASHBOARD_CRON) valid session
 */
export async function isCronAuthorized(req: RequestLike): Promise<boolean> {
  const secret = getCronSecret();
  const provided = getHeader(req, "authorization");
  
  // Allow authorization via query parameter for browser triggers
  const query = (req as any).query;
  const queryKey = query?.key || query?.token || query?.secret;

  if (secret) {
    // Check Header
    if (provided === `Bearer ${secret}`) return true;
    
    // Check Query Param
    if (queryKey === secret) return true;
  }

  return (
    env.ALLOW_DASHBOARD_CRON &&
    await isDashboardSessionAuthorized(req)
  );
}

// Re-export cookie helpers for convenience
export { getSessionCookieHeader, getClearSessionCookieHeader };
