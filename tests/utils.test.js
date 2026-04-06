import { describe, it } from "node:test";
import assert from "node:assert";
import {
  safeParseDate,
  getTimestampMs,
  isValidDate,
  toISOSafe,
  formatDisplayDate,
  getRelativeTime,
  parseDateWithFallback,
  isWithinLastDays,
  isWithinLastHours,
  compareDatesDesc,
  compareDatesAsc,
  sortByDateDesc,
  sortByDateAsc,
  safeJsonParse,
  getCachedOrFetch,
} from "../lib/dateUtils.js";
import {
  chunkArray,
  debounceFn,
  throttleFn,
  memoizeFn,
  retryAsync,
  withTimeout,
  sleep,
  deepClone,
  deepMerge,
  getValue,
  unique,
  uniqueBy,
  groupByKey,
  sortByKey,
  filterArray,
  compactArray,
} from "../lib/utils.js";

// ============================================================================
// dateUtils Tests
// ============================================================================

describe("dateUtils", () => {
  describe("safeParseDate", () => {
    it("should return null for null/undefined input", () => {
      assert.strictEqual(safeParseDate(null), null);
      assert.strictEqual(safeParseDate(undefined), null);
      assert.strictEqual(safeParseDate(""), null);
    });

    it("should return valid Date for Date input", () => {
      const now = new Date();
      const result = safeParseDate(now);
      assert.ok(result instanceof Date);
      assert.strictEqual(result.getTime(), now.getTime());
    });

    it("should return valid Date for ISO string", () => {
      const result = safeParseDate("2024-01-15T10:30:00.000Z");
      assert.ok(result instanceof Date);
      assert.strictEqual(result.toISOString(), "2024-01-15T10:30:00.000Z");
    });

    it("should return null for invalid date string", () => {
      assert.strictEqual(safeParseDate("invalid"), null);
      assert.strictEqual(safeParseDate("not-a-date"), null);
    });
  });

  describe("getTimestampMs", () => {
    it("should return timestamp for valid date", () => {
      const now = new Date();
      const result = getTimestampMs(now);
      assert.strictEqual(result, now.getTime());
    });

    it("should return NaN for invalid date", () => {
      assert.ok(Number.isNaN(getTimestampMs("invalid")));
    });
  });

  describe("isValidDate", () => {
    it("should return true for valid dates", () => {
      assert.strictEqual(isValidDate(new Date()), true);
      assert.strictEqual(isValidDate("2024-01-15"), true);
    });

    it("should return false for invalid dates", () => {
      assert.strictEqual(isValidDate(null), false);
      assert.strictEqual(isValidDate("invalid"), false);
    });
  });

  describe("toISOSafe", () => {
    it("should return ISO string for valid date", () => {
      const result = toISOSafe("2024-01-15T10:30:00.000Z");
      assert.ok(result.includes("2024-01-15"));
    });

    it("should return null for invalid date", () => {
      assert.strictEqual(toISOSafe("invalid"), null);
    });
  });

  describe("getRelativeTime", () => {
    it("should return 'Just now' for recent time", () => {
      const now = new Date();
      assert.strictEqual(getRelativeTime(now), "Just now");
    });

    it("should return 'Unknown' for null", () => {
      assert.strictEqual(getRelativeTime(null), "Unknown");
    });

    it("should return future text for future dates", () => {
      const future = new Date(Date.now() + 60000);
      assert.strictEqual(getRelativeTime(future), "In the future");
    });
  });

  describe("isWithinLastDays", () => {
    it("should return true for recent dates", () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      assert.strictEqual(isWithinLastDays(yesterday, 2), true);
    });

    it("should return false for old dates", () => {
      const old = new Date("2020-01-01");
      assert.strictEqual(isWithinLastDays(old, 7), false);
    });
  });

  describe("isWithinLastHours", () => {
    it("should return true for recent hours", () => {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      assert.strictEqual(isWithinLastHours(oneHourAgo, 2), true);
    });

    it("should return false for hours beyond limit", () => {
      const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
      assert.strictEqual(isWithinLastHours(fiveHoursAgo, 2), false);
    });
  });

  describe("safeJsonParse", () => {
    it("should parse valid JSON", () => {
      const result = safeJsonParse('{"key": "value"}', {});
      assert.deepStrictEqual(result, { key: "value" });
    });

    it("should return default for invalid JSON", () => {
      const defaultValue = { default: true };
      const result = safeJsonParse("invalid", defaultValue);
      assert.deepStrictEqual(result, defaultValue);
    });

    it("should return default for null/empty", () => {
      assert.deepStrictEqual(safeJsonParse(null, {}), {});
      assert.deepStrictEqual(safeJsonParse("", {}), {});
    });
  });

  describe("compareDatesDesc", () => {
    it("should sort dates descending", () => {
      const date1 = new Date("2024-01-15");
      const date2 = new Date("2024-01-10");
      assert.ok(compareDatesDesc(date1, date2) < 0);
      assert.ok(compareDatesDesc(date2, date1) > 0);
    });
  });

  describe("compareDatesAsc", () => {
    it("should sort dates ascending", () => {
      const date1 = new Date("2024-01-10");
      const date2 = new Date("2024-01-15");
      assert.ok(compareDatesAsc(date1, date2) < 0);
      assert.ok(compareDatesAsc(date2, date1) > 0);
    });
  });
});

// ============================================================================
// utils Tests
// ============================================================================

describe("utils", () => {
  describe("chunkArray", () => {
    it("should split array into chunks", () => {
      const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const chunks = chunkArray(arr, 3);
      assert.strictEqual(chunks.length, 4);
      assert.deepStrictEqual(chunks[0], [1, 2, 3]);
      assert.deepStrictEqual(chunks[1], [4, 5, 6]);
      assert.deepStrictEqual(chunks[3], [10]);
    });

    it("should handle empty array", () => {
      assert.deepStrictEqual(chunkArray([], 3), []);
    });

    it("should handle chunk size larger than array", () => {
      const arr = [1, 2];
      const chunks = chunkArray(arr, 10);
      assert.strictEqual(chunks.length, 1);
      assert.deepStrictEqual(chunks[0], [1, 2]);
    });
  });

  describe("unique", () => {
    it("should remove duplicate values", () => {
      const arr = [1, 2, 2, 3, 3, 3, 4];
      assert.deepStrictEqual(unique(arr), [1, 2, 3, 4]);
    });

    it("should handle string duplicates", () => {
      const arr = ["a", "b", "b", "c"];
      assert.deepStrictEqual(unique(arr), ["a", "b", "c"]);
    });
  });

  describe("uniqueBy", () => {
    it("should remove duplicates by key", () => {
      const arr = [
        { id: 1, name: "a" },
        { id: 2, name: "b" },
        { id: 1, name: "c" },
      ];
      const result = uniqueBy(arr, "id");
      assert.strictEqual(result.length, 2);
    });
  });

  describe("groupByKey", () => {
    it("should group by key", () => {
      const arr = [
        { type: "A", value: 1 },
        { type: "B", value: 2 },
        { type: "A", value: 3 },
      ];
      const grouped = groupByKey(arr, "type");
      assert.strictEqual(Object.keys(grouped).length, 2);
      assert.strictEqual(grouped.A.length, 2);
      assert.strictEqual(grouped.B.length, 1);
    });
  });

  describe("sortByKey", () => {
    it("should sort by key ascending", () => {
      const arr = [{ age: 30 }, { age: 20 }, { age: 40 }];
      const sorted = sortByKey(arr, "age");
      assert.strictEqual(sorted[0].age, 20);
      assert.strictEqual(sorted[2].age, 40);
    });
  });

  describe("filterArray", () => {
    it("should filter by predicate", () => {
      const arr = [1, 2, 3, 4, 5];
      const filtered = filterArray(arr, (x) => x > 3);
      assert.deepStrictEqual(filtered, [4, 5]);
    });
  });

  describe("compactArray", () => {
    it("should remove falsy values", () => {
      const arr = [1, 0, "", null, undefined, false, 2];
      assert.deepStrictEqual(compactArray(arr), [1, 2]);
    });
  });

  describe("deepClone", () => {
    it("should deep clone object", () => {
      const obj = { a: 1, b: { c: 2 } };
      const cloned = deepClone(obj);
      assert.deepStrictEqual(cloned, obj);
      assert.notStrictEqual(cloned, obj);
      assert.notStrictEqual(cloned.b, obj.b);
    });
  });

  describe("deepMerge", () => {
    it("should merge objects deeply", () => {
      const target = { a: 1, b: { c: 2 } };
      const source = { b: { d: 3 }, e: 4 };
      const merged = deepMerge(target, source);
      assert.strictEqual(merged.a, 1);
      assert.strictEqual(merged.b.c, 2);
      assert.strictEqual(merged.b.d, 3);
      assert.strictEqual(merged.e, 4);
    });
  });

  describe("getValue", () => {
    it("should get nested value", () => {
      const obj = { a: { b: { c: 42 } } };
      assert.strictEqual(getValue(obj, "a.b.c"), 42);
      assert.strictEqual(getValue(obj, "a.b.d", "default"), "default");
    });
  });

  describe("sleep", () => {
    it("should resolve after delay", async () => {
      const start = Date.now();
      await sleep(50);
      const elapsed = Date.now() - start;
      assert.ok(elapsed >= 40); // Allow small margin
    });
  });

  describe("withTimeout", () => {
    it("should resolve if promise completes in time", async () => {
      const result = await withTimeout(
        Promise.resolve("success"),
        1000,
        "timeout",
      );
      assert.strictEqual(result, "success");
    });

    it("should reject if promise times out", async () => {
      await assert.rejects(
        withTimeout(sleep(2000), 100, "operation timed out"),
        { message: "operation timed out" },
      );
    });
  });

  describe("retryAsync", () => {
    it("should succeed on first try", async () => {
      let calls = 0;
      const fn = async () => {
        calls++;
        return "success";
      };
      const result = await retryAsync(fn, { maxAttempts: 3 });
      assert.strictEqual(result, "success");
      assert.strictEqual(calls, 1);
    });

    it("should retry on failure", async () => {
      let calls = 0;
      const fn = async () => {
        calls++;
        if (calls < 3) throw new Error("fail");
        return "success";
      };
      const result = await retryAsync(fn, { maxAttempts: 3, delay: 10 });
      assert.strictEqual(result, "success");
      assert.strictEqual(calls, 3);
    });

    it("should throw after max attempts", async () => {
      const fn = async () => {
        throw new Error("always fails");
      };
      await assert.rejects(retryAsync(fn, { maxAttempts: 2, delay: 10 }));
    });
  });

  describe("memoizeFn", () => {
    it("should cache results", () => {
      let calls = 0;
      const fn = (x) => {
        calls++;
        return x * 2;
      };
      const memoized = memoizeFn(fn);
      assert.strictEqual(memoized(5), 10);
      assert.strictEqual(memoized(5), 10);
      assert.strictEqual(calls, 1);
    });

    it("should handle different arguments", () => {
      let calls = 0;
      const fn = (x) => {
        calls++;
        return x * 2;
      };
      const memoized = memoizeFn(fn);
      memoized(5);
      memoized(10);
      assert.strictEqual(calls, 2);
    });
  });
});
