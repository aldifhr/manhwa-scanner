/**
 * Discord module - notification and interaction handling
 * 
 * NOTE: This module is now organized into domain-specific files in ./discord/.
 * Import from specific files for tree-shaking:
 *   import { sendDiscordEmbed } from "./discord/messaging.js";
 * 
 * This file re-exports everything for backward compatibility.
 */

// Re-export all Discord functionality
export * from "./discord/index.js";
