import axios from "axios";
import http from "http";
import https from "https";

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

// Adaptive rate limiting state
const responseTimeHistory = [];
const MAX_HISTORY_SIZE = 10;
let currentBaseDelayMs = 350;

function recordResponseTime(durationMs) {
  responseTimeHistory.push(durationMs);
  if (responseTimeHistory.length > MAX_HISTORY_SIZE) {
    responseTimeHistory.shift();
  }

  // Calculate average response time
  const avg =
    responseTimeHistory.reduce((a, b) => a + b, 0) / responseTimeHistory.length;

  // Adjust base delay based on server performance
  if (avg > 2000) {
    // Server is slow, increase delay
    currentBaseDelayMs = Math.min(currentBaseDelayMs * 1.2, 1000);
  } else if (avg < 500) {
    // Server is fast, decrease delay
    currentBaseDelayMs = Math.max(currentBaseDelayMs * 0.9, 200);
  }
}

export function getAdaptiveDelay() {
  return Math.round(currentBaseDelayMs);
}

export function resetAdaptiveRateLimit() {
  responseTimeHistory.length = 0;
  currentBaseDelayMs = 350;
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
  const retries = Number.isFinite(options?.retries) ? options.retries : 3;
  // Use adaptive delay if enabled, otherwise use provided or default
  const adaptiveDelay = options?.adaptive !== false ? getAdaptiveDelay() : 350;
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

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const startTime = Date.now();
    try {
      const result = await requestFn();
      // Record successful response time for adaptive rate limiting
      if (options?.adaptive !== false) {
        recordResponseTime(Date.now() - startTime);
      }
      return result;
    } catch (err) {
      if (!shouldRetry(err, retryStatuses) || attempt === retries) throw err;

      const retryAfterMs = parseRetryAfterMs(
        err?.response?.headers?.["retry-after"],
      );
      const backoff = Math.min(
        baseDelayMs * Math.pow(2, attempt - 1),
        maxDelayMs,
      );
      const jitter = Math.floor(Math.random() * jitterMs);
      const delayMs = Math.max(retryAfterMs ?? 0, backoff) + jitter;

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
