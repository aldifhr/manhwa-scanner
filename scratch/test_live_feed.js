import { redis, appendLiveEvent } from "./lib/redis.js";

async function test() {
  console.log("Adding test live event...");
  await appendLiveEvent(redis, { message: "Test: Live Feed system online 🚀", type: "success" });
  await appendLiveEvent(redis, { message: "Test: Another system check...", type: "info" });
  console.log("Done.");
  process.exit(0);
}

test();
