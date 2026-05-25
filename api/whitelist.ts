import { 
  addWhitelistEntry, 
  removeWhitelistEntryIdentity, 
  markWhitelistEntry,
} from "../lib/services/whitelist.js";
import { loadWhitelist } from "../lib/services/storage.js";
import { logApiHit, logApiOk, logApiError, getLogger } from "../lib/logger.js";
import { isMonitorAuthorized } from "../lib/auth.js";
import { createEdgeResponse, createErrorResponse } from "../lib/api/response.js";
import { redis } from "../lib/redis.js";

const logger = getLogger({ scope: "api:whitelist" });

export const config = {
  runtime: "edge",
};

export default async function handler(req: Request) {
  const reqLogger = logApiHit("whitelist", req);

  try {
    const authorized = await isMonitorAuthorized(req);
    if (!authorized) {
      logApiOk(reqLogger, { status: 401 });
      return createEdgeResponse(createErrorResponse("UNAUTHORIZED", "Unauthorized"), 401);
    }

    const method = req.method;

    if (method === "GET") {
      const items = await loadWhitelist();
      
      const { batchGetMangaMetadata } = await import("../lib/services/storage.js");
      const titles = items.map(it => typeof it === "string" ? it : it.title);
      const metadataArray = await batchGetMangaMetadata(redis, titles);
      const metadataMap: Record<string, any> = {};
      titles.forEach((title, index) => {
        if (metadataArray[index]) {
          metadataMap[title] = metadataArray[index];
        }
      });
      
      const enrichedItems = items.map(it => {
          const entry = typeof it === "string" ? { title: it, sources: [] } : it;
          const title = entry.title;
          
          let meta = metadataMap[title];
          
          if (!meta && entry.sources && entry.sources.length > 0) {
              for (const s of entry.sources) {
                  const slug = s.url?.split("/").filter(Boolean).pop();
                  if (slug && metadataMap[slug]) {
                      meta = metadataMap[slug];
                      break;
                  }
              }
          }

          if (!meta) return it;
          
          return {
              ...entry,
              item: {
                  ...meta,
                  cover: meta.cover || meta.image,
              }
          };
      });

      logApiOk(reqLogger, { status: 200, count: enrichedItems.length });
      return createEdgeResponse(enrichedItems);
    }

    if (method === "POST") {
      const body = await req.json() as { title?: string; url?: string; source?: string };
      const { title, url, source } = body;
      if (!title) return createEdgeResponse(createErrorResponse("BAD_REQUEST", "Title is required"), 400);
      const result = await addWhitelistEntry({ title, url, source }, { redisClient: redis });
      if (result.enrichmentPromise) {
        await result.enrichmentPromise;
      }
      return createEdgeResponse(result);
    }

    if (method === "DELETE") {
      const body = await req.json() as { title?: string; source?: string; url?: string };
      const { title, source, url } = body;
      if (!title) return createEdgeResponse(createErrorResponse("BAD_REQUEST", "Title is required"), 400);
      const result = await removeWhitelistEntryIdentity({ title, source, url }, { redisClient: redis });
      return createEdgeResponse(result);
    }

    if (method === "PATCH") {
      const body = await req.json() as { title?: string; mark?: string };
      const { title, mark } = body;
      if (!title) return createEdgeResponse(createErrorResponse("BAD_REQUEST", "Title is required"), 400);
      const result = await markWhitelistEntry(title, mark ?? null, { redisClient: redis });
      return createEdgeResponse(result);
    }

    return createEdgeResponse(createErrorResponse("METHOD_NOT_ALLOWED", "Method not allowed"), 405);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, "Whitelist API error");
    return createEdgeResponse(createErrorResponse("INTERNAL_ERROR", message), 500);
  }
}
