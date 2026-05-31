// Suppress Node.js url.parse() deprecation warning from dependencies
process.on("warning", (warning) => {
  if (warning.name === "DeprecationWarning" && warning.message.includes("url.parse()")) {
    return; // Suppress url.parse() warnings from dependencies
  }
  console.warn(warning);
});

import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { getLogger } from "./lib/logger.js";
import { rateLimitMiddleware } from "./lib/rateLimiter.js";

const log = getLogger({ module: "express-dev" });

// Define custom interface for tracked errors
interface TrackedError extends Error {
  code?: string | number;
  statusCode?: number;
}

// Extend Express Request
import "express";
declare module "express" {
  interface Request {
    correlationId?: string;
    trackError?: (err: any, meta?: any) => void;
  }
}

// Error tracking utilities
function extractErrorContext(err: any, req: Request | null = null) {
  return {
    message: err.message,
    stack: err.stack,
    code: err.code || err.statusCode,
    name: err.name,
    path: req?.path,
    method: req?.method,
    timestamp: new Date().toISOString(),
  };
}

function logError(err: any, context = {}) {
  const errorInfo = {
    ...extractErrorContext(err),
    ...context,
  };

  log.error(errorInfo, err.message);
  return errorInfo;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// CORS middleware - configurable via environment
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS?.split(",").map(o => o.trim()).filter(Boolean) || [];
const isProduction = process.env.NODE_ENV === "production";

app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  
  // In production, only allow specific origins
  // In development, allow all (but still respect origin header for security)
  let allowedOrigin = "*";
  if (isProduction && ALLOWED_ORIGINS.length > 0) {
    // Check if origin is in allowed list
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
      allowedOrigin = origin;
    } else {
      // No origin header or not in allowed list - restrict
      allowedOrigin = ALLOWED_ORIGINS[0] || "false";
    }
  } else if (origin) {
    // Development: echo back the origin for better CORS support
    allowedOrigin = origin;
  }
  
  if (allowedOrigin !== "false") {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  }
  
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, X-Request-Id");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  
  // Handle preflight requests
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  
  next();
});

// Correlation ID middleware for request tracing
app.use((req: Request, res: Response, next: NextFunction) => {
  const correlationId =
    (req.headers["x-correlation-id"] as string) ||
    (req.headers["x-request-id"] as string) ||
    crypto.randomUUID();
  req.correlationId = correlationId;
  res.setHeader("x-correlation-id", correlationId);
  next();
});

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// Rate limiting middleware
app.use(rateLimitMiddleware.standard);



// Global error tracking middleware
app.use((req: Request, _res: Response, next: NextFunction) => {
  req.trackError = (err: any, meta = {}) => {
    logError(err, {
      path: req.path,
      method: req.method,
      ip: req.ip,
      ...meta,
    });
  };
  next();
});

app.use(express.static(path.join(__dirname, "public")));

const apiDir = path.join(__dirname, "api");

const createErrorResponse = (code: string, message: string) => ({
  success: false,
  error: { code, message },
  timestamp: new Date().toISOString(),
});

process.on("unhandledRejection", (reason: any, promise: Promise<any>) => {
  log.error(
    { reason: reason?.message || reason, promise },
    "Unhandled Promise Rejection",
  );
});

process.on("uncaughtException", (err: Error) => {
  log.error(extractErrorContext(err), "Uncaught Exception");
  setTimeout(() => process.exit(1), 1000);
});

async function loadApiRoutes() {
  if (!fs.existsSync(apiDir)) {
    log.warn("API directory not found, skipping route loading");
    return;
  }

  const files = fs.readdirSync(apiDir).filter((file) => file.endsWith(".js") || file.endsWith(".ts"));
  const loadedRoutes: string[] = [];
  const failedRoutes: { name: string; error: string }[] = [];

  for (const file of files) {
    const routeName = file.replace(/\.(js|ts)$/, "");
    const modulePath = pathToFileURL(path.join(apiDir, file)).href;

    try {
      const routeModule = await import(modulePath);
      const handler = routeModule.default;

      const isEdgeRuntime = routeModule.config?.runtime === "edge";

      if (typeof handler === "function") {
        app.all(`/api/${routeName}`, async (req, res) => {
          try {
            let result: any;
            if (isEdgeRuntime) {
              const url = `http://localhost${req.originalUrl}`;
              const webReq = new globalThis.Request(url, {
                method: req.method,
                headers: req.headers as Record<string, string>,
                body: req.method !== "GET" && req.method !== "HEAD"
                  ? JSON.stringify(req.body)
                  : undefined,
              });
              result = await handler(webReq as any, res);
            } else {
              result = await handler(req, res);
            }
            if (result && typeof result === "object" && result.constructor?.name === "Response") {
              const webResponse = result as globalThis.Response;
              webResponse.headers.forEach((value: string, key: string) => {
                if (key.toLowerCase() !== 'content-encoding') {
                  res.setHeader(key, value);
                }
              });
              res.status(webResponse.status);
              const body = await webResponse.text();
              res.send(body);
            }
          } catch (err: any) {
            log.error(
              { 
                err: err.message, 
                stack: err.stack,
                type: err.constructor?.name,
                route: routeName, 
                path: req.path 
              },
              "API handler error",
            );
            if (!res.headersSent) {
              res.status(500).json({ 
                error: "Internal Server Error",
                details: process.env.NODE_ENV !== "production" ? err.message : undefined
              });
            }
          }
        });
        loadedRoutes.push(routeName);
      } else {
        log.warn(
          { file, route: routeName },
          "API module missing default export",
        );
      }
    } catch (err: any) {
      log.error({ err, file, route: routeName }, "Failed to load API route");
      failedRoutes.push({ name: routeName, error: err.message });
    }
  }

  log.info(
    {
      loaded: loadedRoutes.length,
      failed: failedRoutes.length,
      routes: loadedRoutes.sort(),
    },
    "API routes loaded",
  );

  if (failedRoutes.length > 0) {
    log.warn({ failedRoutes }, "Some API routes failed to load");
  }
}

async function startServer() {
  await loadApiRoutes();

  app.use((req: Request, res: Response) => {
    if (req.path.startsWith("/api/")) {
      return res.status(404).json(createErrorResponse("NOT_FOUND", "Endpoint not found"));
    }
    res.sendFile(path.join(__dirname, "public", "index.html"));
  });

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : String(err);
    const error = err instanceof Error ? err : new Error(String(err));
    log.error(
      {
        err: message,
        stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
        path: req.path,
        method: req.method,
        requestId: req.headers["x-request-id"] || "unknown",
        ip: req.ip || req.socket?.remoteAddress,
      },
      "Unhandled error",
    );

    if (!res.headersSent) {
      res.status(500).json(
        createErrorResponse(
          "INTERNAL_ERROR",
          process.env.NODE_ENV === "production"
            ? "Internal server error"
            : message,
        ),
      );
    }
  });

  app.listen(PORT, () => {
    log.info("========================================");
    log.info(
      {
        port: PORT,
        env: process.env.NODE_ENV || "development",
        apiPrefix: "/api",
        dashboard: `http://localhost:${PORT}`,
        status: `http://localhost:${PORT}/status/`,
      },
      "Server ready",
    );
    log.info("========================================");
  });
}

startServer();
