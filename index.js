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
  if (!fs.existsSync(apiDir)) return;

  const files = fs.readdirSync(apiDir).filter((file) => file.endsWith(".js"));

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
            log.error({ err, route: routeName }, "API handler error");
            if (!res.headersSent) {
              res.status(500).json({ error: "Internal Server Error" });
            }
          }
        });
        log.debug({ route: routeName }, "mounted API route");
      }
    } catch (err) {
      log.error({ err, file }, "failed to load API route");
    }
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
        err,
        path: req.path,
        method: req.method,
        requestId: req.headers["x-request-id"] || "unknown",
      },
      "unhandled error",
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
    log.info(
      { port: PORT, url: `http://localhost:${PORT}` },
      "local dev server listening",
    );
  });
}

startServer();
