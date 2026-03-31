import test from "node:test";
import assert from "node:assert/strict";
import {
  ensureAddAllowedResponse,
  isAddAllowedUser,
  isGuildAdmin,
} from "../lib/permissions.js";

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

test("isAddAllowedUser accepts configured allowlist IDs", async () => {
  assert.equal(
    await isAddAllowedUser({ member: { user: { id: "451393015798300683" } } }),
    true,
  );
  assert.equal(
    await isAddAllowedUser({ user: { id: "536168856339611648" } }),
    true,
  );
  assert.equal(
    await isAddAllowedUser({ member: { user: { id: "758889693235904522" } } }),
    true,
  );
});

test("ensureAddAllowedResponse rejects users outside add allowlist", async () => {
  assert.deepEqual(await ensureAddAllowedResponse({
    member: { user: { id: "123" } },
  }), {
    type: 4,
    data: {
      content: "Command `/add` hanya diizinkan untuk user tertentu.",
      flags: 64,
    },
  });
});
