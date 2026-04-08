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

// Note: myprogress command was removed from Discord, so its tests have been removed.
// The redis consolidation logic is still used by other parts of the application.
