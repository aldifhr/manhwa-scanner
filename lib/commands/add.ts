import { waitUntil } from "@vercel/functions";
import { InteractionResponseType } from "discord-interactions";
import { createFollowUpMessage, editInteractionResponse, buildMangaPreviewEmbed } from "../discord.js";
import { normalizeSource, sourceLabel } from "../domain.js";
import { addWhitelistEntry } from "../services/whitelist.js";
import { isAddAllowedUser, isOwner, isGuildAdmin, ADD_ALLOWED_USER_IDS } from "../permissions.js";
import { mangaProviderRegistry } from "../providers/registry.js";
import { DISCORD_EPHEMERAL_FLAG } from "../config.js";
import { getLogger } from "../logger.js";
import { withTimeout } from "../utils.js";
import { RedisClient, AutocompleteOption } from "../types.js";
import { env } from "../config/env.js";

const logger = getLogger({ scope: "commands:add" });

function mockWarning(): string {
  if (!env.UPSTASH_REDIS_REST_URL || env.UPSTASH_REDIS_REST_URL.includes("mock-redis.com")) {
    return "\n\n⚠️ **Mode Mock Redis Aktif:** Data tidak akan tersimpan secara permanen. Silakan konfigurasi `UPSTASH_REDIS_REST_URL`.";
  }
  return "";
}

import { initializeAllProviders } from "../boot.js";


/**
 * Parse explicit source prefix from URL (legacy format support)
 * Format: "source:url" e.g., "ikiru:https://...", "shinigami:https://..."
 */
function parseExplicitSource(input: string): { source: string | null; url: string } {
  const match = input.match(/^(ikiru|shinigami):(.+)$/);
  if (match) {
    return { source: match[1], url: match[2].trim() };
  }
  return { source: null, url: input.trim() };
}

/**
 * Add URL with explicit source (for new subcommand format)
 */
async function handleUrlAddWithSource(
  payload: { data?: { options?: { name: string; options?: unknown[] }[] }; member?: { user?: { id?: string } }; user?: { id?: string }; channel_id?: string; token?: string },
  url: string,
  source: "ikiru" | "shinigami",
  redis: RedisClient | null,
  preloadedWhitelistRaw?: string | null,
) {
  try {
    await editInteractionResponse(payload, `⏳ Sedang mengambil data dari ${sourceLabel(source)}, mohon tunggu...`);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[handleUrlAddWithSource] Initial message failed, continuing anyway");
  }

  try {
    logger.info({ url, source }, "[handleUrlAddWithSource] Starting");

    await initializeAllProviders();
    logger.info({ source }, "[handleUrlAddWithSource] Providers initialized");

    const provider = mangaProviderRegistry.getProvider(source);
    logger.info({ provider: !!provider, source }, "[handleUrlAddWithSource] Provider lookup");

    if (!provider) {
      return editInteractionResponse(payload, `❌ Provider ${sourceLabel(source)} tidak ditemukan.`);
    }

    logger.info({ url }, "[handleUrlAddWithSource] Resolving URL...");
    const result = await provider.resolveUrl(url);
    logger.info({ success: result.success, title: result.data?.title, error: result.error?.message }, "[handleUrlAddWithSource] URL resolved");

    if (!result.success || !result.data?.title) {
      return editInteractionResponse(
        payload,
        `❌ Gagal mendapatkan judul dari ${sourceLabel(source)}. ${result.error?.message || "Pastikan URL benar."}`
      );
    }

    const title = result.data.title;
    logger.info({ title, url, source }, "[handleUrlAddWithSource] Adding to whitelist...");

    const addResult = await addWhitelistEntry({ title, url, source }, { redisClient: redis || undefined, preloadedWhitelistRaw });
    logger.info({ status: addResult.status, total: addResult.whitelist.length }, "[handleUrlAddWithSource] Whitelist updated");

    if (addResult.enrichmentPromise) {
      waitUntil(
        addResult.enrichmentPromise.catch((err) => {
          logger.error({ err: err instanceof Error ? err.message : String(err) }, "[handleUrlAddWithSource] Enrichment promise rejected");
        })
      );
    }

    if (addResult.status === "exists") {
      return editInteractionResponse(
        payload,
        `⚠️ **${title}** sudah ada di whitelist (sumber: ${sourceLabel(source)}).`
      );
    }

    const meta = (result.data as any).metadata;
    const embed = buildMangaPreviewEmbed(
      { 
        title, 
        source, 
        mangaUrl: url, 
        metadata: meta || undefined 
      }, 
      new Date().toISOString()
    );

    return editInteractionResponse(
      payload,
      {
        content: `✅ **${title}** sudah ditambah ke dalam whitelist.\n📊 Total: **${addResult.whitelist.length}** manga${mockWarning()}`,
        embeds: [embed]
      }
    );
  } catch (err: unknown) {
    logger.error({ err: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined, url, source }, "[handleUrlAddWithSource] Error");
    return editInteractionResponse(payload, `❌ Gagal: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleUrlAdd(
  payload: { data?: { options?: { name: string; options?: unknown[] }[] }; member?: { user?: { id?: string } }; user?: { id?: string }; channel_id?: string; token?: string },
  input: string,
  redis: RedisClient | null,
  preloadedWhitelistRaw?: string | null,
) {
  try {
    await editInteractionResponse(payload, "⏳ Sedang memproses URL, mohon tunggu...");
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[handleUrlAdd] Initial message failed, continuing anyway");
  }

  try {
    // Check for explicit source prefix
    const { source: explicitSource, url } = parseExplicitSource(input);

    logger.info({ input, explicitSource, url }, "[handleUrlAdd] Starting URL resolution");

    await initializeAllProviders();

    let title: string | null = null;
    let detectedSource: string | null = explicitSource;
    let metadata: any = null;

    if (explicitSource) {
      // Use explicit source - get title from appropriate API
      const provider = mangaProviderRegistry.getProvider(explicitSource);
      if (!provider) {
        return editInteractionResponse(payload, `❌ Source "${explicitSource}" tidak dikenal.`);
      }

      const result = await provider.resolveUrl(url);
      if (!result.success || !result.data?.title) {
        return editInteractionResponse(payload, `❌ Gagal mendapatkan judul dari ${sourceLabel(explicitSource)}.`);
      }
      title = result.data.title;
      metadata = (result.data as any).metadata;
    } else {
      // Auto-detect via registry
      const resolution = await withTimeout(
        mangaProviderRegistry.resolveUrl(url),
        15000,
        "Timeout saat resolve URL (15s)",
      );

      logger.info({
        url,
        resolved: !!resolution.data?.title,
        source: resolution.data?.source
      }, "[handleUrlAdd] URL resolved");

      title = resolution.data?.title || null;
      detectedSource = resolution.data?.source || null;
      metadata = (resolution.data as any)?.metadata;

      if (resolution.error?.message) {
        return editInteractionResponse(payload, `❌ ${resolution.error.message}`);
      }
    }

      if (!title || !detectedSource) {
      return editInteractionResponse(payload, "❌ Gagal mendeteksi judul atau sumber dari URL.\n\n**Tip:** Pastikan URL valid dari ikiru.wtf atau shinigami.id/asia");
    }

    const result = await addWhitelistEntry({ title, url, source: detectedSource }, { redisClient: redis || undefined, preloadedWhitelistRaw });
    
    if (result.enrichmentPromise) {
      waitUntil(
        result.enrichmentPromise.catch((err) => {
          logger.error({ err: err instanceof Error ? err.message : String(err) }, "[handleUrlAdd] Enrichment promise rejected");
        })
      );
    }

    // Build source info message with auto-detect notice for Shinigami
    let sourceInfo = sourceLabel(detectedSource);
    if (detectedSource === "shinigami") {
      sourceInfo += " (auto-detected)";
    }

    if (result.status === "exists") {
      return editInteractionResponse(
        payload,
        {
          content: `⚠️ **${title}** sudah ada di whitelist (sumber: ${sourceInfo}).`,
          components: [
            {
              type: 1, // ACTION_ROW
              components: [
                {
                  type: 2, // BUTTON
                  style: 2, // SECONDARY
                  label: "🔖 Bookmark",
                  custom_id: `follow_toggle:${title.slice(0, 70)}`
                }
              ]
            }
          ]
        }
      );
    }

    // Attempt to wait for enrichment if metadata is missing
    let meta = metadata;
    if (!meta && result.enrichmentPromise) {
      try {
        // Wait max 3s for enrichment
        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 3000));
        meta = await Promise.race([result.enrichmentPromise, timeout]);
      } catch {
        // ignore timeout/error
      }
    }

    const embed = buildMangaPreviewEmbed(
      { 
        title, 
        source: detectedSource || "unknown", 
        mangaUrl: url, 
        metadata: meta || undefined 
      }, 
      new Date().toISOString()
    );

    return editInteractionResponse(
      payload,
      {
        content: `✅ **${title}** sudah ditambah ke dalam whitelist.\n📊 Total: **${result.whitelist.length}** manga${mockWarning()}`,
        embeds: [embed],
        components: [
          {
            type: 1, // ACTION_ROW
            components: [
              {
                type: 2, // BUTTON
                style: 2, // SECONDARY
                label: "🔖 Bookmark",
                custom_id: `follow_toggle:${title.slice(0, 70)}`
              }
            ]
          }
        ]
      }
    );
  } catch (err: unknown) {
    logger.error({ err: err instanceof Error ? err.message : String(err), input }, "[handleUrlAdd] Error");
    return editInteractionResponse(payload, `❌ Gagal: ${err instanceof Error ? err.message : String(err)}`);
  }
}



export default async function handleAdd(
  payload: { data?: { options?: { name: string; options?: unknown[] }[] }; member?: { user?: { id?: string } }; user?: { id?: string }; channel_id?: string; token?: string },
  options: AutocompleteOption[],
  res: { json: (data: Record<string, unknown>) => void },
  redis: RedisClient | null = null,
) {
  // 1. ULTRA-FAST DEFER (must be < 3s for Discord)
  // Don't wait for anything - respond immediately
  const token = payload.token;
  const interactionId = (payload as { id?: string }).id || "unknown";
  
  res.json({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: DISCORD_EPHEMERAL_FLAG },
  });

  // 2. Offload everything else to background with timeout protection
  waitUntil((async () => {
    try {
      // 1. Immediate feedback to replace "is thinking..." placeholder
      await editInteractionResponse(payload, "⏳ Sedang memproses request, mohon tunggu...");

      // Check permission first before initializing providers (Swap checks)
      const userId = payload.member?.user?.id ?? payload.user?.id;
      let isAllowed = false;
      let cachedWhitelistRaw: string | null = null;

      const isStaticAllowed = isOwner(payload) || isGuildAdmin(payload) || (userId && ADD_ALLOWED_USER_IDS.has(userId));

      if (isStaticAllowed) {
        isAllowed = true;
        if (redis) {
          cachedWhitelistRaw = await redis.get("whitelist:db_cache");
        }
      } else if (redis && userId) {
        // Pipeline: permission check + whitelist cache loading in 1 RTT
        const pipeline = redis.pipeline();
        pipeline.sismember("whitelist:allowed_users", userId);
        pipeline.get("whitelist:db_cache");
        const [isAllowedVal, cachedRaw] = await pipeline.exec();
        isAllowed = !!isAllowedVal;
        cachedWhitelistRaw = cachedRaw as string | null;
      } else {
        isAllowed = !redis; // Default to allow if no redis is configured
      }

      if (!isAllowed) {
        return editInteractionResponse(payload, "❌ Command `/add` hanya diizinkan untuk user tertentu.");
      }

      const startTime = Date.now();
      // Initialize providers with 8s timeout (faster than Discord 15s webhook timeout)
      const initTimeout = 8000;
      const initPromise = initializeAllProviders();
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error("Initialization timeout")), initTimeout)
      );
      
      await Promise.race([initPromise, timeoutPromise]);
      
      const initElapsed = Date.now() - startTime;
      if (initElapsed > 5000) {
        logger.warn({ initElapsed }, "[handleAdd] Slow initialization detected");
      }

      // Get subcommand and nested options from payload.data (Discord structure)
      // Try both direct access and fallback to parsing stringified data
      let dataOptions = payload.data?.options || [];
      
      // Fallback: parse from stringified data if options not properly parsed
      if (!dataOptions?.[0]?.options && payload.data) {
        try {
          const parsed = typeof payload.data === "string" ? JSON.parse(payload.data) : payload.data;
          dataOptions = parsed?.options || [];
        } catch (e) {
          logger.warn({ err: e instanceof Error ? e.message : String(e) }, "[handleAdd] Fallback JSON parse failed");
        }
      }
      
      const subcommand = dataOptions?.[0]?.name;
      const subOptions = dataOptions?.[0]?.options || [];

      // Debug: log full payload structure
      logger.info({
        subcommand,
        subOptionsCount: subOptions?.length || 0,
        firstOption: subOptions?.[0],
      }, "[handleAdd] Discord payload parsed");

      // Helper to clean URL value (remove prefixes)
      const cleanUrl = (val: unknown) => {
        if (!val) return null;
        const str = String(val).trim();
        // Remove common prefixes that users might copy-paste
        return str.replace(/^(url|link):\s*/i, "").trim();
      };

      if (subcommand === "url") {
        const url = (subOptions as { name: string; value?: string }[]).find((o) => o.name === "link")?.value;
        if (!url) {
          return editInteractionResponse(payload, "❌ URL tidak ditemukan.");
        }
        return handleUrlAdd(payload, url, redis, cachedWhitelistRaw);
      }

      // Fallback: try to extract URL from payload
      let url = "";

      const findInOptions = (opts: AutocompleteOption[]) => {
        for (const opt of opts) {
          if (opt.name === "link") url = String(opt.value || "").trim();
          if (opt.options) findInOptions(opt.options);
        }
      };
      findInOptions(options || []);

      if (!url) {
        const deepScan = (obj: unknown) => {
          if (!obj || typeof obj !== "object") return;
          if (Array.isArray(obj)) { obj.forEach(deepScan); return; }
          const record = obj as Record<string, unknown>;
          for (const key in record) {
            const val = record[key];
            if (key === "value" && typeof val === "string") {
              if (val.trim().startsWith("http")) url = val.trim();
            }
            if (val && typeof val === "object") deepScan(val);
          }
        };
        deepScan(payload.data?.options || []);
      }

      if (url) {
        await handleUrlAdd(payload, url, redis, cachedWhitelistRaw);
      } else {
        await editInteractionResponse(payload, "❌ Format tidak dikenal.\n*Gunakan `/add url <link>`.*");
      }
    } catch (err: unknown) {
      logger.error({ err: err instanceof Error ? err.message : String(err), interactionId, stack: err instanceof Error ? err.stack : undefined }, "[handleAdd] Background error");
      try {
        await editInteractionResponse(payload, `❌ Terjadi kesalahan: ${err instanceof Error ? err.message : String(err)}`);
      } catch (editErr) {
        logger.error({ err: editErr instanceof Error ? editErr.message : String(editErr) }, "[handleAdd] Failed to send error message");
      }
    }
  })());
}
