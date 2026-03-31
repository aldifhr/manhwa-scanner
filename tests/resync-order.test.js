import test from "node:test";
import assert from "node:assert/strict";
import { sortResyncMatchedChapters } from "../lib/commands/resync24h.js";

test("resync chapter ordering should stay ascending within one title", () => {
  const matched = [
    { title: "The Emperor's Sword", chapter: "Chapter 89", source: "ikiru" },
    { title: "The Emperor's Sword", chapter: "Chapter 82", source: "ikiru" },
    { title: "The Emperor's Sword", chapter: "Chapter 87", source: "ikiru" },
    { title: "The Emperor's Sword", chapter: "Chapter 83", source: "ikiru" },
  ];

  const sorted = sortResyncMatchedChapters(matched);

  assert.deepEqual(
    sorted.map((item) => item.chapter),
    ["Chapter 82", "Chapter 83", "Chapter 87", "Chapter 89"],
  );
});

test("resync chapter ordering should preserve title groups while sorting within each title", () => {
  const matched = [
    { title: "The Emperor's Sword", chapter: "Chapter 89", source: "ikiru" },
    { title: "The Emperor's Sword", chapter: "Chapter 82", source: "ikiru" },
    { title: "Kidnapped Dragons", chapter: "Chapter 34", source: "ikiru" },
    { title: "Kidnapped Dragons", chapter: "Chapter 33", source: "ikiru" },
  ];

  const sorted = sortResyncMatchedChapters(matched);

  assert.deepEqual(
    sorted.map((item) => `${item.title} ${item.chapter}`),
    [
      "Kidnapped Dragons Chapter 33",
      "Kidnapped Dragons Chapter 34",
      "The Emperor's Sword Chapter 82",
      "The Emperor's Sword Chapter 89",
    ],
  );
});
