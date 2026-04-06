import pino from "pino";

// Determine log level from environment
const LOG_LEVEL = process.env.LOG_LEVEL ||
  (process.env.NODE_ENV === "production" ? "info" : "debug");

// Determine if we're in development
const isDevelopment = process.env.NODE_ENV !== "production";

// Base configuration for pino
const baseConfig = {
  level: LOG_LEVEL,
  base: {
    pid: process.pid,
    env: process.env.NODE_ENV || "development",
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

if (isDevelopment) {
  // Pretty print for development
  transport = {
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "SYS:yyyy-mm-dd HH:MM:ss.l",
      ignore: "pid,hostname,env",
      messageFormat: "{msg} [{scope}]",
    },
  };
} else {
  // JSON output for production (better for parsing)
  transport = undefined; // Default JSON output
}

// Create the base logger
const baseLogger = pino({
  ...baseConfig,
  transport: transport || undefined,
});

// Create a child logger factory with scope
export function getLogger(bindings = {}) {
  const { scope, module, ...rest } = bindings;

  const childBindings = {
    ...rest,
  };

  if (scope) {
    childBindings.scope = scope;
  }
  if (module) {
    childBindings.module = module;
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
  debug: (msg, meta = {}) => baseLogger.debug(meta, msg),
  info: (msg, meta = {}) => baseLogger.info(meta, msg),
  warn: (msg, meta = {}) => baseLogger.warn(meta, msg),
  error: (msg, meta = {}) => baseLogger.error(meta, msg),
  fatal: (msg, meta = {}) => baseLogger.fatal(meta, msg),
};

// Request logging middleware for Express
export function requestLogger(req, res, next) {
  const start = Date.now();
  const requestId = req.headers["x-request-id"] ||
    req.headers["x-vercel-id"] ||
    `req-${start}`;

  const log = getLogger({
    scope: "http",
    requestId,
    method: req.method,
    path: req.path,
  });

  req.log = log;

  res.on("finish", () => {
    const duration = Date.now() - start;
    const level = res.statusCode >= 400 ? "warn" : "info";

    log[level]({
      res: {
        statusCode: res.statusCode,
        duration,
      },
      userAgent: req.headers["user-agent"],
      ip: req.ip,
    }, `${req.method} ${req.path} ${res.statusCode}`);
  });

  next();
}

// Error logging helper with stack trace
export function logError(err, context = {}, logger = baseLogger) {
  logger.error({
    err: {
      message: err.message,
      stack: err.stack,
      code: err.code,
      type: err.constructor.name,
    },
    ...context,
  }, err.message || "An error occurred");
}

// Performance logging helper
export function logPerformance(operation, durationMs, meta = {}, logger = baseLogger) {
  const level = durationMs > 1000 ? "warn" : "debug";

  logger[level]({
    operation,
    duration: durationMs,
    ...meta,
  }, `${operation} completed in ${durationMs}ms`);
}

// Export base logger for direct use
export default baseLogger;

// Re-export pino levels for convenience
export const levels = pino.levels;
