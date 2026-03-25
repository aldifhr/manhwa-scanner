import test from "node:test";
import assert from "node:assert/strict";
import {
  formatMarkedTitle,
  buildAddSuccessMessage,
  buildAddExistsMessage,
} from "../lib/services/whitelistUi.js";

// --- formatMarkedTitle ---

test("formatMarkedTitle returns plain title when no mark", () => {
  assert.equal(formatMarkedTitle({ title: "Solo Leveling" }), "Solo Leveling");
  assert.equal(formatMarkedTitle({ title: "Naruto", mark: null }), "Naruto");
});

test("formatMarkedTitle appends label for valid mark on item", () => {
  assert.equal(
    formatMarkedTitle({ title: "Solo Leveling", mark: "hiatus" }),
    "Solo Leveling [Hiatus]",
  );
  assert.equal(
    formatMarkedTitle({ title: "One Piece", mark: "end" }),
    "One Piece [End]",
  );
});

test("formatMarkedTitle reads mark from first source if item.mark is absent", () => {
  const item = {
    title: "Bleach",
    sources: [{ source: "ikiru", mark: "end_season" }],
  };
  assert.equal(formatMarkedTitle(item), "Bleach [End Season]");
});

test("formatMarkedTitle ignores invalid mark values", () => {
  assert.equal(
    formatMarkedTitle({ title: "Test", mark: "garbage" }),
    "Test",
  );
});

test("formatMarkedTitle handles empty/undefined input", () => {
  assert.equal(formatMarkedTitle({}), "");
  assert.equal(formatMarkedTitle(null), "");
  assert.equal(formatMarkedTitle(undefined), "");
});

// --- buildAddSuccessMessage ---

test("buildAddSuccessMessage formats correctly", () => {
  const msg = buildAddSuccessMessage({
    title: "Solo Leveling",
    source: "ikiru",
    total: 42,
  });
  assert.ok(msg.includes("Solo Leveling"));
  assert.ok(msg.includes("Ikiru"));
  assert.ok(msg.includes("42"));
});

test("buildAddSuccessMessage handles shinigami source", () => {
  const msg = buildAddSuccessMessage({
    title: "Lookism",
    source: "shinigami_project",
    total: 10,
  });
  assert.ok(msg.includes("Shinigami (Project)"));
});

// --- buildAddExistsMessage ---

test("buildAddExistsMessage formats correctly", () => {
  const msg = buildAddExistsMessage({
    title: "One Piece",
    source: "ikiru",
  });
  assert.ok(msg.includes("One Piece"));
  assert.ok(msg.includes("already exists"));
  assert.ok(msg.includes("Ikiru"));
});
