import axios from "axios";
import { getLogger } from "../logger.js";
import { env } from "../config/env.js";
import { redis } from "../redis.js";

const logger = getLogger({ scope: "scrapling-bridge" });

export interface ScraplingOptions {
  action: "latest" | "expand" | "search" | "metadata";
  url?: string;
  query?: string;
  baseUrl?: string;
  maxPages?: number;
  skipMeta?: boolean;
}

interface ScraplingResponse<T> {
  data: T;
  _cookies?: Record<string, string>;
}

const COOKIE_REDIS_KEY = "session:ikiru:cookies";

/**
 * Bridge to execute Python Scrapling scraper via HTTP (Vercel compatible)
 */
export async function runScrapling<T>(options: ScraplingOptions): Promise<T> {
  // Determine API base URL
  let apiBase = "http://localhost:3000";
  
  if (env.BASE_URL) {
    apiBase = env.BASE_URL;
  } else if (process.env.VERCEL_URL) {
    apiBase = `https://${process.env.VERCEL_URL}`;
  } else if (env.APP_URL) {
    apiBase = env.APP_URL;
  }

  // Load cookies from Redis if it's Ikiru
  const isIkiru = options.baseUrl?.includes("ikiru") || (!options.baseUrl && (options.url?.includes("ikiru") || options.action === "latest"));
  let existingCookies: string | null = null;
  if (isIkiru) {
    try {
      existingCookies = await redis.get(COOKIE_REDIS_KEY) as string | null;
    } catch (err) {
      logger.warn({ err }, "Failed to load cookies from Redis");
    }
  }

  const isLocal = process.env.NODE_ENV === "development" || !process.env.VERCEL;

  if (isLocal) {
    const cp = "child_process";
    const { spawnSync } = await import(cp);
    const args = [
      "api/scrapling_bridge.py",
      "--action", options.action,
      "--baseUrl", options.baseUrl || "https://05.ikiru.wtf",
      "--maxPages", String(options.maxPages || 1)
    ];
    if (options.url) args.push("--url", options.url);
    if (options.query) args.push("--query", options.query);
    if (options.skipMeta) args.push("--skipMeta");
    if (existingCookies) {
      const cookieStr = typeof existingCookies === "string" ? existingCookies : JSON.stringify(existingCookies);
      args.push("--cookies", cookieStr);
    }
    
    if (isIkiru) {
      if (env.IKIRU_EMAIL) args.push("--username", env.IKIRU_EMAIL);
      if (env.IKIRU_PASSWORD) args.push("--password", env.IKIRU_PASSWORD);
    }

    logger.info({ action: options.action, args: args.map(a => a.length > 100 ? a.substring(0, 50) + "..." : a) }, "Executing local Python scraper");
    
    const result = spawnSync("python", args, { encoding: "utf-8" });
    
    if (result.error) {
      logger.error({ err: result.error.message }, "Local Python scraper execution error");
      throw new Error(`Failed to run local python scraper: ${result.error.message}`);
    }
    
    try {
      const output = result.stdout.trim();
      const stderr = result.stderr.trim();
      
      if (stderr) {
        logger.warn({ stderr }, "Python scraper stderr output");
      }
      
      if (!output) {
        logger.warn("Python scraper returned empty stdout");
        return [] as any;
      }
      
      const parsed = JSON.parse(output) as ScraplingResponse<T>;
      
      // Save new cookies to Redis
      if (isIkiru && parsed._cookies) {
        await redis.set(COOKIE_REDIS_KEY, JSON.stringify(parsed._cookies), { ex: 86400 * 7 });
      }
      
      return parsed.data;
    } catch (err) {
      logger.error({ stdout: result.stdout, stderr: result.stderr }, "Failed to parse local python output");
      throw new Error("Failed to parse local python output");
    }
  }

  const apiUrl = `${apiBase.replace(/\/$/, "")}/api/scrapling_bridge`;
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${env.CRON_SECRET}`,
  };

  if (env.VERCEL_PROTECTION_BYPASS) {
    headers["x-vercel-protection-bypass"] = env.VERCEL_PROTECTION_BYPASS;
    headers["x-vercel-set-bypass-cookie"] = "true";
  }

  const params: Record<string, any> = { ...options };
  if (existingCookies) params.cookies = existingCookies;
  if (env.VERCEL_PROTECTION_BYPASS) {
    params["x-vercel-protection-bypass"] = env.VERCEL_PROTECTION_BYPASS;
  }

  logger.info({ action: options.action, url: options.url, apiUrl }, "Calling Scrapling API");

  try {
    const response = await axios.get(apiUrl, {
      params,
      timeout: 60000,
      headers
    });

    const parsed = response.data as ScraplingResponse<T>;
    
    // Save new cookies to Redis
    if (isIkiru && parsed._cookies) {
      await redis.set(COOKIE_REDIS_KEY, JSON.stringify(parsed._cookies), { ex: 86400 * 7 });
    }
    
    return parsed.data;
  } catch (err: any) {
    const message = err.response?.data || err.message;
    logger.error({ action: options.action, err: message }, "Scrapling API failed");
    throw new Error(`Scrapling API failed: ${message}`);
  }
}
