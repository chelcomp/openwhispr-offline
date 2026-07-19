const test = require("node:test");
const assert = require("node:assert/strict");

const { decideAudioCleanup, shouldRunImmediateCleanup } = require("../../src/helpers/audioCleanupPolicy");

test("a configured value of 0 is valid and passed through unchanged", () => {
  const decision = decideAudioCleanup(0);
  assert.equal(decision.shouldRun, true);
  assert.equal(decision.retentionDays, 0);
});

test("any finite non-negative value is valid and passed through unchanged", () => {
  for (const days of [1, 7, 14, 30, 60, 90, 0.5, 100000]) {
    const decision = decideAudioCleanup(days);
    assert.equal(decision.shouldRun, true, `${days} should be valid`);
    assert.equal(decision.retentionDays, days);
  }
});

test("a negative value is invalid and cleanup is skipped", () => {
  const decision = decideAudioCleanup(-5);
  assert.equal(decision.shouldRun, false);
  assert.equal(decision.retentionDays, null);
});

test("NaN is invalid and cleanup is skipped", () => {
  const decision = decideAudioCleanup(NaN);
  assert.equal(decision.shouldRun, false);
  assert.equal(decision.retentionDays, null);
});

test("Infinity is invalid and cleanup is skipped", () => {
  const decision = decideAudioCleanup(Infinity);
  assert.equal(decision.shouldRun, false);
  assert.equal(decision.retentionDays, null);
});

test("invalid input is never conflated with the valid 0 case", () => {
  // -0 is === 0 and is a finite, non-negative number under this policy's
  // check — it is not the same failure mode as a genuinely negative or
  // non-finite value, and should still proceed (delete everything).
  const negativeZero = decideAudioCleanup(-0);
  assert.equal(negativeZero.shouldRun, true);

  const invalid = decideAudioCleanup(-1);
  assert.equal(invalid.shouldRun, false);
  assert.notEqual(invalid.retentionDays, 0);
});

// Startup-ordering safeguard (Requirement 6): the very first immediate
// cleanup pass at boot must be skipped only when AUDIO_RETENTION_DAYS has
// never been persisted at all — every other case (including a genuinely
// persisted value of 0) proceeds normally.
test("shouldRunImmediateCleanup: skips the immediate pass when the value has never been persisted", () => {
  assert.equal(shouldRunImmediateCleanup(false), false);
});

test("shouldRunImmediateCleanup: proceeds normally once a value has genuinely been persisted", () => {
  assert.equal(shouldRunImmediateCleanup(true), true);
});
