import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";
import { saveWhitelist } from "../lib/redis.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WHITELIST_PATH = path.resolve(__dirname, "../whitelist.json");

function cleanObject(obj) {
  const cleaned = {};
  // Fields we want to keep
  const keep = ["title", "url", "source", "mark"];
  
  for (const key of keep) {
    if (obj[key] !== undefined && obj[key] !== null) {
      cleaned[key] = obj[key];
    }
  }
  return cleaned;
}

async function formatWhitelist() {
  try {
    if (!fs.existsSync(WHITELIST_PATH)) {
      console.error("❌ whitelist.json not found at:", WHITELIST_PATH);
      return;
    }

    const rawData = fs.readFileSync(WHITELIST_PATH, "utf8");
    const data = JSON.parse(rawData);

    if (!Array.isArray(data)) {
      console.error("❌ Invalid whitelist format: expected an array.");
      return;
    }

    console.log(`📊 Current entries: ${data.length}`);

    // 1. Clean and deduplicate
    const unique = new Map();
    for (const item of data) {
      const cleaned = cleanObject(item);
      // Create a key for deduplication based on title, url, and source
      const key = `${cleaned.title}|||${cleaned.url}|||${cleaned.source}`;
      if (!unique.has(key)) {
        unique.set(key, cleaned);
      }
    }

    // 2. Sort by title (case-insensitive)
    const sorted = Array.from(unique.values()).sort((a, b) => {
      const titleA = (a.title || "").toLowerCase();
      const titleB = (b.title || "").toLowerCase();
      if (titleA < titleB) return -1;
      if (titleA > titleB) return 1;
      return 0;
    });

    // 3. Write back to file
    fs.writeFileSync(WHITELIST_PATH, JSON.stringify(sorted, null, 2), "utf8");

    // 4. Sync to Redis
    console.log("🔄 Syncing to Redis...");
    await saveWhitelist(sorted);

    console.log(`✅ Formatted, sorted, and synced to Redis! New total: ${sorted.length}`);
    console.log(`♻️ Removed ${data.length - sorted.length} redundant/duplicate entries.`);
  } catch (err) {
    console.error("❌ Error formatting whitelist:", err.message);
  }
}

formatWhitelist();
