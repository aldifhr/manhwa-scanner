/**
 * Optimized HTTP Client with Stream Abort
 * Stops parsing HTML as soon as we find what we need
 */

import axios, { AxiosInstance } from "axios";
import { parse } from "node-html-parser";
import { getLogger } from "./logger.js";
import type { RedisClient } from "./types.js";

const logger = getLogger({ scope: "http-optimized" });

/**
 * Pre-configured Axios instances (Issue #4 fix)
 */
const instances = new Map<string, AxiosInstance>();

/**
 * Get or create pre-configured Axios instance
 */
export function getAxiosInstance(
  baseURL: string,
  defaultHeaders: Record<string, string> = {}
): AxiosInstance {
  const key = baseURL;
  
  if (!instances.has(key)) {
    const instance = axios.create({
      baseURL,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
        ...defaultHeaders,
      },
      timeout: 15000,
      maxRedirects: 3,
      validateStatus: (status) => status < 500,
    });

    // Add response interceptor for logging
    instance.interceptors.response.use(
      (response) => {
        logger.debug({ 
          url: response.config.url,
          status: response.status,
          size: response.data?.length || 0 
        }, "HTTP response");
        return response;
      },
      (error) => {
        logger.error({ 
          url: error.config?.url,
          error: error.message 
        }, "HTTP error");
        return Promise.reject(error);
      }
    );

    instances.set(key, instance);
    logger.debug({ baseURL }, "Created Axios instance");
  }

  return instances.get(key)!;
}

/**
 * Fetch HTML with early abort (Issue #1 fix)
 * Stops downloading as soon as we find the target element
 */
export async function fetchHTMLWithEarlyAbort(
  url: string,
  options: {
    targetSelector?: string; // Stop when this element is found
    maxChunks?: number; // Max chunks to read (1 chunk ≈ 16KB)
    timeout?: number;
    headers?: Record<string, string>;
  } = {}
): Promise<string> {
  const {
    targetSelector,
    maxChunks = 10, // Default: read max 160KB
    timeout = 15000,
    headers = {},
  } = options;

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    let chunkCount = 0;
    let aborted = false;

    const controller = new AbortController();
    
    const timeoutId = setTimeout(() => {
      if (!aborted) {
        aborted = true;
        controller.abort();
        reject(new Error("Request timeout"));
      }
    }, timeout);

    axios({
      url,
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        ...headers,
      },
      responseType: "stream",
      signal: controller.signal,
    })
      .then((response) => {
        const stream = response.data;

        stream.on("data", (chunk: Buffer) => {
          if (aborted) return;

          chunks.push(chunk);
          totalSize += chunk.length;
          chunkCount++;

          // Check if we should abort early
          if (targetSelector) {
            // Try to parse accumulated data
            const html = Buffer.concat(chunks).toString("utf-8");
            
            try {
              const root = parse(html);
              
              // Check if target element exists
              if (root.querySelector(targetSelector)) {
                aborted = true;
                stream.destroy();
                clearTimeout(timeoutId);
                
                logger.debug({ 
                  url,
                  size: totalSize,
                  chunks: chunkCount,
                  reason: "target_found" 
                }, "Early abort");
                
                resolve(html);
                return;
              }
            } catch (err) {
              // Incomplete HTML, continue reading
            }
          }

          // Abort if max chunks reached
          if (chunkCount >= maxChunks) {
            aborted = true;
            stream.destroy();
            clearTimeout(timeoutId);
            
            const html = Buffer.concat(chunks).toString("utf-8");
            
            logger.debug({ 
              url,
              size: totalSize,
              chunks: chunkCount,
              reason: "max_chunks" 
            }, "Early abort");
            
            resolve(html);
          }
        });

        stream.on("end", () => {
          if (!aborted) {
            clearTimeout(timeoutId);
            const html = Buffer.concat(chunks).toString("utf-8");
            
            logger.debug({ 
              url,
              size: totalSize,
              chunks: chunkCount,
              reason: "complete" 
            }, "Full download");
            
            resolve(html);
          }
        });

        stream.on("error", (err: Error) => {
          if (!aborted) {
            clearTimeout(timeoutId);
            reject(err);
          }
        });
      })
      .catch((err) => {
        clearTimeout(timeoutId);
        reject(err);
      });
  });
}

/**
 * Fetch latest updates page with early abort
 * Optimized for Ikiru's latest updates page
 */
export async function fetchLatestUpdatesOptimized(
  url: string,
  _redis?: RedisClient
): Promise<string> {
  // Stop as soon as we find the manga list container
  return fetchHTMLWithEarlyAbort(url, {
    targetSelector: ".listupd, .manga-list, .latest-updates",
    maxChunks: 5, // Only read first ~80KB (enough for latest updates)
    timeout: 10000,
  });
}

/**
 * Fetch manga page with early abort
 * Optimized for manga detail pages
 */
export async function fetchMangaPageOptimized(
  url: string,
  _redis?: RedisClient
): Promise<string> {
  // Stop as soon as we find the chapter list
  return fetchHTMLWithEarlyAbort(url, {
    targetSelector: ".chapter-list, .eplister, #chapterlist",
    maxChunks: 8, // Read first ~128KB (enough for metadata + chapters)
    timeout: 15000,
  });
}

/**
 * Clear all Axios instances (for testing)
 */
export function clearAxiosInstances(): void {
  instances.clear();
}
