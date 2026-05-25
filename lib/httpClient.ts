import axios, { AxiosRequestConfig, AxiosResponse, AxiosError } from "axios";
import { getLogger } from "./logger.js";
import { AdaptiveRateLimiter, type RetryOptions } from "./types.js";
import type { Agent as HttpAgent } from "http";
import type { Agent as HttpsAgent } from "https";

const logger = getLogger({ scope: "httpClient" });

// Determine if we're in Edge Runtime
const IS_EDGE = typeof process !== 'undefined' && process.env.NEXT_RUNTIME === 'edge';

/**
 * Lazy-loaded Node.js specific agents to prevent bundling into Edge Runtime
 */
let sharedHttpAgent: HttpAgent | undefined;
let sharedHttpsAgent: HttpsAgent | undefined;

async function getAgents() {
  if (IS_EDGE) return { httpAgent: undefined, httpsAgent: undefined };
  
  if (!sharedHttpAgent) {
    try {
      const http = await import("http");
      const https = await import("https");
      
      const agentOptions = {
        keepAlive: true,
        maxSockets: 20,        // Reduced for serverless (was 50)
        maxFreeSockets: 5,     // Reduced (was 10)
        timeout: 8000,         // Shorter timeout for serverless (was 25000)
        freeSocketTimeout: 15000, // Reduced (was 25000)
        scheduling: "fifo" as const, // Fairer scheduling (was lifo)
      };
      
      sharedHttpAgent = new http.default.Agent(agentOptions);
      sharedHttpsAgent = new https.default.Agent(agentOptions);
    } catch (e) {
      logger.debug("Failed to initialize Node.js HTTP agents, falling back to defaults");
    }
  }
  
  return { httpAgent: sharedHttpAgent, httpsAgent: sharedHttpsAgent };
}

const DEFAULT_RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

// Re-export AdaptiveRateLimiter from types.ts for backward compatibility
export { AdaptiveRateLimiter } from "./types.js";

const globalRateLimiter = new AdaptiveRateLimiter();

export function createRateLimiter() {
  return new AdaptiveRateLimiter();
}

export function parseRetryAfterMs(retryAfterHeader: string | undefined): number | null {
  if (!retryAfterHeader) return null;
  const raw = String(retryAfterHeader).trim();
  const asSeconds = Number(raw);
  if (Number.isFinite(asSeconds)) return Math.max(0, asSeconds * 1000);
  const asDate = Date.parse(raw);
  if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());
  return null;
}

function shouldRetry(err: unknown, retryStatuses: Set<number>): boolean {
  const axiosError = err as AxiosError;
  const status = axiosError?.response?.status;
  if (!status) return true;
  return retryStatuses.has(status);
}

// RetryOptions is imported from ./types.js (consolidated canonical definition)
// Re-export for backward compatibility
export type { RetryOptions } from "./types.js";

export async function requestWithRetry<T = any>(
  requestFn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const retries = Number.isFinite(options?.retries)
    ? Math.max(0, options.retries!)
    : 3;
  const maxAttempts = retries + 1;
  const rateLimiter = options?.rateLimiter || globalRateLimiter;
  const adaptiveDelay =
    options?.adaptive !== false ? rateLimiter.getDelay() : 350;
  const baseDelayMs = Number.isFinite(options?.baseDelayMs)
    ? options.baseDelayMs!
    : adaptiveDelay;
  const maxDelayMs = Number.isFinite(options?.maxDelayMs)
    ? options.maxDelayMs!
    : 6000;
  const jitterMs = Number.isFinite(options?.jitterMs) ? options.jitterMs! : 200;
  const onRetry =
    typeof options?.onRetry === "function" ? options.onRetry : null;
  const retryStatuses =
    options?.retryStatuses instanceof Set
      ? options.retryStatuses
      : DEFAULT_RETRY_STATUSES;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const startTime = Date.now();
    const deadline = Number(options?.deadline) || 0;

    if (deadline > 0 && startTime >= deadline) {
      logger.warn(
        { attempt, deadline },
        "Request aborted: deadline reached before attempt",
      );
      throw new Error(`deadlineExceeded: deadline ${deadline} reached before attempt ${attempt}`);
    }

    try {
      const result = await requestFn();
      if (options?.adaptive !== false) {
        rateLimiter.recordResponseTime(Date.now() - startTime);
      }
      return result;
    } catch (err: unknown) {
      if (!shouldRetry(err, retryStatuses) || attempt === maxAttempts)
        throw err;

      const axiosError = err as AxiosError;
      const retryAfterMs = parseRetryAfterMs(
        axiosError?.response?.headers?.["retry-after"] as string | undefined,
      );
      const backoff = Math.min(
        baseDelayMs * Math.pow(2, attempt - 1),
        maxDelayMs,
      );
      const jitter = Math.floor(Math.random() * jitterMs);
      const safetyBuffer = retryAfterMs ? 250 : 0;
      const delayMs =
        Math.max(retryAfterMs ?? 0, backoff) + jitter + safetyBuffer;

      if (deadline > 0 && Date.now() + delayMs + 1000 >= deadline) {
        logger.warn(
          { attempt, delayMs, deadline },
          "Request retry aborted: insufficient time before deadline",
        );
        throw err;
      }

      if (onRetry) onRetry(err, attempt, delayMs);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw new Error(`requestWithRetry exhausted ${retries} retries`);
}

export async function httpRequest(
  config: AxiosRequestConfig,
  retryOptions: RetryOptions = {},
): Promise<AxiosResponse> {
  const headers = {
    "Accept-Encoding": "gzip, deflate, br",
    ...config.headers,
  };
  
  const validateStatus = config.validateStatus || ((s: number) => (s >= 200 && s < 300) || s === 304);

  const { httpAgent, httpsAgent } = await getAgents();
  const timeout = config.timeout ?? 8000;

  return requestWithRetry(
    () => axios({ ...config, headers, validateStatus, httpAgent, httpsAgent, timeout }),
    retryOptions,
  );
}

export async function httpGet(
  url: string,
  config: AxiosRequestConfig = {},
  retryOptions: RetryOptions = {},
): Promise<AxiosResponse> {
  return httpRequest(
    {
      method: "GET",
      url,
      ...config,
    },
    retryOptions,
  );
}

export async function httpPost(
  url: string,
  data?: unknown,
  config: AxiosRequestConfig = {},
  retryOptions: RetryOptions = {},
): Promise<AxiosResponse> {
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

export async function httpPatch(
  url: string,
  data?: unknown,
  config: AxiosRequestConfig = {},
  retryOptions: RetryOptions = {},
): Promise<AxiosResponse> {
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
