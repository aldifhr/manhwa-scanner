import { Redis } from "@upstash/redis";
import dotenv from "dotenv";

dotenv.config();

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

async function testRedis() {
  console.log("🔌 Testing Redis connection...\n");
  
  try {
    // Test 1: Write
    console.log("1️⃣ Testing WRITE (set)...");
    await redis.set("test:write", "hello");
    console.log("✅ Write successful\n");
    
    // Test 2: Read
    console.log("2️⃣ Testing READ (get)...");
    const value = await redis.get("test:write");
    console.log("✅ Read successful:", value, "\n");
    
    // Test 3: Delete
    console.log("3️⃣ Testing DELETE (del)...");
    await redis.del("test:write");
    console.log("✅ Delete successful\n");
    
    // Test 4: Check whitelist
    console.log("4️⃣ Checking whitelist data...");
    const whitelist = await redis.get("whitelist:manga");
    if (whitelist) {
      console.log("✅ Whitelist found:", Array.isArray(whitelist) ? whitelist.length + " manga" : "data exists");
    } else {
      console.log("⚠️ Whitelist not found in Redis");
    }
    
    console.log("\n🎉 All tests passed! Redis is working correctly.");
    
  } catch (err) {
    console.error("\n❌ Error:", err.message);
    console.log("\n💡 Solution: Check your Redis token permissions in Upstash console");
  }
}

testRedis();
