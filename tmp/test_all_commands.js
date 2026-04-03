import "dotenv/config";
import commands from "../lib/commands/index.js";
import { redis } from "../lib/redis.js";

// Mock Response Object
const createMockRes = (cmdName) => ({
  json: (data) => {
    console.log(`[${cmdName}] Response:`, JSON.stringify(data, null, 2));
    return data;
  }
});

// Mock Payload
const createMockPayload = (name, options = [], userId = "user123") => ({
  id: "interaction_id",
  token: "interaction_token",
  type: 2,
  guild_id: "guild123",
  member: {
    user: { id: userId, username: "Tester" },
    permissions: "8" // Admin
  },
  data: {
    name,
    options
  }
});

async function runTests() {
  console.log("🚀 Starting Comprehensive Command Test...\n");

  const testList = [
    { name: "status", options: [] },
    { name: "list", options: [{ name: "page", value: 1 }] },
    { name: "check", options: [] },
    { name: "health", options: [] },
    { name: "random", options: [] },
    { name: "myprogress", options: [{ name: "list", options: [{ name: "page", value: 1 }] }] },
    // { name: "add", options: [{ name: "title", value: "Solo Leveling" }] }, // Optional: dangerous if real
  ];

  for (const t of testList) {
    console.log(`\n--- Testing /${t.name} ---`);
    const handler = commands[t.name];
    if (!handler) {
      console.error(`❌ No handler found for /${t.name}`);
      continue;
    }

    try {
      const payload = createMockPayload(t.name, t.options);
      // Note: Some handlers use res.json immediately, some use waitUntil/editInteractionResponse
      await handler(payload, t.options, createMockRes(t.name), redis);
      console.log(`✅ Handler /${t.name} executed successfully (Check response above)`);
    } catch (err) {
      console.error(`❌ Error in /${t.name}:`, err.message);
    }
  }

  console.log("\n--- Cleanup ---");
  // Close redis if needed, but here it's global
  process.exit(0);
}

runTests();
