/**
 * Auth module - authentication and authorization
 * 
 * Domain-organized exports:
 * - crypto: Base64Url, HMAC, constant-time comparison
 * - http: Header and cookie utilities
 * - ip: Client IP detection
 * - config: Auth configuration
 * - password: Password validation
 * - throttle: Login throttling
 * - session: Session management
 * - authorization: Authorization checks
 */

// Crypto
export {
  toBase64Url,
  fromBase64Url,
  signValue,
  constantTimeEqual,
} from "./crypto.js";

// HTTP utilities
export {
  getHeader,
  getCookieMap,
  getCookie,
  type RequestLike,
} from "./http.js";

// IP utilities
export {
  normalizeIpToken,
  shouldTrustProxyHeaders,
  isValidIpAddress,
  getClientAddress,
} from "./ip.js";

// Config
export {
  SESSION_COOKIE_NAME,
  getSessionSecret,
  getCronSecret,
  getDashboardPassword,
  getDashboardLoginWindowSeconds,
  getDashboardLoginMaxAttempts,
} from "./config.js";

// Password
export {
  validateDashboardPassword,
  isDashboardPasswordConfigured,
} from "./password.js";

// Throttle
export {
  readDashboardLoginThrottle,
  registerDashboardLoginFailure,
  clearDashboardLoginThrottle,
  type ThrottleSnapshot,
} from "./throttle.js";

// Session
export {
  createDashboardSessionToken,
  isDashboardSessionAuthorized,
  getSessionCookieHeader,
  getClearSessionCookieHeader,
} from "./session.js";

// Authorization
export {
  isMonitorAuthorized,
  isCronAuthorized,
  getSessionCookieHeader as getAuthCookieHeader,
  getClearSessionCookieHeader as getClearAuthCookieHeader,
} from "./authorization.js";
