import axios from "axios";
import http from "http";
import https from "https";

axios.defaults.httpAgent = new http.Agent({ keepAlive: true });
axios.defaults.httpsAgent = new https.Agent({ keepAlive: true });
const DEFAULT_RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

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
  const baseDelayMs = Number.isFinite(options?.baseDelayMs)
    ? options.baseDelayMs
    : 350;
  const maxDelayMs = Number.isFinite(options?.maxDelayMs)
    ? options.maxDelayMs
    : 6000;
  const jitterMs = Number.isFinite(options?.jitterMs) ? options.jitterMs : 200;
  const onRetry = typeof options?.onRetry === "function" ? options.onRetry : null;
  const retryStatuses = options?.retryStatuses instanceof Set
    ? options.retryStatuses
    : DEFAULT_RETRY_STATUSES;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await requestFn();
    } catch (err) {
      if (!shouldRetry(err, retryStatuses) || attempt === retries) throw err;

      const retryAfterMs = parseRetryAfterMs(err?.response?.headers?.["retry-after"]);
      const backoff = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
      const jitter = Math.floor(Math.random() * jitterMs);
      const delayMs = Math.max(retryAfterMs ?? 0, backoff) + jitter;

      if (onRetry) onRetry(err, attempt, delayMs);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw new Error("requestWithRetry exhausted retries");
}

export async function httpRequest(config, retryOptions = {}) {
  return requestWithRetry(() => axios(config), retryOptions);
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
