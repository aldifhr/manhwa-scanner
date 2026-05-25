/**
 * Auth configuration getters
 */

import { getLogger } from "../logger.js";
import { env } from "../config/env.js";

const logger = getLogger({ scope: "auth:config" });

export const SESSION_COOKIE_NAME = "ikiru_dashboard_session";

/**
 * Get session secret (for signing tokens)
 */
export function getSessionSecret(): string {
  const secret = env.DASHBOARD_SESSION_SECRET || env.CRON_SECRET;
  if (!secret) {
    logger.warn("No session secret configured");
  }
  return secret;
}

/**
 * Get cron secret (for API authorization)
 */
export function getCronSecret(): string {
  return env.CRON_SECRET;
}

/**
 * Get dashboard password
 */
export function getDashboardPassword(): string {
  return String(env.DASHBOARD_PASSWORD || "").trim();
}

/**
 * Get login throttle window in seconds
 */
export function getDashboardLoginWindowSeconds(): number {
  return Math.max(60, env.DASHBOARD_LOGIN_WINDOW_SECONDS);
}

/**
 * Get max login attempts before throttling
 */
export function getDashboardLoginMaxAttempts(): number {
  return Math.max(1, env.DASHBOARD_LOGIN_MAX_ATTEMPTS);
}
