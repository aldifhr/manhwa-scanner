import test from "node:test";
import assert from "node:assert/strict";
import { isGuildAdmin } from "../lib/permissions.js";

test("isGuildAdmin accepts administrator permission", () => {
  assert.equal(isGuildAdmin({ member: { permissions: "8" } }), true);
});

test("isGuildAdmin accepts manage guild permission", () => {
  assert.equal(isGuildAdmin({ member: { permissions: "32" } }), true);
});

test("isGuildAdmin rejects regular member permissions", () => {
  assert.equal(isGuildAdmin({ member: { permissions: "1024" } }), false);
  assert.equal(isGuildAdmin({ member: {} }), false);
});
