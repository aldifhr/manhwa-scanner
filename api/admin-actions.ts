import { redis } from "../lib/redis.js";
import { loadWhitelist, getAllGuildChannels } from "../lib/services/storage.js";
import { getLogger } from "../lib/logger.js";
import { isMonitorAuthorized, isCronAuthorized } from "../lib/auth.js";
import { createEdgeResponse, createErrorResponse } from "../lib/api/response.js";
import { scrapeMangaUpdatesWithMeta } from "../lib/scrapers/orchestrator.js";
import { dispatchChapters } from "../lib/services/dispatch.js";
import { normalizeTitleKey, createWhitelistMatcher } from "../lib/domain.js";
import { initializeAllProviders } from "../lib/boot.js";
import { sendDiscordEmbed, sendDiscordEmbedsChannelBatch } from "../lib/discord.js";
import type { ChapterItem } from "../lib/types.js";
import { 
  WHITELIST_API_CACHE_KEY, 
  RECENT_API_CACHE_KEY, 
  LOGS_API_CACHE_KEY,
  WHITELIST_DB_CACHE_KEY 
} from "../lib/constants/redis.js";

const logger = getLogger({ scope: "admin-actions" });

export const config = {
  runtime: "edge",
};

export default async function handler(req: Request) {
  try {
    if (req.method !== "POST") {
      return createEdgeResponse(createErrorResponse("METHOD_NOT_ALLOWED", "Method not allowed"), 405);
    }

    // 1. Parse body first
    let body: any = {};
    try {
      if (typeof (req as any).json === "function") {
        body = await (req as any).json();
      } else if (typeof (req as any).text === "function") {
        const text = await (req as any).text();
        body = JSON.parse(text || "{}");
      } else {
        const chunks: Uint8Array[] = [];
        for await (const chunk of req as any) {
          chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        }
        const raw = Buffer.concat(chunks as Buffer[]).toString("utf-8");
        body = JSON.parse(raw || "{}");
      }
    } catch {
      body = {};
    }

    // Parse action from body or URL query
    const urlObj = new URL(req.url);
    const action = body.action || urlObj.searchParams.get("action");

    // 2. Perform action-specific authorization
    let authorized = false;
    if (action === "qstash-dlq") {
      authorized = await isCronAuthorized(req) || await isMonitorAuthorized(req);
    } else {
      authorized = await isMonitorAuthorized(req);
    }

    if (!authorized) {
      return createEdgeResponse(createErrorResponse("UNAUTHORIZED", "Unauthorized"), 401);
    }

    // --- Action Handlers ---

    if (action === "clear-cache") {
      logger.info("Admin action: clearing all whitelist and API caches");
      await Promise.all([
        redis.del(WHITELIST_DB_CACHE_KEY),
        redis.del(WHITELIST_API_CACHE_KEY),
        redis.del(RECENT_API_CACHE_KEY),
        redis.del(LOGS_API_CACHE_KEY),
        redis.del("api:health-status:cache:v1")
      ]);
      return createEdgeResponse({ success: true, message: "All caches cleared successfully" });
    }

    if (action === "force-unlock") {
      logger.info("Admin action: forcing manual unlock of all Redis execution locks");
      await Promise.all([
        redis.del("cron:run:lock"),
        redis.del("cron:run:lock:ikiru"),
        redis.del("cron:run:lock:shinigami")
      ]);
      return createEdgeResponse({ success: true, message: "All Redis execution locks cleared successfully" });
    }

    if (action === "sync-db") {
      logger.info("Admin action: forcing Supabase -> Redis sync");
      // Clear cache first to ensure loadWhitelist fetches fresh from Supabase
      await redis.del(WHITELIST_DB_CACHE_KEY);
      const list = await loadWhitelist();
      
      // Also clear API caches to reflect new data immediately
      await Promise.all([
        redis.del(WHITELIST_API_CACHE_KEY),
        redis.del("api:health-status:cache:v1")
      ]);

      return createEdgeResponse({ 
        success: true, 
        count: list.length, 
        message: `Database sync complete. Found ${list.length} manga titles.` 
      });
    }

    if (action === "reset-health") {
      logger.info("Admin action: resetting source health circuit breakers");
      const data = await redis.hgetall("sources:health") as Record<string, string> || {};
      const updates: Record<string, string> = {};
      for (const [source, raw] of Object.entries(data)) {
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            parsed.status = "healthy";
            parsed.consecutiveFailures = 0;
            parsed.disabledUntil = null;
            parsed.lastError = null;
            updates[source] = JSON.stringify(parsed);
          } catch {
            // Ignore corrupted JSON
          }
        }
      }
      if (Object.keys(updates).length > 0) {
        await redis.hset("sources:health", updates);
      }
      // Invalidate API and logs caches to reflect immediately
      await Promise.all([
        redis.del(LOGS_API_CACHE_KEY),
        redis.del("api:health-status:cache:v1")
      ]);

      return createEdgeResponse({
        success: true,
        message: "All source health states reset to healthy successfully"
      });
    }

    if (action === "qstash-dlq") {
      const { messageId, error, url } = body || {};
      logger.error({ messageId, error, url }, "QStash task failed permanently (DLQ Callback received)");

      // Decode the original task body (Base64 representation of enqueued body)
      let decodedBody: any = {};
      if (body?.body) {
        try {
          const decodedStr = Buffer.from(body.body, "base64").toString("utf-8");
          decodedBody = JSON.parse(decodedStr);
        } catch (err) {
          logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Failed to decode enqueued task body from QStash");
        }
      }

      const sourceName = decodedBody.source || "unknown";
      const actionName = decodedBody.action || "unknown";
      const options = decodedBody.options ? JSON.stringify(decodedBody.options) : "none";

      const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
      if (webhookUrl) {
        const discordEmbed = {
          username: "QStash Auditor",
          avatar_url: "https://raw.githubusercontent.com/upstash/qstash/main/logo.png",
          embeds: [
            {
              title: "🔴 QStash Background Task Permanently Failed (DLQ)",
              description: `A background scraping task delegated to QStash has exhausted all **3 retries** and failed permanently.`,
              color: 14706278, // Hex: 0xe06666 (Soft Red)
              fields: [
                { name: "🔍 Source Provider", value: `\`${sourceName.toUpperCase()}\``, inline: true },
                { name: "⚡ Task Action", value: `\`${actionName}\``, inline: true },
                { name: "🆔 Message ID", value: `\`${messageId || "N/A"}\``, inline: false },
                { name: "🔗 Worker Endpoint", value: `\`${url || "N/A"}\``, inline: false },
                { name: "⚙️ Task Options", value: `\`${options}\``, inline: false },
                { name: "❌ Error Message", value: `\`\`\`text\n${error || "Unknown execution error"}\n\`\`\``, inline: false }
              ],
              timestamp: new Date().toISOString(),
              footer: {
                text: "ManhwaScanner Auditing Service",
                icon_url: "https://raw.githubusercontent.com/upstash/qstash/main/logo.png"
              }
            }
          ]
        };

        const discordRes = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(discordEmbed)
        });

        if (!discordRes.ok) {
          logger.warn({ status: discordRes.status }, "Failed to deliver failure notification to Discord Webhook");
        } else {
          logger.info("Successfully dispatched DLQ alert to Discord Webhook");
        }
      } else {
        logger.warn("DISCORD_WEBHOOK_URL environment variable is missing, skipping webhook report");
      }

      return createEdgeResponse({ success: true, message: "DLQ callback handled successfully" });
    }

    if (action === "sync-manga") {
      const { title } = body;
      if (!title) {
        return createEdgeResponse(createErrorResponse("BAD_REQUEST", "Manga title is required"), 400);
      }

      logger.info({ title }, "Manual sync triggered");

      // Initialize providers
      await initializeAllProviders();

      // Load whitelist and guild channels
      const [whitelist, guildChannels] = await Promise.all([
        loadWhitelist(),
        getAllGuildChannels(redis)
      ]);
      
      const manga = whitelist.find(m => normalizeTitleKey(m.title) === normalizeTitleKey(title));

      if (!manga) {
        return createEdgeResponse(createErrorResponse("NOT_FOUND", "Manga not found in whitelist"), 404);
      }

      // Prepare targeted scrape options
      const options = {
        preferredIkiruTitles: [manga.title],
        preferredSecondaryTitles: {
          shinigami: [manga.title],
        },
        force: true, // Force scrape even if recently checked
        incremental: false, // Get all available chapters for better coverage in manual sync
        deduplicate: true,
      };

      // Run scrape
      const { items } = await scrapeMangaUpdatesWithMeta(redis, options);

      if (items.length === 0) {
        return createEdgeResponse({ 
          sent: 0, 
          message: "No new chapters found for this title." 
        });
      }

      // Match with whitelist for canonical title
      const matcher = createWhitelistMatcher(whitelist);
      const matchedItems = items.map(item => {
        const entry = matcher(item);
        return entry ? { ...item, canonicalTitle: entry.title } : null;
      }).filter(Boolean);

      // Dispatch found chapters
      const channelIds = Object.values(guildChannels || {});
      const dispatchResult = await dispatchChapters({ 
        redis, 
        matched: matchedItems as ChapterItem[],
        channelIds,
        sendEmbed: sendDiscordEmbed,
        sendEmbedsBatch: sendDiscordEmbedsChannelBatch
      });

      logger.info({ 
        title, 
        found: items.length, 
        sent: dispatchResult.sent 
      }, "Manual sync completed");

      return createEdgeResponse({
        sent: dispatchResult.sent,
        skipped: dispatchResult.skipped,
        failed: dispatchResult.failed,
        chapters: matchedItems.map(ch => ch!.chapter),
        message: `Sync complete. Sent ${dispatchResult.sent} chapters.`
      });
    }

    return createEdgeResponse(createErrorResponse("INVALID_ACTION", "Invalid action"), 400);
  } catch (err: any) {
    logger.error({ err: err.message }, "[admin-actions] Error");
    return createEdgeResponse(createErrorResponse("INTERNAL_ERROR", err.message), 500);
  }
}
