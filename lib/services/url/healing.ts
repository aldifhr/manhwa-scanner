import { normalizeSourceUrl, getIkiruPublicBase, getShinigamiPublicBase, normalizeSource } from "../../domain.js";
import { loadWhitelist, saveWhitelist } from "../storage.js";
import { getLogger } from "../../logger.js";
import { AxiosResponse } from "axios";
import { httpGet } from "../../httpClient.js";
import { HTTP_USER_AGENT } from "../../scrapers/shared.js";

const logger = getLogger({ scope: "url-healing" });

let lastHealAttemptMs = 0;
const HEAL_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * Extracts the base URL (protocol + host) from a full URL.
 * 
 * @param url - The full URL to extract the base from
 * @returns The base URL or null if invalid
 */
function extractBaseUrl(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/**
 * Detects if a redirect occurred and triggers healing if necessary.
 * 
 * @param originalUrl - The URL that was initially requested
 * @param response - The Axios response object
 * @returns Promise that resolves when detection is complete
 */
export async function detectAndHealRedirect(originalUrl: string, response: AxiosResponse) {
  try {
    // Axios in Node.js stores the final URL here
    const finalUrl = response.request?.res?.responseUrl || response.config.url;

    if (!finalUrl || !originalUrl) return;

    const rawOriginal = originalUrl.toLowerCase().trim().replace(/\/+$/, "");
    const rawFinal = finalUrl.toLowerCase().trim().replace(/\/+$/, "");

    if (rawOriginal !== rawFinal) {
      const oldBase = extractBaseUrl(rawOriginal);
      const newBase = extractBaseUrl(rawFinal);

      if (oldBase && newBase && oldBase !== newBase) {
        logger.info({ oldBase, newBase }, "Detected domain redirect, initiating healing");
        await bulkUpdateWhitelistBaseUrl(oldBase, newBase);
      }
    }
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "Error in detectAndHealRedirect");
  }
}

/**
 * Updates all whitelist entries that use an old base URL with a new one.
 * 
 * @param oldBase - The old base URL (e.g., https://04.ikiru.wtf)
 * @param newBase - The new base URL (e.g., https://04.ikiru.wtf)
 */
export async function bulkUpdateWhitelistBaseUrl(oldBase: string, newBase: string) {
  try {
    const whitelist = await loadWhitelist();
    let changeCount = 0;

    for (const entry of whitelist) {
      if (!entry.sources) continue;

      for (const source of entry.sources) {
        if (source.url && source.url.includes(oldBase)) {
          const updatedUrl = source.url.replace(oldBase, newBase);
          if (updatedUrl !== source.url) {
            source.url = updatedUrl;
            changeCount++;
          }
        }
      }
    }

    if (changeCount > 0) {
      logger.info({ oldBase, newBase, changeCount }, "Performing bulk whitelist update");
      await saveWhitelist(whitelist);
      logger.info({ changeCount }, "Bulk whitelist update completed");
    }
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "Failed to perform bulk whitelist update");
  }
}

/**
 * Proactively checks whitelist entries for outdated base URLs and triggers healing.
 * Best run periodically or at startup.
 */
export async function proactiveHealWhitelist() {
  const now = Date.now();
  if (now - lastHealAttemptMs < HEAL_COOLDOWN_MS) return;
  lastHealAttemptMs = now;

  try {
    const whitelist = await loadWhitelist();
    const ikiruBase = getIkiruPublicBase();
    const shigBase = getShinigamiPublicBase();

    const suspectBases = new Map<string, string>();

    for (const entry of whitelist) {
      if (!entry.sources) continue;
      for (const source of entry.sources) {
        if (!source.url) continue;

        const currentUrl = source.url.toLowerCase();
        const normSource = normalizeSource(source.source);
        const currentBase = extractBaseUrl(currentUrl);

        if (!currentBase) continue;

        const isOutdated = (normSource === "ikiru" && !currentUrl.startsWith(ikiruBase)) ||
          (normSource === "shinigami" && !currentUrl.startsWith(shigBase));

        if (isOutdated && !suspectBases.has(currentBase)) {
          suspectBases.set(currentBase, source.url); // Store a sample URL
        }
      }
    }

    if (suspectBases.size === 0) return;

    logger.info({ count: suspectBases.size }, "Found suspect base URLs in whitelist, starting proactive check");

    for (const [oldBase, sampleUrl] of suspectBases.entries()) {
      try {
        // Ping a sample URL to see if it redirects
        const res = await httpGet(sampleUrl, {
          headers: { "User-Agent": HTTP_USER_AGENT },
          timeout: 5000,
          maxRedirects: 5,
          validateStatus: (s) => (s >= 200 && s < 400) || s === 403 // Allow 403 to see final URL if possible
        });

        const finalUrl = res.request?.res?.responseUrl || res.config.url;
        logger.debug({ oldBase, sampleUrl, finalUrl }, "Proactive check result");

        if (finalUrl) {
          const newBase = extractBaseUrl(finalUrl);
          if (newBase && newBase !== oldBase) {
            logger.info({ oldBase, newBase }, "Proactive check confirmed redirect");
            await bulkUpdateWhitelistBaseUrl(oldBase, newBase);
          }
        }
      } catch (err) {
        logger.debug({ oldBase, err: err instanceof Error ? err.message : String(err) }, "Proactive check failed for base URL");
      }
    }
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "Error in proactiveHealWhitelist");
  }
}
