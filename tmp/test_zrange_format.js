import "dotenv/config";
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

async function testZRange() {
  const key = "test:zset";
  try {
    await redis.zadd(key, { score: 10, member: "m1" }, { score: 20, member: "m2" });
    
    // In Upstash SDK, you use zrange with { rev: true, withScores: true }
    const res = await redis.zrange(key, 0, -1, { rev: true, withScores: true });
    console.log("Result content:", JSON.stringify(res, null, 2));
    
    await redis.del(key);
  } catch (err) {
    console.error("Error:", err.message);
  }
}

testZRange();
