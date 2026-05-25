/**
 * Cron job input loading - whitelist, guild channels, source health
 */

import { getLogger } from "../logger.js";
import {
  loadWhitelist,
  getAllGuildChannels,
  supabasePing,
} from "../services/storage.js";
import { loadSourceHealthMap } from "../services/health.js";
import { proactiveHealWhitelist } from "../services/url/healing.js";
import { initializeAllProviders } from "../boot.js";
import { initializeScrapeOptimizer } from "../scrapers/optimizer.js";
import { NOTIFICATION_QUEUE_KEY } from "../constants/redis.js";
import { SOURCE_KEYS } from "../constants/redis.js";
import type {
  RedisClient,
  WhitelistEntry,
  SourceHealth,
} from "../types.js";

const logger = getLogger({ scope: "cron:inputs" });

export interface CronInputs {
  whitelist: WhitelistEntry[];
  guildChannels: Record<string, string>;
  sourceHealthMap: Record<string, SourceHealth>;
  queueHealth: QueueHealth;
}

export interface QueueHealth {
  queueLength: number;
  isHealthy: boolean;
  maxLength: number;
}

export interface LoadInputsOptions {
  redis: RedisClient;
  loadWhitelistFn?: () => Promise<WhitelistEntry[]>;
  getAllGuildChannelsFn?: () => Promise<Record<string, string>>;
  queueMaxLength?: number;
}

/**
 * Load all cron inputs concurrently
 */
export async function loadCronInputs(
  options: LoadInputsOptions,
): Promise<CronInputs> {
  const {
    redis,
    loadWhitelistFn = loadWhitelist,
    getAllGuildChannelsFn = getAllGuildChannels,
    queueMaxLength = 100,
  } = options;

  // Initialize providers and optimizer in parallel
  const initPromise = initializeAllProviders().catch((err: unknown) => {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Provider initialization failed, continuing with registered providers",
    );
  });
  initializeScrapeOptimizer(redis);

  // Anti-Shutdown: Send a ping to Supabase to keep the project active
  supabasePing().catch(() => {}); // Fire and forget

  // Queue health check
  const queueHealthPromise = redis
    .llen(NOTIFICATION_QUEUE_KEY)
    .then((len) => ({
      queueLength: len,
      isHealthy: len < queueMaxLength,
      maxLength: queueMaxLength,
    }));

  const [whitelist, guildChannels, sourceHealthMap, _, queueHealth] =
    await Promise.all([
      loadWhitelistFn(),
      getAllGuildChannelsFn(),
      loadSourceHealthMap(redis, SOURCE_KEYS),
      initPromise,
      Promise.all([
        proactiveHealWhitelist().catch((err: unknown) => {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            "proactiveHealWhitelist failed, continuing",
          );
        }),
        queueHealthPromise,
      ]).then(([_, qh]) => qh),
    ]);

  return {
    whitelist,
    guildChannels: guildChannels || {},
    sourceHealthMap,
    queueHealth,
  };
}

/**
 * Validate that we have minimum required inputs to proceed
 */
export interface ValidationResult {
  valid: boolean;
  reason?: string;
  details?: string;
}

export function validateCronInputs(
  inputs: CronInputs,
): ValidationResult {
  if (!inputs.whitelist.length) {
    return { valid: false, reason: "no_whitelist" };
  }

  const activeGuilds = Object.keys(inputs.guildChannels).length;
  if (!activeGuilds) {
    return { valid: false, reason: "no_guilds" };
  }

  if (!inputs.queueHealth.isHealthy) {
    return {
      valid: false,
      reason: "queue_backpressure",
      details: `Queue has ${inputs.queueHealth.queueLength} items`,
    };
  }

  return { valid: true };
}
