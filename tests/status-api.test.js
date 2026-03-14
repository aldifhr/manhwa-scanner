import test from "node:test";
import assert from "node:assert/strict";
import {
  STATUS_EMPTY_CACHE_VALUE,
  decodeStatusCacheValue,
  encodeStatusCacheValue,
  hasStatusCacheValue,
} from "../lib/statusCache.js";

test("status cache encodes null with a sentinel", () => {
  assert.equal(encodeStatusCacheValue(null), STATUS_EMPTY_CACHE_VALUE);
  assert.equal(decodeStatusCacheValue(STATUS_EMPTY_CACHE_VALUE), null);
});

test("status cache leaves non-null payloads unchanged", () => {
  const payload = { sent: 3, sourceHealth: { ikiru: { status: "healthy" } } };
  assert.deepEqual(encodeStatusCacheValue(payload), payload);
  assert.deepEqual(decodeStatusCacheValue(payload), payload);
  assert.equal(decodeStatusCacheValue(undefined), undefined);
});

test("status cache hit detection treats nullish values as misses", () => {
  assert.equal(hasStatusCacheValue(undefined), false);
  assert.equal(hasStatusCacheValue(null), false);
  assert.equal(hasStatusCacheValue(STATUS_EMPTY_CACHE_VALUE), true);
  assert.equal(hasStatusCacheValue({ ok: true }), true);
});
