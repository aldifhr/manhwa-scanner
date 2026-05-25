
import { getLogger } from "../logger.js";
import { setDynamicOverrides, getDynamicOverrides } from "./dynamicConfig.js";
import { getShinigamiPublicBase } from "../domain.js";
import axios from "axios";

const logger = getLogger({ scope: "domain-healing" });

const SHINIGAMI_SUBDOMAINS = [
  ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(97 + i)),
  "www", "manga", "komik"
];
const SHINIGAMI_TLDS = ["asia", "id", "com", "net"];
const IKIRU_NUMBERS = Array.from({ length: 50 }, (_, i) => (i + 1).toString().padStart(2, '0'));

/**
 * Try to find a working Shinigami domain by testing various combinations
 */
export async function healShinigamiDomain(): Promise<string | null> {
  const currentBase = getShinigamiPublicBase();
  logger.info({ currentBase }, "Starting Shinigami domain healing check...");

  const candidates = [];
  for (const tld of SHINIGAMI_TLDS) {
    // Test apex domain (no subdomain)
    candidates.push(`https://shinigami.${tld}`);
    for (const sub of SHINIGAMI_SUBDOMAINS) {
      candidates.push(`https://${sub}.shinigami.${tld}`);
    }
  }

  // Remove duplicates and current base
  const uniqueCandidates = Array.from(new Set(candidates)).filter(c => c !== currentBase);

  for (const candidate of uniqueCandidates) {
    try {
      logger.debug({ candidate }, "Testing candidate domain...");
      const res = await axios.get(candidate, { timeout: 5000, validateStatus: s => s === 200 });
      
      if (res.status === 200) {
        logger.info({ workingDomain: candidate }, "Found working Shinigami domain!");
        await setDynamicOverrides({ shinigamiBase: candidate });
        return candidate;
      }
    } catch {
      // Ignore failures during probing
    }
  }

  logger.warn("Failed to find any working Shinigami domain replacement");
  return null;
}

/**
 * Try to find a working Ikiru domain by testing numerical subdomains
 */
export async function healIkiruDomain(): Promise<string | null> {
  const { getIkiruPublicBase } = await import("../domain.js");
  const currentBase = getIkiruPublicBase();
  logger.info({ currentBase }, "Starting Ikiru domain healing check...");

  const candidates = IKIRU_NUMBERS.map(num => `https://${num}.ikiru.wtf`);
  const uniqueCandidates = candidates.filter(c => c !== currentBase);

  for (const candidate of uniqueCandidates) {
    try {
      logger.debug({ candidate }, "Testing Ikiru candidate domain...");
      // Use a faster timeout for probing
      const res = await axios.get(candidate, { timeout: 4000, validateStatus: s => s === 200 });
      
      if (res.status === 200) {
        logger.info({ workingDomain: candidate }, "Found working Ikiru domain!");
        await setDynamicOverrides({ ikiruBase: candidate });
        return candidate;
      }
    } catch {
      // Ignore failures
    }
  }

  logger.warn("Failed to find any working Ikiru domain replacement");
  return null;
}

/**
 * Auto-heal if a source failure looks like a domain issue
 */
export async function autoHealIfNeeded(source: string, error: any) {
  const s = String(source).toLowerCase();
  const errStr = String(error).toLowerCase();
  
  const isDomainError = 
    errStr.includes("enotfound") || 
    errStr.includes("econnrefused") || 
    errStr.includes("etimedout") ||
    errStr.includes("404") ||
    errStr.includes("502") ||
    errStr.includes("503");

  if (!isDomainError) return;

  if (s === 'shinigami') {
    logger.warn({ error: errStr }, "Detected potential Shinigami domain failure, triggering healing...");
    return healShinigamiDomain();
  } else if (s === 'ikiru') {
    logger.warn({ error: errStr }, "Detected potential Ikiru domain failure, triggering healing...");
    return healIkiruDomain();
  }
}
