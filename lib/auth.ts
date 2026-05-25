/**
 * Auth module - authentication and authorization
 * 
 * NOTE: This module is now organized into domain-specific files in ./auth/.
 * Import from specific files for tree-shaking:
 *   import { validateDashboardPassword } from "./auth/password.js";
 *   import { isCronAuthorized } from "./auth/authorization.js";
 * 
 * This file re-exports everything for backward compatibility.
 */

// Re-export all auth functionality
export * from "./auth/index.js";
