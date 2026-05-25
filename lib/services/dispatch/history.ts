import { DISPATCH_HISTORY_KEY } from "../../constants/redis.js";
import { RedisClient } from "../../types.js";
import { safeJsonParse } from "../../dateUtils.js";
import { getLogger } from "../../logger.js";
import { normalizeCronLogEntry } from "../../cronLogs.js";
import { compactArray } from "../../utils.js";
import { ChapterItem, CronLogEntry } from "../../types.js";

const logger = getLogger({ scope: "dispatch" });
export const LOG_SUMMARY_SAMPLE_LIMIT = 3;

/**
 * Filter expired chapters from the history map by scanning the hash.
 */
export async function scanAndCleanupExpired(
  redisClient: RedisClient,
  nowMs: number,
): Promise<string[]> {
  try {
    const toDelete: string[] = [];
    let cursor = "0";
    const batchSize = 500;

    do {
      const results = await redisClient.hscan(DISPATCH_HISTORY_KEY, cursor, {
        count: batchSize,
      });

      if (!Array.isArray(results) || results.length < 2) break;

      cursor = String(results[0]);
      const entries = results[1] as string[];

      if (Array.isArray(entries)) {
        for (let i = 0; i < entries.length; i += 2) {
          const key = entries[i];
          const rawValue = entries[i + 1];
          const value =
            typeof rawValue === "string" ? safeJsonParse(rawValue, null) : rawValue;
          
          if (!value) {
            // If completely unparseable, stay safe and keep it for now
            // Wiping unparseable data can lead to duplicate notifications
            continue;
          }

          const expiresAt = value.e || value.expiresAt;
          
          // CRITICAL: Only delete if we have a positive expiration timestamp in the past
          if (expiresAt && Number(expiresAt) > 0 && expiresAt < nowMs) {
            toDelete.push(key);
          }
        }
      }
    } while (cursor !== "0" && toDelete.length < 1000);

    return toDelete;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message }, "Error scanning dispatch hash");
    return [];
  }
}

/**
 * Build a summary of results for the cron log after dispatching.
 */
export function buildCronLogSummary(
  items: ChapterItem[] = [],
  failed = 0,
  nowIso = new Date().toISOString(),
): CronLogEntry | null {
  // Always create a log entry - even when nothing was sent (skipped)
  const sample = compactArray(
    items
      .slice(0, LOG_SUMMARY_SAMPLE_LIMIT)
      .map((item) => `${item.title} ${item.chapter}`.trim()),
  );
  const remainder = Math.max(0, items.length - sample.length);
  const detailText = sample.length
    ? `: ${sample.join(", ")}${remainder ? ` (+${remainder} lagi)` : ""}`
    : "";
  const failedText = failed > 0 ? ` | failed=${failed}` : "";

  // Determine tag based on what happened
  let tag: string;
  let code: string;
  let message: string;
  
  if (items.length === 0 && failed <= 0) {
    // Nothing sent, nothing failed = skipped
    tag = "skipped";
    code = "dispatch_skipped";
    message = "Cron completed - no new chapters to notify";
  } else if (failed > 0) {
    // Some succeeded, some failed
    tag = "partial";
    code = "dispatch_partial";
    message = `Cron sent ${items.length} chapter(s)${failedText}${detailText}`;
  } else {
    // All succeeded
    tag = "sent";
    code = "dispatch_sent";
    message = `Cron sent ${items.length} chapter(s)${detailText}`;
  }

  return {
    ...normalizeCronLogEntry({
      time: nowIso,
      message,
      tag,
      code,
      type: "delivery_summary",
      source: "dispatch",
    }),
    count: items.length,
    failed,
    titles: compactArray(items.slice(0, 10).map((item) => item.title)),
  };
}
