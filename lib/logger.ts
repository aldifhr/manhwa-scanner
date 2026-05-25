import pino, { Logger, Bindings, Level } from "pino";
import { env } from "./config/env.js";
import axios from "axios";

// Determine log level from environment
const LOG_LEVEL = env.LOG_LEVEL;

// Determine if we're in development
const isDevelopment = env.NODE_ENV !== "production";

// Base configuration for pino
const baseConfig = {
  level: LOG_LEVEL,
  base: (typeof process !== 'undefined' && process.pid) ? {
    pid: process.pid,
    env: env.NODE_ENV || "development",
  } : {
    env: env.NODE_ENV || "development",
  },
  // Redact sensitive fields
  redact: {
    paths: [
      "password",
      "token",
      "secret",
      "authorization",
      "cookie",
      "session",
      "*.password",
      "*.token",
      "*.secret",
      "req.headers.authorization",
      "req.headers.cookie",
      "res.headers['set-cookie']",
    ],
    remove: true,
  },
  // Custom serializers
  serializers: {
    err: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
  },
};

// Create transport based on environment
let transport;

if (isDevelopment && typeof process !== 'undefined' && process.env.NEXT_RUNTIME !== 'edge') {
  // Pretty print for development - only supported in Node.js
  try {
    transport = {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:yyyy-mm-dd HH:MM:ss.l",
        ignore: "pid,hostname,env",
        messageFormat: "{msg} [{scope}]",
      },
    };
  } catch (e) {
    // Fallback if pino-pretty not available
  }
}

// Create the base logger
const baseLogger: Logger = pino({
  ...baseConfig,
  transport: transport || undefined,
});

import type { LoggerOptions } from "./types.js";
export type { LoggerOptions } from "./types.js";

// AsyncLocalStorage for request context (correlation ID)
import { AsyncLocalStorage } from "async_hooks";

export interface RequestContext {
  correlationId: string;
  requestId?: string;
  userId?: string;
  guildId?: string;
  path?: string;
  method?: string;
}

const requestContextStore = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return requestContextStore.run(context, fn);
}

export function getCurrentContext(): RequestContext | undefined {
  return requestContextStore.getStore();
}

// Generate correlation ID
export function generateCorrelationId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// Create a child logger factory with scope
export function getLogger(bindings: LoggerOptions = {}): Logger {
  const { scope, module, ...rest } = bindings;

  const childBindings: Bindings = {
    ...rest,
  };

  if (scope) {
    childBindings.scope = scope;
  }
  if (module) {
    childBindings.module = module;
  }

  // Add correlation ID from context if available
  const context = getCurrentContext();
  if (context?.correlationId) {
    childBindings.correlationId = context.correlationId;
  }

  return baseLogger.child(childBindings);
}

// Pre-configured loggers for common modules
export const loggers = {
  api: getLogger({ scope: "api" }),
  cron: getLogger({ scope: "cron" }),
  discord: getLogger({ scope: "discord" }),
  redis: getLogger({ scope: "redis" }),
  scraper: getLogger({ scope: "scraper" }),
  dispatch: getLogger({ scope: "dispatch" }),
  auth: getLogger({ scope: "auth" }),
  commands: getLogger({ scope: "commands" }),
};

// Fast log helpers (for hot paths where creating child logger is expensive)
export const fastLog = {
  debug: (msg: string, meta: Record<string, any> = {}) => baseLogger.debug(meta, msg),
  info: (msg: string, meta: Record<string, any> = {}) => baseLogger.info(meta, msg),
  warn: (msg: string, meta: Record<string, any> = {}) => baseLogger.warn(meta, msg),
  error: (msg: string, meta: Record<string, any> = {}) => baseLogger.error(meta, msg),
  fatal: (msg: string, meta: Record<string, any> = {}) => baseLogger.fatal(meta, msg),
};

// Request logging middleware pattern (simplified for TS)
// In a real app, this would use express types if needed
export function requestLogger(req: any, res: any, next: () => void) {
  const start = Date.now();
  const requestId =
    req.headers["x-request-id"] || req.headers["x-vercel-id"] || `req-${start}`;

  const log = getLogger({
    scope: "http",
    requestId,
    method: req.method,
    path: req.path,
  });

  req.log = log;

  res.on("finish", () => {
    const duration = Date.now() - start;
    const level = (res.statusCode >= 400 ? "warn" : "info") as Level;

    log[level](
      {
        res: {
          statusCode: res.statusCode,
          duration,
        },
        userAgent: req.headers["user-agent"],
        ip: req.ip,
      },
      `${req.method} ${req.path} ${res.statusCode}`,
    );
  });

  next();
}

// Error logging helper with stack trace
export function logError(err: any, context: Record<string, any> = {}, logger: Logger = baseLogger) {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  const code = (err as any)?.code;
  const type = err?.constructor?.name;

  logger.error(
    {
      err: {
        message,
        stack,
        code,
        type,
      },
      ...context,
    },
    message || "An error occurred",
  );
}

// Performance logging helper
export function logPerformance(
  operation: string,
  durationMs: number,
  meta: Record<string, any> = {},
  logger: Logger = baseLogger,
) {
  const level = (durationMs > 1000 ? "warn" : "debug") as Level;

  logger[level](
    {
      operation,
      duration: durationMs,
      ...meta,
    },
    `${operation} completed in ${durationMs}ms`,
  );
}

// Backward-compatible API logging functions

function buildReqMeta(req: any) {
  const method = req?.method ?? "UNKNOWN";
  const path = req?.url ?? "";
  const reqId =
    req?.headers?.["x-vercel-id"] ||
    req?.headers?.["x-request-id"] ||
    req?.headers?.["cf-ray"] ||
    null;
  const ip =
    req?.headers?.["x-forwarded-for"] || req?.headers?.["x-real-ip"] || null;
  return { method, path, reqId, ip };
}

export function logApiHit(name: string, req: any): Logger {
  const meta = buildReqMeta(req);
  const logger = getLogger({ endpoint: name, ...meta });
  logger.info({ event: "request_start" }, "api request");
  return logger;
}

export function logApiOk(logger: Logger | null | undefined, extra: Record<string, any> = {}) {
  if (!logger) return;
  logger.info({ event: "request_ok", ...extra }, "api success");
}

export function logApiError(logger: Logger | null | undefined, err: any, extra: Record<string, any> = {}) {
  if (!logger) return;
  const statusCode = err?.response?.status ?? extra.statusCode ?? null;
  const errCode =
    extra.code || err?.code || (statusCode ? `http_${statusCode}` : null);
  const errType = extra.type || err?.name || "Error";

  // Prevent leaking sensitive data in headers
  const filteredHeaders = { ...err?.config?.headers };
  if (filteredHeaders.Authorization)
    filteredHeaders.Authorization = "[REDACTED]";
  if (filteredHeaders.Cookie) filteredHeaders.Cookie = "[REDACTED]";

  logger.error(
    {
      event: "request_error",
      err: err?.message || String(err),
      errCode,
      errType,
      statusCode,
      url: err?.config?.url,
      method: err?.config?.method,
      ...extra,
    },
    "api error",
  );
}

export async function sendErrorLog(webhookUrl: string | undefined, error: any, context = "") {
  if (!webhookUrl) return;
  try {
    const payload = {
      embeds: [
        {
          title: "Bot Error",
          description: `\`\`\`${error.message || error}\`\`\``,
          color: 0xff0000,
          fields: [
            { name: "Context", value: context || "Unknown", inline: true },
            { name: "Time", value: new Date().toISOString(), inline: true },
          ],
          timestamp: new Date().toISOString(),
        },
      ],
    };

    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err: any) {
    console.error("[sendErrorLog] Failed to send error log:", err.message);
  }
}

// Export base logger for direct use
export default baseLogger;

// Re-export pino levels for convenience
export const levels = pino.levels;
