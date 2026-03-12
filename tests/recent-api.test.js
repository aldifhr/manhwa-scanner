import test from "node:test";
import assert from "node:assert/strict";
import { sortRecentItems } from "../api/recent.js";

test("sortRecentItems uses sentOrder to stabilize same-batch ordering", () => {
  const sentAt = "2026-03-12T12:00:00.000Z";
  const out = sortRecentItems([
    { title: "The Emperor's Sword", chapter: "Chapter 89", sentAt, sentOrder: 7 },
    { title: "The Emperor's Sword", chapter: "Chapter 83", sentAt, sentOrder: 1 },
    { title: "The Emperor's Sword", chapter: "Chapter 82", sentAt, sentOrder: 0 },
    { title: "The Emperor's Sword", chapter: "Chapter 88", sentAt, sentOrder: 6 },
  ]);

  assert.deepEqual(
    out.map((item) => item.chapter),
    ["Chapter 82", "Chapter 83", "Chapter 88", "Chapter 89"],
  );
});
