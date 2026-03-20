import test from "node:test";
import assert from "node:assert/strict";
import {
  CRON_LAST_RUN_KEY,
  STATUS_CACHE_TTL_SEC,
  writeCronStatus,
} from "../lib/monitorStore.js";
import { STATUS_API_CACHE_KEY } from "../lib/cacheKeys.js";

test("writeCronStatus writes last-run payload and refreshes status cache without invalidation", async () => {
  const store = new Map();
  let delCount = 0;
  const redis = {
    async get(key) {
      return store.get(key) ?? null;
    },
    async set(key, value, options) {
      store.set(key, value);
      if (key === STATUS_API_CACHE_KEY) {
        store.set(key + ":ttl", options?.ex ?? null);
      }
      return "OK";
    },
    async del() {
      delCount += 1;
      return 1;
    },
  };

  const payload = { sent: 2, skipped: 1, timestamp: "2026-03-20T00:00:00.000Z" };
  await writeCronStatus(redis, payload);

  assert.deepEqual(store.get(CRON_LAST_RUN_KEY), payload);
  assert.deepEqual(store.get(STATUS_API_CACHE_KEY), payload);
  assert.equal(store.get(STATUS_API_CACHE_KEY + ":ttl"), STATUS_CACHE_TTL_SEC);
  assert.equal(delCount, 0);
});
