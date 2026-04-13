import "dotenv/config";
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

async function test() {
  try {
    const pong = await redis.ping();
    console.log("Redis Ping:", pong);
  } catch (err) {
    console.error("Redis connection failed:", err.message);
  }
}

test();
