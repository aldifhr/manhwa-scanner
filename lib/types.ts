/**
 * Core type definitions for the manhwa-scrap-discord bot
 * 
 * NOTE: Types are now organized by domain in the ./types/ directory.
 * This file re-exports everything for backward compatibility.
 * 
 * Import from specific domain files for tree-shaking:
 *   import { RedisClient } from "./types/redis.js";
 *   import { ChapterItem } from "./types/scraper.js";
 */

// Re-export everything from the domain-organized types
export * from "./types/index.js";


