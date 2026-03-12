import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSourceCompareState,
  getSourceCompareHeadSignature,
} from "../lib/sourceCompareState.js";

test("getSourceCompareHeadSignature changes when recent head changes", () => {
  const entries = [
    {
      title: "A",
      chapter: "Chapter 1",
      source: "ikiru",
      url: "https://02.ikiru.wtf/manga/a/chapter-1",
      sentAt: "2026-03-12T00:00:00.000Z",
    },
    {
      title: "B",
      chapter: "Chapter 2",
      source: "shinigami_project",
      url: "https://a.shinigami.asia/chapter/2",
      sentAt: "2026-03-12T00:01:00.000Z",
    },
  ];

  const base = getSourceCompareHeadSignature(entries);
  const changed = getSourceCompareHeadSignature([
    { ...entries[0], sentAt: "2026-03-12T00:02:00.000Z" },
    entries[1],
  ]);

  assert.notEqual(base, changed);
});

test("buildSourceCompareState includes payload and head signature", () => {
  const entries = [
    {
      title: "Return of the Devourer",
      chapter: "Chapter 18",
      source: "ikiru",
      url: "https://02.ikiru.wtf/manga/devourer/chapter-18",
      sentAt: "2026-03-12T00:00:00.000Z",
      updatedTime: "2026-03-11T23:59:00.000Z",
    },
    {
      title: "Return of the Devourer",
      chapter: "Chapter 18",
      source: "shinigami_mirror",
      url: "https://a.shinigami.asia/chapter/18",
      sentAt: "2026-03-12T00:03:00.000Z",
      updatedTime: "2026-03-12T00:01:00.000Z",
    },
  ];

  const state = buildSourceCompareState(entries);

  assert.equal(state.recentCount, 2);
  assert.equal(state.headSignature, getSourceCompareHeadSignature(entries));
  assert.equal(state.payload.summary.totalCompared, 1);
});
