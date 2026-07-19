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
  assert.ok(
    corrections.some((c) => c.to === "Sinead"),
    `expected Sinead in ${JSON.stringify(corrections)}`
  );
});

test("each returned entry carries both the original and corrected word", () => {
  const corrections = extractCorrections("Shunade came to visit", "Sinead came to visit", []);
  const match = corrections.find((c) => c.to === "Sinead");
  assert.ok(match, `expected a Sinead entry in ${JSON.stringify(corrections)}`);
  assert.equal(match.from, "Shunade");
  assert.equal(match.to, "Sinead");
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
  const sineadCount = corrections.filter((c) => c.to.toLowerCase() === "sinead").length;
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
  assert.ok(corrections.length >= 1, `expected at least one correction, got ${JSON.stringify(corrections)}`);
});

test("continued typing after the pasted text is never mistaken for a correction", () => {
  // User pastes text, then keeps typing a brand-new, unrelated sentence after it —
  // the appended content must never be diffed against the original as if it were
  // an edit. Since the field's value starts with the pasted text unchanged,
  // findEditedRegion finds an exact substring match, which extractCorrections()
  // treats as "no correction happened" (editedRegion === originalText).
  const originalText = "Shunade came to visit";
  const fieldValue =
    originalText +
    " and then I kept typing a completely unrelated new sentence about the weather today";
  const corrections = extractCorrections(originalText, fieldValue, []);
  assert.deepEqual(corrections, []);
});

test("finds a correction inside a pasted region that is a small fraction of a much longer field", () => {
  const originalText = "Shunade came to visit today.";
  const preamble =
    "Some long unrelated preamble text goes here to pad out the document with plenty of extra words before the pasted content begins. ";
  const tail =
    " And then a long unrelated trailing section follows with even more extra words to pad the document out considerably further than before.";
  const editedRegion = "Sinead came to visit today.";
  const fieldValue = preamble + editedRegion + tail;

  // Sanity-check the "field is several times longer than the pasted text" premise
  // this test is meant to exercise (findEditedRegion's 1.5x short-circuit).
  assert.ok(fieldValue.length > originalText.length * 3);

  const corrections = extractCorrections(originalText, fieldValue, []);
  const match = corrections.find((c) => c.to === "Sinead");
  assert.ok(match, `expected a Sinead correction in ${JSON.stringify(corrections)}`);
  assert.equal(match.from, "Shunade");
});
