import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export default async function handler(req, res) {
  try {
    // Test write
    await redis.set("vercel:test", "working");
    const value = await redis.get("vercel:test");
    await redis.del("vercel:test");
    
    return res.status(200).json({
      status: "success",
      message: "Redis is working on Vercel!",
      testValue: value,
      tokenPreview: process.env.UPSTASH_REDIS_REST_TOKEN?.substring(0, 10) + "..."
    });
  } catch (err) {
    return res.status(500).json({
      status: "error",
      message: err.message,
      tokenPreview: process.env.UPSTASH_REDIS_REST_TOKEN?.substring(0, 10) + "..."
    });
  }
}
