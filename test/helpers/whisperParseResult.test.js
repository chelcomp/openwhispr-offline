const test = require("node:test");
const assert = require("node:assert/strict");

// Regression test for docs/specs/dictation-language-mismatch-retry.md R1:
// parseWhisperResult() must pass through detected_language_probability and
// language_probabilities from the raw whisper-server response, onto
// detectedLanguageProbability/languageProbabilities, without throwing when
// they're absent.

const WhisperManager = require("../../src/helpers/whisper");

test("parseWhisperResult passes through detectedLanguageProbability/languageProbabilities when present", () => {
  const manager = new WhisperManager();
  const fixture = {
    text: "hello world",
    segments: [{ text: "hello world", start: 0, end: 1 }],
    language: "english",
    detected_language: "english",
    detected_language_probability: 0.93,
    language_probabilities: { en: 0.93, pt: 0.02 },
  };

  const out = manager.parseWhisperResult(fixture);

  assert.equal(out.success, true);
  assert.equal(out.text, "hello world");
  assert.equal(out.detectedLanguageProbability, 0.93);
  assert.deepEqual(out.languageProbabilities, { en: 0.93, pt: 0.02 });
});

test("parseWhisperResult degrades gracefully when those fields are absent (non-verbose/older server shape)", () => {
  const manager = new WhisperManager();
  const fixture = {
    text: "hello world",
    segments: [{ text: "hello world", start: 0, end: 1 }],
  };

  const out = manager.parseWhisperResult(fixture);

  assert.equal(out.success, true);
  assert.equal(out.text, "hello world");
  assert.equal(out.detectedLanguageProbability, undefined);
  assert.equal(out.languageProbabilities, undefined);
});

test("parseWhisperResult's text/segments passthrough behavior is unchanged (regression guard)", () => {
  const manager = new WhisperManager();
  const fixture = {
    text: "hello world",
    segments: [{ text: "hello world", start: 0, end: 1, avg_logprob: -0.2 }],
  };

  const out = manager.parseWhisperResult(fixture);

  assert.equal(out.success, true);
  assert.equal(out.text, "hello world");
  assert.deepEqual(out.segments, fixture.segments);
});
