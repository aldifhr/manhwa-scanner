import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";
import { saveWhitelist } from "../lib/redis.js";
import { normalizeWhitelist } from "../lib/domain.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WHITELIST_PATH = path.resolve(__dirname, "../whitelist.json");

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

    console.log(`📊 Current raw entries: ${data.length}`);

    // 1. Normalize and Deduplicate into Multi-Source structure
    // normalizeWhitelist can handle both legacy flat arrays and new nested arrays.
    let normalized = normalizeWhitelist(data);

    // 2. Sort alphabetically by title
    normalized.sort((a, b) => {
      const titleA = (a.title || "").toLowerCase();
      const titleB = (b.title || "").toLowerCase();
      if (titleA < titleB) return -1;
      if (titleA > titleB) return 1;
      return 0;
    });

    // 3. Write back to file
    fs.writeFileSync(WHITELIST_PATH, JSON.stringify(normalized, null, 2), "utf8");

    // 4. Sync to Redis
    console.log("🔄 Syncing to Redis...");
    await saveWhitelist(normalized);

    console.log(`✅ Formatted, merged sources, and synced to Redis! New unique titles: ${normalized.length}`);
  } catch (err) {
    console.error("❌ Error formatting whitelist:", err.message);
  }
}

formatWhitelist();
