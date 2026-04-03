import handleMyProgress from "../lib/commands/myprogress.js";
import { normalizeTitleKey } from "../lib/domain.js";

// Mocking external dependencies
const mockWaitUntil = (promise) => promise; // Run immediately in test
const mockEditInteractionResponse = async (payload, content) => {
    // console.log(`[Mock Discord] editInteractionResponse: ${content}`);
    return { content };
};
const mockEditInteractionResponseWithComponents = async (payload, content, components) => {
    // console.log(`[Mock Discord] editInteractionResponseWithComponents: ${content}`);
    return { content, components };
};

// Override imports or just use local mocks if we can pass them
// Since we are running the real handler, we need the library to not fail.
// A common trick is to use --loader or just mock the global/module.
// But we can also just let it fail at the end of the logic we care about.

async function testConsolidation() {
  console.log("--- Starting Redis Consolidation Test ---");

  const userId = "test_user_123";
  const title = "Mock Manga";
  const titleKey = normalizeTitleKey(title);
  const legacyKey = `user:progress:${userId}:${titleKey}`;
  const indexKey = `user:progress_list:${userId}`;
  const hashKey = `user:progress_data:${userId}`;

  // Mock Redis State
  let store = {
    [legacyKey]: { title, chapter: "Chapter 1", chapterNum: 1, timestamp: new Date().toISOString() }
  };
  let zset = []; // Simple array for zset mock [{member, score}]
  let hash = {}; // For user:progress_data

  const mockRedis = {
    get: async (key) => store[key] || null,
    set: async (key, val) => { store[key] = val; },
    del: async (key) => { delete store[key]; },
    hget: async (key, field) => hash[key]?.[field] || null,
    hset: async (key, fields) => {
      if (!hash[key]) hash[key] = {};
      Object.assign(hash[key], fields);
    },
    hdel: async (key, field) => { if (hash[key]) delete hash[key][field]; },
    hmget: async (key, ...fields) => fields.map(f => hash[key]?.[f] || null),
    zadd: async (key, { score, member }) => {
      zset = zset.filter(i => i.member !== member);
      zset.push({ score, member });
      zset.sort((a, b) => b.score - a.score);
    },
    zrem: async (key, member) => { zset = zset.filter(i => i.member !== member); },
    zcard: async (key) => zset.length,
    zrange: async (key, start, end, options) => {
        let res = zset.slice(start, end + 1);
        return res.map(i => i.member);
    },
    scan: async (cursor, { match, count }) => {
        // Simple scan mock for legacy keys
        const keys = Object.keys(store).filter(k => k.startsWith(`user:progress:${userId}:`));
        return ["0", keys];
    },
    mget: async (...keys) => keys.map(k => store[k] || null)
  };

  const mockRes = {
    json: (data) => {
        // console.log("Response:", JSON.stringify(data, null, 2));
        return data;
    },
    headersSent: false
  };

  console.log("1. Testing Lazy Migration via List...");
  // Simulate /myprogress list
  await handleMyProgress({ member: { user: { id: userId } } }, [], mockRes, mockRedis);
  
  // Wait for waitUntil promises (simulated here)
  // In real code, waitUntil is used. Here we assume sequential for mock.
  
  console.log("Checking state after list (migration 1):");
  console.log("Legacy key exists?", !!store[legacyKey]);
  console.log("Hash data exists?", !!hash[hashKey]?.[titleKey]);
  console.log("ZSET index exists?", zset.length > 0);

  if (!store[legacyKey] && hash[hashKey]?.[titleKey] && zset.length > 0) {
    console.log("✅ Migration 1 Success: Data moved to Hash and Index.");
  } else {
    console.log("❌ Migration 1 Failed.");
  }

  console.log("\n2. Testing Write Update...");
  // Simulate "Mark as Read" button for Chapter 2
  const payloadButton = {
    member: { user: { id: userId } },
    message: { flags: 0 }
  };
  const optionsButton = [{ name: "button", value: `read:${title}:Chapter 2` }];
  
  await handleMyProgress(payloadButton, optionsButton, mockRes, mockRedis);

  console.log("Checking state after update:");
  console.log("New Chapter in Hash:", hash[hashKey][titleKey].chapter);
  
  if (hash[hashKey][titleKey].chapter === "Chapter 2") {
    console.log("✅ Update Success: Written to Hash.");
  } else {
    console.log("❌ Update Failed.");
  }

  console.log("\n3. Testing Clear...");
  const optionsClear = [{ name: "clear", options: [{ name: "judul", value: title }] }];
  await handleMyProgress(payloadButton, optionsClear, mockRes, mockRedis);

  console.log("Checking state after clear:");
  console.log("Hash entry exists?", !!hash[hashKey]?.[titleKey]);
  console.log("ZSET entry exists?", zset.length > 0);

  if (!hash[hashKey]?.[titleKey] && zset.length === 0) {
    console.log("✅ Clear Success: Removed from Hash and Index.");
  } else {
    console.log("❌ Clear Failed.");
  }

  console.log("\n--- Test Completed ---");
}

testConsolidation().catch(console.error);
