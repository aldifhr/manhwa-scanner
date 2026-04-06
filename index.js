import "dotenv/config";
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { getLogger } from "./lib/logger.js";

const log = getLogger({ module: "express-dev" });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware for parsing JSON and urlencoded bodies, which Vercel does automatically
// Added request size limits to prevent DoS attacks
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// Serve static files from the 'public' directory (matches Vercel's behavior)
app.use(express.static(path.join(__dirname, "public")));

// Dynamically load API routes from the 'api' directory
const apiDir = path.join(__dirname, "api");

async function loadApiRoutes() {
  if (!fs.existsSync(apiDir)) {
    log.warn("API directory not found, skipping route loading");
    return;
  }

  const files = fs.readdirSync(apiDir).filter((file) => file.endsWith(".js"));
  const loadedRoutes = [];
  const failedRoutes = [];

  for (const file of files) {
    const routeName = file.replace(/\.js$/, "");
    const modulePath = pathToFileURL(path.join(apiDir, file)).href;

    try {
      const routeModule = await import(modulePath);
      const handler = routeModule.default;

      if (typeof handler === "function") {
        // Express route definition
        // Vercel handles all HTTP methods through the same handler function
        app.all(`/api/${routeName}`, async (req, res) => {
          try {
            await handler(req, res);
          } catch (err) {
            log.error(
              { err, route: routeName, path: req.path },
              "API handler error",
            );
            if (!res.headersSent) {
              res.status(500).json({ error: "Internal Server Error" });
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
    } catch (err) {
      log.error({ err, file, route: routeName }, "Failed to load API route");
      failedRoutes.push({ name: routeName, error: err.message });
    }
  }

  // Log summary
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

// Start the server
async function startServer() {
  await loadApiRoutes();

  // Catch-all to serve index.html for unknown routes (optional SPA behavior)
  app.use((req, res) => {
    if (req.path.startsWith("/api/")) {
      return res.status(404).json({
        success: false,
        error: { code: "NOT_FOUND", message: "Endpoint not found" },
        timestamp: new Date().toISOString(),
      });
    }
    res.sendFile(path.join(__dirname, "public", "index.html"));
  });

  // Global error handler - must be last
  app.use((err, req, res, next) => {
    log.error(
      {
        err: err.message,
        stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
        path: req.path,
        method: req.method,
        requestId: req.headers["x-request-id"] || "unknown",
        ip: req.ip || req.connection.remoteAddress,
      },
      "Unhandled error",
    );

    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: {
          code: "INTERNAL_ERROR",
          message:
            process.env.NODE_ENV === "production"
              ? "Internal server error"
              : err.message,
        },
        timestamp: new Date().toISOString(),
      });
    }
  });

  app.listen(PORT, () => {
    log.info("═══════════════════════════════════════");
    log.info(
      {
        port: PORT,
        env: process.env.NODE_ENV || "development",
        apiPrefix: "/api",
        dashboard: `http://localhost:${PORT}`,
        status: `http://localhost:${PORT}/status/`,
      },
      "🚀 Server ready",
    );
    log.info("═══════════════════════════════════════");
  });
}

startServer();
