/**
 * Dashboard password validation
 */

import { constantTimeEqual } from "./crypto.js";
import { getDashboardPassword } from "./config.js";

/**
 * Validate dashboard password
 */
export async function validateDashboardPassword(password: unknown): Promise<boolean> {
  const expected = getDashboardPassword();
  const provided = String(password ?? "").trim();
  if (!expected) return false;
  return constantTimeEqual(provided, expected);
}

/**
 * Check if dashboard password is configured
 */
export async function isDashboardPasswordConfigured(): Promise<boolean> {
  return Boolean(getDashboardPassword());
}
