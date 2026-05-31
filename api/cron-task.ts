import type { Request, Response } from "express";
import { Receiver } from "@upstash/qstash";
import { redis, withDistributedLock } from "../lib/redis.js";
import { runCronJob } from "../lib/cronRuntime.js";
import { isQStashEnabled } from "../lib/services/qstash.js";
import { getLogger } from "../lib/logger.js";
import {
  QSTASH_CURRENT_SIGNING_KEY,
  QSTASH_NEXT_SIGNING_KEY,
} from "../lib/config.js";

const logger = getLogger({ scope: "cron-task" });

export const config = { api: { bodyParser: true } };

const receiver = new Receiver({
  currentSigningKey: QSTASH_CURRENT_SIGNING_KEY || "",
  nextSigningKey: QSTASH_NEXT_SIGNING_KEY || "",
});

export default async function handler(req: Request, res: Response) {
  // Verify QStash webhook signature in production
  const qstashSignature = req.headers["upstash-signature"] as string | undefined;
  
  if (!qstashSignature && process.env.NODE_ENV !== "development") {
    logger.warn("No QStash signature provided to cron-task");
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const isValid = await receiver.verify({
      signature: qstashSignature || "",
      body: JSON.stringify(req.body),
    });

    if (!isValid && process.env.NODE_ENV !== "development") {
      logger.warn("Invalid QStash signature on cron-task");
      return res.status(401).json({ error: "Unauthorized" });
    }
  } catch (err) {
    logger.error({ err }, "Signature verification error on cron-task");
    if (process.env.NODE_ENV !== "development") {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  try {
    const task = req.body;
    if (!task || task.action !== "scrape_source" || !task.source || !task.channelIds) {
      logger.warn({ task }, "Invalid task payload on cron-task");
      return res.status(400).json({ error: "Invalid payload" });
    }

    const source = task.source;
    const activeChannelIds = task.channelIds as string[];
    const scrapeOptions = task.options || {};

    logger.info({ source, channels: activeChannelIds.length }, "Processing QStash scrape task");

    // Force run ONLY the selected source by disabling the other provider
    const disabledSources = source === "ikiru" ? ["shinigami"] : ["ikiru"];
    const lockKey = `cron:run:lock:${source}`;

    let taskResult: any = null;

    await withDistributedLock(redis, lockKey, async () => {
      taskResult = await runCronJob({
        redisClient: redis,
        logger,
        scrapeOptions: {
          ...scrapeOptions,
          skipExpansion: false,
        },
        scrapeMangaUpdatesWithMetaFn: async (redisClient, opts) => {
          const { scrapeMangaUpdatesWithMeta } = await import("../lib/scrapers/orchestrator.js");
          return scrapeMangaUpdatesWithMeta(redisClient || redis, {
            ...opts,
            disabledSources,
          });
        },
        deadlineMs: 290_000,
      });

      logger.info({ source, status: taskResult?.statusCode }, "Provider scrape task finished successfully");
    }, { ttlSec: 45, timeoutMs: 0, label: `Scrape:${source}`, autoRenew: true });

    return res.status(200).json({ 
      success: true, 
      source, 
      outcome: taskResult?.body?.outcome || "done" 
    });
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, "Provider scrape task failed");
    
    if (message.includes("Gagal mendapatkan lock")) {
      return res.status(409).json({ error: "LOCKED", message });
    }
    // Return 200 so QStash doesn't keep retrying if there is a real scrape logic or target page failure
    return res.status(200).json({ success: false, error: message });
  }
}
