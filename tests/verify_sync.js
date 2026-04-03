import "dotenv/config";
import { redis } from "../lib/redis.js";
import { setUserNotifyMode, NOTIFY_MODES } from "../lib/services/notifications.js";

async function testSync() {
  const testUserId = "test-user-audit";
  console.log("Setting mode to ALL...");
  await setUserNotifyMode(testUserId, NOTIFY_MODES.ALL);
  
  const isMember = await redis.sismember("users:mode:all", testUserId);
  console.log(`Is member of users:mode:all: ${isMember === 1}`);
  
  console.log("Setting mode to FOLLOWS...");
  await setUserNotifyMode(testUserId, NOTIFY_MODES.FOLLOWS);
  
  const isMemberStill = await redis.sismember("users:mode:all", testUserId);
  console.log(`Is still member: ${isMemberStill === 1}`);
  
  // Cleanup
  await redis.del(`user:settings:${testUserId}`);
  await redis.srem("users:mode:all", testUserId);
  console.log("Test complete.");
}

testSync().catch(console.error);
