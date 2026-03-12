import test from "node:test";
import assert from "node:assert/strict";
import { getChapterNumber } from "../lib/domain/manga.js";

test("resync chapter ordering should be ascending by chapter number", () => {
  const matched = [
    { title: "The Emperor's Sword", chapter: "Chapter 89" },
    { title: "The Emperor's Sword", chapter: "Chapter 82" },
    { title: "The Emperor's Sword", chapter: "Chapter 87" },
    { title: "The Emperor's Sword", chapter: "Chapter 83" },
  ];

  const sorted = [...matched].sort(
    (a, b) => getChapterNumber(a.chapter) - getChapterNumber(b.chapter),
  );

  assert.deepEqual(
    sorted.map((item) => item.chapter),
    ["Chapter 82", "Chapter 83", "Chapter 87", "Chapter 89"],
  );
});
