/**
 * QStash Client - Serverless message queue from Upstash
 * Used for async notification processing
 */

import { Client } from "@upstash/qstash";
import { QSTASH_ENABLED, QSTASH_TOKEN, QSTASH_WORKER_URL, env } from "../config.js";
import { getLogger } from "../logger.js";

const logger = getLogger({ scope: "qstash" });

let qstashClient: Client | null = null;

function getQStashClient(): Client | null {
  if (!QSTASH_ENABLED || !QSTASH_TOKEN) {
    return null;
  }

  if (!qstashClient) {
    qstashClient = new Client({
      token: QSTASH_TOKEN,
      // User is in us-east-1
      baseUrl: "https://qstash-us-east-1.upstash.io",
    });
  }

  return qstashClient;
}

export interface QStashNotificationTask {
  chapter: {
    title: string;
    chapter: string;
    source: string;
    url: string;
    cover?: string;
    updatedTime?: string;
    mangaUrl?: string;
    // Keys for Redis state management
    key?: string;
    duplicateKey?: string;
    titleKey?: string;
    description?: string;
    rating?: string;
    genres?: string[];
  };
  channelIds: string[];
  mentions?: string[];
}

export async function publishToQStash(task: QStashNotificationTask): Promise<boolean> {
  if (!QSTASH_ENABLED) {
    return false;
  }

  if (!QSTASH_WORKER_URL) {
    logger.warn({ chapterTitle: task.chapter.title }, "QSTASH_WORKER_URL not configured, skipping QStash publish");
    return false;
  }

  const client = getQStashClient();
  if (!client) {
    logger.warn({ chapterTitle: task.chapter.title }, "QStash client not initialized, skipping QStash publish");
    return false;
  }

  try {
    const headers: Record<string, string> = {};
    if (env.VERCEL_PROTECTION_BYPASS) {
      headers["x-vercel-protection-bypass"] = env.VERCEL_PROTECTION_BYPASS;
    }

    const result = await client.publishJSON({
      url: QSTASH_WORKER_URL,
      body: task,
      retries: 3,
      headers,
    });

    logger.info({ messageId: result.messageId, chapter: task.chapter.title }, "Published to QStash");
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, "QStash publish error");
    return false;
  }
}

export async function publishBatchToQStash(tasks: QStashNotificationTask[]): Promise<number> {
  const client = getQStashClient();
  if (!client || tasks.length === 0) return 0;

  try {
    const results = await client.batchJSON(
      tasks.map((task, index) => {
        const headers: Record<string, string> = {};
        if (env.VERCEL_PROTECTION_BYPASS) {
          headers["x-vercel-protection-bypass"] = env.VERCEL_PROTECTION_BYPASS;
        }
        return {
          url: QSTASH_WORKER_URL!,
          body: task,
          retries: 3,
          delay: index * 1, // Staggered delay (1s per task) to avoid Discord rate limits
          headers,
        };
      })
    );
    logger.info({ count: results.length }, "Batch published to QStash");
    return results.length;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, "QStash batch publish error");
    return 0;
  }
}

export function isQStashEnabled(): boolean {
  const enabled = QSTASH_ENABLED && !!QSTASH_WORKER_URL && !!QSTASH_TOKEN;
  logger.info({ 
    enabled, 
    QSTASH_ENABLED, 
    hasWorkerUrl: !!QSTASH_WORKER_URL,
    hasToken: !!QSTASH_TOKEN 
  }, "QStash enabled check");
  return enabled;
}

export interface QStashScrapeTask {
  action: "scrape_source";
  source: "ikiru" | "shinigami";
  channelIds: string[];
  options?: {
    force?: boolean;
    fullRefresh?: boolean;
    incremental?: boolean;
    deduplicate?: boolean;
    fastSecondaryLimit?: number;
  };
}

export async function publishScrapeTaskToQStash(task: QStashScrapeTask): Promise<boolean> {
  if (!QSTASH_ENABLED) {
    return false;
  }

  const client = getQStashClient();
  if (!client) {
    logger.warn({ source: task.source }, "QStash client not initialized, skipping scrape task publish");
    return false;
  }

  let apiBase = "http://localhost:3000";
  if (env.BASE_URL) {
    apiBase = env.BASE_URL;
  } else if (process.env.APP_URL) {
    apiBase = process.env.APP_URL;
  } else if (process.env.VERCEL_URL) {
    apiBase = `https://${process.env.VERCEL_URL}`;
  }
  const workerUrl = `${apiBase.replace(/\/$/, "")}/api/cron-task`;
  const failureCallback = `${apiBase.replace(/\/$/, "")}/api/admin-actions?action=qstash-dlq`;

  try {
    const headers: Record<string, string> = {
      "Upstash-Failure-Callback-Forward-Authorization": `Bearer ${env.CRON_SECRET || ""}`
    };
    if (env.VERCEL_PROTECTION_BYPASS) {
      headers["x-vercel-protection-bypass"] = env.VERCEL_PROTECTION_BYPASS;
      headers["Upstash-Failure-Callback-Forward-x-vercel-protection-bypass"] = env.VERCEL_PROTECTION_BYPASS;
    }

    const result = await client.publishJSON({
      url: workerUrl,
      body: task,
      retries: 3,
      failureCallback,
      headers
    });

    logger.info({ messageId: result.messageId, source: task.source, failureCallback }, "Scrape task published to QStash");
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message, source: task.source }, "QStash scrape task publish error");
    return false;
  }
}