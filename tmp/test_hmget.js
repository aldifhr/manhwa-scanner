import { redis } from "../lib/redis.js";

async function testHMGET() {
  const DATA_KEY = "whitelist:data";
  const INDEX_KEY = "whitelist:index";

  const index = await redis.zrange(INDEX_KEY, 0, 4);
  console.log("Index members:", index);

  if (index.length === 0) {
      console.log("Error: Index is empty.");
      return;
  }

  // Test hmget with spread
  const dataSpread = await redis.hmget(DATA_KEY, ...index);
  console.log("HMGET spread result count:", dataSpread.length);
  console.log("First item spread:", dataSpread[0]);

  // Test hget on the first member
  const single = await redis.hget(DATA_KEY, index[0]);
  console.log("HGET single result:", single);
}

testHMGET().catch(console.error);
