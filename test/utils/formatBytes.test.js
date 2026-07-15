const test = require("node:test");
const assert = require("node:assert/strict");

const { formatBytes } = require("../../src/utils/formatBytes.ts");

test("zero bytes returns '0 Bytes'", () => {
  assert.equal(formatBytes(0), "0 Bytes");
});

test("exactly 1 KB", () => {
  assert.equal(formatBytes(1024), "1 KB");
});

test("exactly 1 MB", () => {
  assert.equal(formatBytes(1024 * 1024), "1 MB");
});

test("exactly 1 GB", () => {
  assert.equal(formatBytes(1024 * 1024 * 1024), "1 GB");
});

test("1500 bytes with default 2 decimals", () => {
  assert.equal(formatBytes(1500), "1.46 KB");
});

test("1500 bytes with 0 decimals", () => {
  assert.equal(formatBytes(1500, 0), "1 KB");
});

test("negative decimals treated as 0", () => {
  assert.equal(formatBytes(1024, -1), "1 KB");
});

test("single byte", () => {
  assert.equal(formatBytes(1), "1 Bytes");
});

test("1023 bytes", () => {
  assert.equal(formatBytes(1023), "1023 Bytes");
});
