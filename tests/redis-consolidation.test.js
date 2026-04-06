import test from "node:test";
import assert from "node:assert/strict";
import axios from "axios";
import { normalizeTitleKey } from "../lib/domain.js";

// Mock axios to prevent real network calls during tests
axios.patch = async () => ({ status: 200, data: {} });
axios.post = async () => ({ status: 200, data: {} });
axios.get = async () => ({ status: 200, data: {} });

// We also need to mock process.env for DISCORD_APPLICATION_ID etc.
process.env.DISCORD_APPLICATION_ID = "123";
process.env.DISCORD_BOT_TOKEN = "abc";

// Global mock for waitUntil to run synchronously during tests
// This needs to be set up BEFORE importing the module that uses it
globalThis.__testWaitUntil = (promise) => promise;

import handleMyProgress from "../lib/commands/myprogress.js";

// Mock waitUntil and discord functions globally or via module mocking
// For now, since we haven't set up full mocking yet, we'll just ensure
// the handler doesn't crash on them.
// Note: handleMyProgress uses waitUntil and editInteractionResponse.

// Mock implementation of Redis with Hash and ZSET support
function createRedisMock() {
  const store = new Map();
  const hashes = new Map();
  const zsets = new Map();

  return {
    store,
    hashes,
    zsets,
    async get(key) {
      return store.get(key) || null;
    },
    async set(key, value) {
      store.set(key, value);
      return "OK";
    },
    async del(key) {
      const deleted = store.delete(key);
      return deleted ? 1 : 0;
    },
    async hget(key, field) {
      return hashes.get(key)?.[field] || null;
    },
    async hset(key, fields) {
      if (!hashes.has(key)) hashes.set(key, {});
      Object.assign(hashes.get(key), fields);
      return Object.keys(fields).length;
    },
    async hdel(key, field) {
      if (hashes.has(key)) {
        delete hashes.get(key)[field];
        return 1;
      }
      return 0;
    },
    async hgetall(key) {
      const hash = hashes.get(key);
      if (!hash) return {};
      // Convert Map to plain object
      return Object.fromEntries(hash);
    },
    async hmget(key, ...fields) {
      const h = hashes.get(key) || {};
      return fields.map((f) => h[f] || null);
    },
    async zadd(key, { score, member }) {
      if (!zsets.has(key)) zsets.set(key, []);
      const z = zsets.get(key);
      const idx = z.findIndex((i) => i.member === member);
      if (idx !== -1) z.splice(idx, 1);
      z.push({ score, member });
      z.sort((a, b) => b.score - a.score);
      return 1;
    },
    async zrem(key, ...members) {
      if (!zsets.has(key)) return 0;
      const z = zsets.get(key);
      const startLen = z.length;
      // Handle both single member and multiple members
      const membersToRemove =
        members.length === 1 && Array.isArray(members[0])
          ? members[0]
          : members;
      zsets.set(
        key,
        z.filter((i) => !membersToRemove.includes(i.member)),
      );
      return startLen - zsets.get(key).length;
    },
    async zcard(key) {
      return zsets.get(key)?.length || 0;
    },
    async zrange(key, start, end) {
      return (
        zsets
          .get(key)
          ?.slice(start, end + 1)
          .map((i) => i.member) || []
      );
    },
    async scan(cursor, { match }) {
      const prefix = match.replace("*", "");
      const keys = Array.from(store.keys()).filter((k) => k.startsWith(prefix));
      return ["0", keys];
    },
    async mget(...keys) {
      return keys.map((k) => store.get(k) || null);
    },
  };
}

const mockRes = {
  json: () => {},
  headersSent: false,
};

test.skip("handleMyProgress: lazy migration during list", async () => {
  const redis = createRedisMock();
  const userId = "user1";
  const title = "Manga A";
  const tk = normalizeTitleKey(title);

  // Set legacy data
  const legacyKey = `user:progress:${userId}:${tk}`;
  const legacyVal = {
    title,
    chapter: "Chapter 1",
    chapterNum: 1,
    timestamp: new Date().toISOString(),
  };
  await redis.set(legacyKey, legacyVal);

  // Trigger migration via list (calling handleMyProgress)
  // We mock payload
  const payload = { member: { user: { id: userId } } };

  await handleMyProgress(payload, [], mockRes, redis);

  // Wait a bit for waitUntil background tasks to finish
  await new Promise((resolve) => setTimeout(resolve, 200));

  // Check migration results
  assert.equal(
    await redis.get(legacyKey),
    null,
    "Legacy key should be deleted",
  );
  const newDataStr = await redis.hget("users:progress_data", userId);
  assert.ok(newDataStr, "Data should exist in new structure");
  const newData = JSON.parse(newDataStr);
  assert.deepEqual(
    newData[tk],
    legacyVal,
    "Legacy data should be migrated to new Hash",
  );
  const newListStr = await redis.hget("users:progress_list", userId);
  assert.ok(newListStr, "List should exist in new structure");
  const newList = JSON.parse(newListStr);
  assert.equal(newList.length, 1, "ZSET index should be created");
});

test.skip("handleMyProgress: write updates to Hash and cleans Legacy", async () => {
  const redis = createRedisMock();
  const userId = "user1";
  const title = "Manga B";
  const tk = normalizeTitleKey(title);

  // Set legacy data
  const legacyKey = `user:progress:${userId}:${tk}`;
  const legacyVal = {
    title,
    chapter: "Chapter 1",
    chapterNum: 1,
    timestamp: new Date().toISOString(),
  };
  await redis.set(legacyKey, legacyVal);

  // Trigger update via button
  const payload = { member: { user: { id: userId } }, message: { flags: 64 } };
  const options = [{ name: "button", value: `read:${title}:Chapter 2` }];

  await handleMyProgress(payload, options, mockRes, redis);

  // Wait a bit for waitUntil background tasks
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.equal(
    await redis.get(legacyKey),
    null,
    "Legacy key should be deleted after update",
  );
  const newDataStr = await redis.hget("users:progress_data", userId);
  assert.ok(newDataStr, "Data should exist in new structure");
  const newData = JSON.parse(newDataStr);
  assert.equal(
    newData[tk].chapter,
    "Chapter 2",
    "Hash should have new chapter",
  );
});

test.skip("handleMyProgress: clear removes from both Hash and Legacy", async () => {
  const redis = createRedisMock();
  const userId = "user1";
  const title = "Manga C";
  const tk = normalizeTitleKey(title);

  // Put data in both (simulating partial migration or just being thorough)
  const legacyKey = `user:progress:${userId}:${tk}`;
  await redis.set(legacyKey, { title });
  await redis.hset(`user:progress_data:${userId}`, { [tk]: { title } });
  await redis.zadd(`user:progress_list:${userId}`, { score: 123, member: tk });

  // Trigger clear
  const payload = { member: { user: { id: userId } } };
  const options = [
    { name: "clear", options: [{ name: "judul", value: title }] },
  ];

  await handleMyProgress(payload, options, mockRes, redis);

  // Wait a bit for waitUntil background tasks
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.equal(await redis.get(legacyKey), null, "Legacy key should be gone");
  const newDataStr = await redis.hget("users:progress_data", userId);
  const newData = newDataStr ? JSON.parse(newDataStr) : {};
  assert.equal(newData[tk], undefined, "Hash field should be gone");
  const newListStr = await redis.hget("users:progress_list", userId);
  const newList = newListStr ? JSON.parse(newListStr) : [];
  assert.equal(newList.length, 0, "List should be empty");
});
