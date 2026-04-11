import axios from "axios";
import http from "http";
import https from "https";
import { getLogger } from "./logger.js";

const logger = getLogger({ scope: "httpClient" });

// Optimized HTTP agents with connection pooling for better performance
const agentOptions = {
  keepAlive: true,
  maxSockets: 50, // Maximum concurrent connections
  maxFreeSockets: 10, // Keep some connections ready
  timeout: 30000, // Socket timeout
  freeSocketTimeout: 30000, // Free socket timeout
};

axios.defaults.httpAgent = new http.Agent(agentOptions);
axios.defaults.httpsAgent = new https.Agent(agentOptions);
const DEFAULT_RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

// Instance-based adaptive rate limiting to prevent global state race conditions
// Each request context gets its own rate limiter
class AdaptiveRateLimiter {
  constructor() {
    this.responseTimeHistory = [];
    this.maxHistorySize = 10;
    this.currentBaseDelayMs = 350;
  }

  recordResponseTime(durationMs) {
    this.responseTimeHistory.push(durationMs);
    if (this.responseTimeHistory.length > this.maxHistorySize) {
      this.responseTimeHistory.shift();
    }

    // Calculate average response time
    const avg =
      this.responseTimeHistory.reduce((a, b) => a + b, 0) / this.responseTimeHistory.length;

    // Adjust base delay based on server performance
    if (avg > 2000) {
      // Server is slow, increase delay
      this.currentBaseDelayMs = Math.min(this.currentBaseDelayMs * 1.2, 1000);
    } else if (avg < 500) {
      // Server is fast, decrease delay
      this.currentBaseDelayMs = Math.max(this.currentBaseDelayMs * 0.9, 200);
    }
  }

  getDelay() {
    return Math.round(this.currentBaseDelayMs);
  }

  reset() {
    this.responseTimeHistory.length = 0;
    this.currentBaseDelayMs = 350;
  }
}

// Module-level rate limiter for backward compatibility (shared by default)
const globalRateLimiter = new AdaptiveRateLimiter();

// Deprecated: Use createRateLimiter() for new code
export function getAdaptiveDelay() {
  return globalRateLimiter.getDelay();
}

// Deprecated: Use rateLimiter.reset() for new code
export function resetAdaptiveRateLimit() {
  globalRateLimiter.reset();
}

/**
 * Create a new instance-based rate limiter to avoid global state race conditions
 * @returns {AdaptiveRateLimiter}
 */
export function createRateLimiter() {
  return new AdaptiveRateLimiter();
}

export function parseRetryAfterMs(retryAfterHeader) {
  if (!retryAfterHeader) return null;
  const raw = String(retryAfterHeader).trim();
  const asSeconds = Number(raw);
  if (Number.isFinite(asSeconds)) return Math.max(0, asSeconds * 1000);
  const asDate = Date.parse(raw);
  if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());
  return null;
}

function shouldRetry(err, retryStatuses) {
  const status = err?.response?.status;
  if (!status) return true;
  return retryStatuses.has(status);
}

export async function requestWithRetry(requestFn, options = {}) {
  // `retries` means additional attempts after the first request.
  // Example: retries=0 => single attempt, retries=2 => up to 3 attempts total.
  const retries = Number.isFinite(options?.retries) ? Math.max(0, options.retries) : 3;
  const maxAttempts = retries + 1;
  // Use instance-based rate limiter if provided, otherwise fall back to global
  const rateLimiter = options?.rateLimiter || globalRateLimiter;
  // Use adaptive delay if enabled, otherwise use provided or default
  const adaptiveDelay = options?.adaptive !== false ? rateLimiter.getDelay() : 350;
  const baseDelayMs = Number.isFinite(options?.baseDelayMs)
    ? options.baseDelayMs
    : adaptiveDelay;
  const maxDelayMs = Number.isFinite(options?.maxDelayMs)
    ? options.maxDelayMs
    : 6000;
  const jitterMs = Number.isFinite(options?.jitterMs) ? options.jitterMs : 200;
  const onRetry =
    typeof options?.onRetry === "function" ? options.onRetry : null;
  const retryStatuses =
    options?.retryStatuses instanceof Set
      ? options.retryStatuses
      : DEFAULT_RETRY_STATUSES;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const startTime = Date.now();
    try {
      const result = await requestFn();
      // Record successful response time for adaptive rate limiting
      if (options?.adaptive !== false) {
        rateLimiter.recordResponseTime(Date.now() - startTime);
      }
      return result;
    } catch (err) {
      if (!shouldRetry(err, retryStatuses) || attempt === maxAttempts) throw err;

      const retryAfterMs = parseRetryAfterMs(
        err?.response?.headers?.["retry-after"],
      );
      const backoff = Math.min(
        baseDelayMs * Math.pow(2, attempt - 1),
        maxDelayMs,
      );
      const jitter = Math.floor(Math.random() * jitterMs);
      // Add 250ms safety buffer if retry-after is provided
      const safetyBuffer = retryAfterMs ? 250 : 0;
      const delayMs = Math.max(retryAfterMs ?? 0, backoff) + jitter + safetyBuffer;

      if (onRetry) onRetry(err, attempt, delayMs);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw new Error("requestWithRetry exhausted retries");
}

export async function httpRequest(config, retryOptions = {}) {
  // Add compression headers by default
  const headers = {
    "Accept-Encoding": "gzip, deflate, br",
    ...config.headers,
  };
  return requestWithRetry(() => axios({ ...config, headers }), retryOptions);
}

export async function httpGet(url, config = {}, retryOptions = {}) {
  return httpRequest(
    {
      method: "GET",
      url,
      ...config,
    },
    retryOptions,
  );
}

export async function httpPost(url, data, config = {}, retryOptions = {}) {
  return httpRequest(
    {
      method: "POST",
      url,
      data,
      ...config,
    },
    retryOptions,
  );
}

export async function httpPatch(url, data, config = {}, retryOptions = {}) {
  return httpRequest(
    {
      method: "PATCH",
      url,
      data,
      ...config,
    },
    retryOptions,
  );
}
