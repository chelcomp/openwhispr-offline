const test = require("node:test");
const assert = require("node:assert/strict");

// Requires Node's native TypeScript type-stripping (Node >= 22.6 with
// --experimental-strip-types, on by default in Node 23.6+/24). CI runs Node 24.

test("formatVersionBadgeLabel: both version and hash present", async () => {
  const { formatVersionBadgeLabel } = await import("../../src/utils/buildInfo.ts");
  assert.equal(formatVersionBadgeLabel("0.0.19", "a1b2c3d"), "v0.0.19 (a1b2c3d)");
});

test("formatVersionBadgeLabel: version missing, real hash present", async () => {
  const { formatVersionBadgeLabel } = await import("../../src/utils/buildInfo.ts");
  assert.equal(formatVersionBadgeLabel(null, "a1b2c3d"), "(a1b2c3d)");
});

test("formatVersionBadgeLabel: hash is 'unknown' placeholder", async () => {
  const { formatVersionBadgeLabel } = await import("../../src/utils/buildInfo.ts");
  assert.equal(formatVersionBadgeLabel("0.0.19", "unknown"), "v0.0.19");
});

test("formatVersionBadgeLabel: hash is 'dev' placeholder", async () => {
  const { formatVersionBadgeLabel } = await import("../../src/utils/buildInfo.ts");
  assert.equal(formatVersionBadgeLabel("0.0.19", "dev"), "v0.0.19");
});

test("formatVersionBadgeLabel: both missing/placeholder returns empty string", async () => {
  const { formatVersionBadgeLabel } = await import("../../src/utils/buildInfo.ts");
  assert.equal(formatVersionBadgeLabel(null, "unknown"), "");
});

test("formatVersionBadgeLabel: defensive against undefined inputs", async () => {
  const { formatVersionBadgeLabel } = await import("../../src/utils/buildInfo.ts");
  assert.equal(formatVersionBadgeLabel(undefined, undefined), "");
});

test("GIT_COMMIT_HASH resolves to 'dev' outside a Vite-defined context", async () => {
  const { GIT_COMMIT_HASH } = await import("../../src/utils/buildInfo.ts");
  assert.equal(GIT_COMMIT_HASH, "dev");
});
