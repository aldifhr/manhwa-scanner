import test from "node:test";
import assert from "node:assert/strict";
import {
  MARK_REASON_LABELS,
  normalizeMarkReason,
  normalizeWhitelist,
} from "../lib/domain/whitelist.js";

// --- normalizeMarkReason ---

test("normalizeMarkReason returns key for valid reasons", () => {
  assert.equal(normalizeMarkReason("hiatus"), "hiatus");
  assert.equal(normalizeMarkReason("end_season"), "end_season");
  assert.equal(normalizeMarkReason("end"), "end");
});

test("normalizeMarkReason handles mixed casing and spacing", () => {
  assert.equal(normalizeMarkReason("End Season"), "end_season");
  assert.equal(normalizeMarkReason("HIATUS"), "hiatus");
  assert.equal(normalizeMarkReason("  END  "), "end");
});

test("normalizeMarkReason returns null for clear/none/unknown", () => {
  assert.equal(normalizeMarkReason("clear"), null);
  assert.equal(normalizeMarkReason("none"), null);
  assert.equal(normalizeMarkReason("unknown_value"), null);
  assert.equal(normalizeMarkReason(""), null);
  assert.equal(normalizeMarkReason(null), null);
  assert.equal(normalizeMarkReason(undefined), null);
});

// --- MARK_REASON_LABELS ---

test("MARK_REASON_LABELS is frozen and contains expected keys", () => {
  assert.ok(Object.isFrozen(MARK_REASON_LABELS));
  assert.equal(MARK_REASON_LABELS.hiatus, "Hiatus");
  assert.equal(MARK_REASON_LABELS.end_season, "End Season");
  assert.equal(MARK_REASON_LABELS.end, "End");
});

// --- normalizeWhitelist ---

test("normalizeWhitelist returns empty array for non-array input", () => {
  assert.deepEqual(normalizeWhitelist(null), []);
  assert.deepEqual(normalizeWhitelist(undefined), []);
  assert.deepEqual(normalizeWhitelist("string"), []);
  assert.deepEqual(normalizeWhitelist(42), []);
});

test("normalizeWhitelist skips items without title", () => {
  const result = normalizeWhitelist([
    { title: "", sources: [] },
    { sources: [{ url: "http://x.com", source: "ikiru" }] },
    { title: null },
  ]);
  assert.equal(result.length, 0);
});

test("normalizeWhitelist normalizes sources correctly", () => {
  const result = normalizeWhitelist([
    {
      title: "Solo Leveling",
      sources: [
        { url: "https://02.ikiru.wtf/manga/solo-leveling/", source: "ikiru", mark: "hiatus" },
        { url: "https://a.shinigami.asia/series/solo", source: "shinigami", mark: null },
      ],
    },
  ]);

  assert.equal(result.length, 1);
  assert.equal(result[0].title, "Solo Leveling");
  assert.equal(result[0].sources.length, 2);
  assert.equal(result[0].sources[0].source, "ikiru");
  assert.equal(result[0].sources[0].mark, "hiatus");
  assert.equal(result[0].sources[1].source, "shinigami_project");
  assert.equal(result[0].sources[1].mark, null);
});

test("normalizeWhitelist deduplicates by normalized title key", () => {
  const result = normalizeWhitelist([
    {
      title: "One Piece",
      sources: [{ url: "http://a.com", source: "ikiru", mark: null }],
    },
    {
      title: "one piece",
      sources: [{ url: "http://b.com", source: "shinigami", mark: null }],
    },
  ]);

  assert.equal(result.length, 1);
  assert.equal(result[0].title, "One Piece");
  assert.equal(result[0].sources.length, 2);
});

test("normalizeWhitelist does not add duplicate source entries during merge", () => {
  const result = normalizeWhitelist([
    {
      title: "Naruto",
      sources: [{ url: "http://a.com", source: "ikiru", mark: null }],
    },
    {
      title: "naruto",
      sources: [{ url: "http://a.com", source: "ikiru", mark: null }],
    },
  ]);

  assert.equal(result.length, 1);
  assert.equal(result[0].sources.length, 1);
});

test("normalizeWhitelist handles items with no sources array", () => {
  const result = normalizeWhitelist([
    { title: "Bleach" },
  ]);

  assert.equal(result.length, 1);
  assert.deepEqual(result[0].sources, []);
});

test("normalizeWhitelist normalizes mark reasons in sources", () => {
  const result = normalizeWhitelist([
    {
      title: "Test Manga",
      sources: [
        { url: "http://x.com", source: "ikiru", mark: "End Season" },
        { url: "http://y.com", source: "mirror", mark: "garbage" },
      ],
    },
  ]);

  assert.equal(result[0].sources[0].mark, "end_season");
  assert.equal(result[0].sources[1].mark, null);
});
