import { mangaProviderRegistry } from "./providers/registry.js";
import { ikiruProvider } from "./providers/ikiru.js";
import { shinigamiProvider } from "./providers/shinigami.js";
import { initializeScrapeOptimizer } from "./scrapers/optimizer.js";
import { redis } from "./redis.js";
import { getLogger } from "./logger.js";

const logger = getLogger({ scope: "boot" });

let initialized = false;
let initializationFailed = false;

/**
 * Centralized bootstrap function to initialize and register all providers.
 * Ensures that the bot is ready to handle commands and cron jobs.
 */
export async function initializeAllProviders() {
  if (initialized) return;
  if (initializationFailed) {
    logger.warn("Provider initialization previously failed — skipping retry");
    return;
  }

  try {
    // Initialize scrape optimizer
    initializeScrapeOptimizer(redis);
    logger.info("Scrape optimizer initialized");

    // Register Unified Providers
    mangaProviderRegistry.register(ikiruProvider);
    mangaProviderRegistry.register(shinigamiProvider);

    // Initialize metrics and other provider states
    await Promise.all([
      ikiruProvider.initialize?.(redis),
      shinigamiProvider.initialize?.(redis),
    ]);

    initialized = true;
    logger.info("All providers initialized");
  } catch (err) {
    initializationFailed = true;
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "Failed to initialize");
    throw err;
  }
}
