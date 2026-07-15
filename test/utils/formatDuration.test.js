const test = require("node:test");
const assert = require("node:assert/strict");

const { formatMmSs } = require("../../src/utils/formatDuration.ts");

test("zero seconds", () => {
  assert.equal(formatMmSs(0), "00:00");
});

test("one minute thirty seconds", () => {
  assert.equal(formatMmSs(90), "01:30");
});

test("exactly one hour", () => {
  assert.equal(formatMmSs(3600), "60:00");
});

test("59 seconds", () => {
  assert.equal(formatMmSs(59), "00:59");
});

test("floors fractional seconds", () => {
  assert.equal(formatMmSs(59.9), "00:59");
});

test("61 minutes 1 second", () => {
  assert.equal(formatMmSs(3661), "61:01");
});

test("single digit minute and second padded", () => {
  assert.equal(formatMmSs(65), "01:05");
});

test("10 minutes exactly", () => {
  assert.equal(formatMmSs(600), "10:00");
});
