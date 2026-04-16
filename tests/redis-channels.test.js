import test from "node:test";
import assert from "node:assert/strict";
import {
  deleteGuildChannel,
  getAllGuildChannels,
  getNotificationChannel,
  setNotificationChannel,
} from "../lib/redis.js";

function createRedisMock() {
  const hashes = new Map();

  return {
    hashes,
    async hget(key, field) {
      return hashes.get(key)?.get(field) ?? null;
    },
    async hset(key, value) {
      const current = hashes.get(key) || new Map();
      for (const [field, fieldValue] of Object.entries(value || {})) {
        current.set(field, fieldValue);
      }
      hashes.set(key, current);
      return 1;
    },
    async hgetall(key) {
      const current = hashes.get(key);
      if (!current) return {};
      return Object.fromEntries(current.entries());
    },
    async hdel(key, field) {
      const current = hashes.get(key);
      if (!current) return 0;
      const existed = current.delete(field);
      if (current.size === 0) hashes.delete(key);
      return existed ? 1 : 0;
    },
  };
}

test("channel store uses hash storage for set, get, and delete", async () => {
  const redis = createRedisMock();

  // Test Set
  await setNotificationChannel("guild-1", "123456789012345678", redis);

  // Test Get
  const channelId = await getNotificationChannel("guild-1", redis);
  assert.equal(channelId, "123456789012345678");

  // Test GetAll
  const all = await getAllGuildChannels(redis);
  assert.deepEqual(all, { "guild-1": "123456789012345678" });

  // Test Delete
  await deleteGuildChannel("guild-1", redis);
  const deleted = await getNotificationChannel("guild-1", redis);
  assert.equal(deleted, null);
});

test("getAllGuildChannels results are filtered for empty values", async () => {
  const redis = createRedisMock();
  await redis.hset("channels:guild-map", { "g1": "c1", "g2": "" });

  const all = await getAllGuildChannels(redis);
  assert.deepEqual(all, { "g1": "c1" });
});
