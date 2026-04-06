import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";
import { saveWhitelist } from "../lib/redis.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WHITELIST_PATH = path.resolve(__dirname, "../whitelist.json");

async function migrate() {
  try {
    if (!fs.existsSync(WHITELIST_PATH)) {
      console.error("❌ whitelist.json not found.");
      return;
    }

    const data = JSON.parse(fs.readFileSync(WHITELIST_PATH, "utf8"));
    const merged = new Map();

    for (const item of data) {
      const title = item.title.trim();
      const sourceData = {
        url: item.url || null,
        source: item.source,
        mark: item.mark || null,
      };

      if (!merged.has(title)) {
        merged.set(title, {
          title: title,
          sources: [sourceData],
        });
      } else {
        const existing = merged.get(title);
        // Check if this source/url already exists under this title
        const isDup = existing.sources.some(s => s.url === sourceData.url && s.source === sourceData.source);
        if (!isDup) {
          existing.sources.push(sourceData);
        }
      }
    }

    const migrated = Array.from(merged.values()).sort((a, b) => a.title.localeCompare(b.title));

    // Save to file
    fs.writeFileSync(WHITELIST_PATH, JSON.stringify(migrated, null, 2), "utf8");
    console.log(`✅ Migrated! Unique Titles: ${migrated.length} (from ${data.length} total entries)`);

    // Sync to Redis
    console.log("🔄 Syncing to Redis...");
    await saveWhitelist(migrated);
    console.log("✅ Redis updated.");
  } catch (err) {
    console.error("❌ Migration failed:", err.message);
  }
}

migrate();
