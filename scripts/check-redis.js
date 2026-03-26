import { loadWhitelist } from "../lib/redis.js";

async function check() {
  const data = await loadWhitelist();
  console.log(`Redis has ${data.length} entries.`);
  console.log(JSON.stringify(data.slice(0, 3), null, 2));
  process.exit(0);
}
check();
