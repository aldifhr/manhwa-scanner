import "dotenv/config";
import { redis } from "../lib/redis.js";
import { loadWhitelist } from "../lib/services/storage.js";
import { addWhitelistEntry, removeWhitelistEntry } from "../lib/services/whitelist.js";

// ─── ANSI colors ─────────────────────────────────────────────────────────────
const ok = (s: string) => `\x1b[32m✅ ${s}\x1b[0m`;
const fail = (s: string) => `\x1b[31m❌ ${s}\x1b[0m`;
const info = (s: string) => `\x1b[36mℹ️  ${s}\x1b[0m`;

async function verifyPersistence() {
  console.log(info("🚀 Starting Persistence Verification (Add #13 -> Remove -> Back to #12)"));

  // 1. Initial State
  const initialList = await loadWhitelist();
  const initialCount = initialList.length;
  console.log(info(`Current count: ${initialCount}`));

  if (initialCount !== 12) {
    console.log(fail(`Expected 12 items, but got ${initialCount}. Did you run repair-whitelist?`));
  }

  // 2. Add New Item (#13)
  // Using a unique title that won't collide
  const testTitle = "Antigravity Test Manga " + Date.now();
  console.log(info(`Adding new test item: "${testTitle}"...`));
  
  const addResult = await addWhitelistEntry({
    title: testTitle,
    source: "ikiru"
  });

  if (addResult.status !== "added") {
    console.log(fail(`Failed to add test item. Status: ${addResult.status}`));
    return;
  }

  const listAfterAdd = await loadWhitelist();
  console.log(ok(`Item added. New count: ${listAfterAdd.length}`));
  
  if (listAfterAdd.length !== initialCount + 1) {
    console.log(fail(`Count mismatch! Expected ${initialCount + 1}, got ${listAfterAdd.length}`));
  }

  // 3. Remove Item
  console.log(info(`Removing test item: "${testTitle}"...`));
  const removeResult = await removeWhitelistEntry(testTitle);

  if (removeResult.status !== "removed") {
    console.log(fail(`Failed to remove test item. Status: ${removeResult.status}`));
    return;
  }

  const listAfterRemove = await loadWhitelist();
  console.log(ok(`Item removed. Final count: ${listAfterRemove.length}`));

  if (listAfterRemove.length !== initialCount) {
    console.log(fail(`Final count mismatch! Expected ${initialCount}, got ${listAfterRemove.length}`));
  } else {
    console.log(ok("✨ Persistence Cycle Verified Successfully!"));
  }
}

verifyPersistence().catch(err => {
  console.error(fail("Fatal Error:"), err);
  process.exit(1);
});
