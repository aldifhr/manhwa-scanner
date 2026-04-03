import { loadWhitelist } from "../lib/redis.js";

async function verifyFix() {
  console.log("--- Verifying loadWhitelist Fix ---");
  const list = await loadWhitelist();
  console.log(`Whitelist count: ${list.length}`);
  
  if (list.length > 0) {
    console.log("First item title:", list[0].title);
    console.log("First item structure:", JSON.stringify(list[0], null, 2));
  } else {
    console.log("Error: Whitelist is still empty!");
  }
}

verifyFix().catch(console.error);
