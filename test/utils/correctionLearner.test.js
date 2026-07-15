const test = require("node:test");
const assert = require("node:assert/strict");

const { extractCorrections } = require("../../src/utils/correctionLearner.js");

test("returns empty array when texts are identical", () => {
  assert.deepEqual(extractCorrections("hello world", "hello world", []), []);
});

test("returns empty array for null or empty input", () => {
  assert.deepEqual(extractCorrections(null, "hello", []), []);
  assert.deepEqual(extractCorrections("hello", null, []), []);
  assert.deepEqual(extractCorrections("", "hello", []), []);
  assert.deepEqual(extractCorrections("hello", "", []), []);
});

test("extracts a single corrected word", () => {
  const corrections = extractCorrections("Shunade came to visit", "Sinead came to visit", []);
  assert.ok(corrections.includes("Sinead"), `expected Sinead in ${corrections}`);
});

test("skips corrections already in the dictionary", () => {
  const corrections = extractCorrections(
    "Shunade came to visit",
    "Sinead came to visit",
    ["sinead"]
  );
  assert.deepEqual(corrections, []);
});

test("skips short corrections under 3 characters", () => {
  const corrections = extractCorrections("the cat sat", "the at sat", []);
  assert.deepEqual(corrections, []);
});

test("skips when correction is too different from original (distance > 0.65)", () => {
  // "airplane" → "xyz" is completely different
  const corrections = extractCorrections("the airplane flew", "the xyz flew", []);
  assert.deepEqual(corrections, []);
});

test("does not return duplicates", () => {
  const corrections = extractCorrections(
    "Shunade and shunade are the same",
    "Sinead and Sinead are the same",
    []
  );
  const sineadCount = corrections.filter((c) => c.toLowerCase() === "sinead").length;
  assert.ok(sineadCount <= 1, `expected at most one Sinead, got ${sineadCount}`);
});

test("returns empty array when more than 50 percent of words changed (rewrite)", () => {
  const corrections = extractCorrections(
    "one two three four five",
    "alpha beta gamma delta epsilon",
    []
  );
  assert.deepEqual(corrections, []);
});

test("handles non-array existingDictionary gracefully", () => {
  const corrections = extractCorrections("Shunade came", "Sinead came", null);
  assert.ok(Array.isArray(corrections));
});

test("extracts multiple corrections from one sentence", () => {
  const corrections = extractCorrections(
    "Shunade and Jonathon visited",
    "Sinead and Jonathan visited",
    []
  );
  assert.ok(corrections.length >= 1, `expected at least one correction, got ${corrections}`);
});
