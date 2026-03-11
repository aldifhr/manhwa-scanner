import test from "node:test";
import assert from "node:assert/strict";
import {
  deleteGuildChannelFromStore,
  getAllGuildChannelsFromStore,
  getNotificationChannelFromStore,
  setNotificationChannelInStore,
} from "../lib/redis.js";

function createRedisMock() {
  const kv = new Map();
  const hashes = new Map();
  const calls = {
    scan: 0,
    mget: 0,
  };

  return {
    kv,
    hashes,
    calls,
    async get(key) {
      return kv.get(key) ?? null;
    },
    async set(key, value) {
      kv.set(key, value);
      return "OK";
    },
    async del(key) {
      kv.delete(key);
      return 1;
    },
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
    async scan(cursor, options = {}) {
      calls.scan += 1;
      const prefix = String(options.match || "").replace("*", "");
      const keys = Array.from(kv.keys()).filter((key) => key.startsWith(prefix));
      return [0, Number(cursor) === 0 ? keys : []];
    },
    async mget(...keys) {
      calls.mget += 1;
      return keys.map((key) => kv.get(key) ?? null);
    },
  };
}

test("channel store reads from hash without legacy scan", async () => {
  const redis = createRedisMock();

  await setNotificationChannelInStore(redis, "guild-1", "123456789012345678");

  const channelId = await getNotificationChannelFromStore(redis, "guild-1");
  const all = await getAllGuildChannelsFromStore(redis);

  assert.equal(channelId, "123456789012345678");
  assert.deepEqual(all, { "guild-1": "123456789012345678" });
  assert.equal(redis.calls.scan, 0);
  assert.equal(redis.calls.mget, 0);
});

test("channel store migrates legacy guild keys into hash", async () => {
  const redis = createRedisMock();
  redis.kv.set("channel:100", "200");
  redis.kv.set("channel:101", "201");

  const all = await getAllGuildChannelsFromStore(redis);

  assert.deepEqual(all, { "100": "200", "101": "201" });
  assert.equal(redis.calls.scan, 1);
  assert.equal(redis.calls.mget, 1);
  assert.equal(await redis.hget("channels:guild-map", "100"), "200");
  assert.equal(await redis.hget("channels:guild-map", "101"), "201");
});

test("channel store falls back to legacy key for single guild and hydrates hash", async () => {
  const redis = createRedisMock();
  redis.kv.set("channel:555", "999");

  const value = await getNotificationChannelFromStore(redis, "555");

  assert.equal(value, "999");
  assert.equal(await redis.hget("channels:guild-map", "555"), "999");
});

test("channel store delete removes hash and legacy entries", async () => {
  const redis = createRedisMock();
  await setNotificationChannelInStore(redis, "777", "888");
  redis.kv.set("channel:777", "888");

  await deleteGuildChannelFromStore(redis, "777");

  assert.equal(await redis.hget("channels:guild-map", "777"), null);
  assert.equal(await redis.get("channel:777"), null);
});
