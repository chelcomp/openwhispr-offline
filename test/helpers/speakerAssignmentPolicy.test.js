const test = require("node:test");
const assert = require("node:assert/strict");

const {
  SPEAKER_STATUS,
  canonicalizeSpeakerStatus,
  isSpeakerLocked,
  canAutoRelabelSpeaker,
  applyProvisionalSpeaker,
  applyConfirmedSpeaker,
  applySuggestedSpeaker,
} = require("../../src/helpers/speakerAssignmentPolicy.js");

// canonicalizeSpeakerStatus

test("canonical statuses pass through unchanged", () => {
  assert.equal(canonicalizeSpeakerStatus("provisional"), SPEAKER_STATUS.PROVISIONAL);
  assert.equal(canonicalizeSpeakerStatus("confirmed"), SPEAKER_STATUS.CONFIRMED);
  assert.equal(canonicalizeSpeakerStatus("suggested"), SPEAKER_STATUS.SUGGESTED);
  assert.equal(canonicalizeSpeakerStatus("locked"), SPEAKER_STATUS.LOCKED);
});

test("user_locked maps to locked", () => {
  assert.equal(canonicalizeSpeakerStatus("user_locked"), SPEAKER_STATUS.LOCKED);
});

test("suggested_profile maps to suggested", () => {
  assert.equal(canonicalizeSpeakerStatus("suggested_profile"), SPEAKER_STATUS.SUGGESTED);
});

test("uncertain_overlap maps to provisional", () => {
  assert.equal(canonicalizeSpeakerStatus("uncertain_overlap"), SPEAKER_STATUS.PROVISIONAL);
});

test("unknown status returns undefined", () => {
  assert.equal(canonicalizeSpeakerStatus("bogus_status"), undefined);
  assert.equal(canonicalizeSpeakerStatus(undefined), undefined);
});

test("segment with speakerLocked=true overrides status to locked", () => {
  assert.equal(
    canonicalizeSpeakerStatus("provisional", { speakerLocked: true }),
    SPEAKER_STATUS.LOCKED
  );
});

test("segment with speakerLockSource=user overrides status to locked", () => {
  assert.equal(
    canonicalizeSpeakerStatus("provisional", { speakerLockSource: "user" }),
    SPEAKER_STATUS.LOCKED
  );
});

// isSpeakerLocked

test("locked segment returns true", () => {
  assert.equal(isSpeakerLocked({ speakerStatus: "locked" }), true);
});

test("locked via speakerLocked flag returns true", () => {
  assert.equal(isSpeakerLocked({ speakerStatus: "provisional", speakerLocked: true }), true);
});

test("provisional segment returns false", () => {
  assert.equal(isSpeakerLocked({ speakerStatus: "provisional" }), false);
});

test("confirmed segment returns false", () => {
  assert.equal(isSpeakerLocked({ speakerStatus: "confirmed" }), false);
});

test("null/undefined segment returns false", () => {
  assert.equal(isSpeakerLocked(null), false);
  assert.equal(isSpeakerLocked(undefined), false);
});

// canAutoRelabelSpeaker

test("locked segment cannot be auto-relabelled", () => {
  assert.equal(canAutoRelabelSpeaker({ speakerStatus: "locked" }), false);
});

test("provisional segment can be auto-relabelled", () => {
  assert.equal(canAutoRelabelSpeaker({ speakerStatus: "provisional" }), true);
});

test("confirmed segment can be auto-relabelled", () => {
  assert.equal(canAutoRelabelSpeaker({ speakerStatus: "confirmed" }), true);
});

// applyProvisionalSpeaker

test("applyProvisionalSpeaker applies patch and sets provisional status", () => {
  const seg = { speakerStatus: "confirmed", speaker: "speaker_0" };
  const result = applyProvisionalSpeaker(seg, { speaker: "speaker_1", speakerName: "Alice" });
  assert.equal(result.speakerStatus, SPEAKER_STATUS.PROVISIONAL);
  assert.equal(result.speaker, "speaker_1");
  assert.equal(result.speakerName, "Alice");
});

test("applyProvisionalSpeaker ignores patch when segment is locked", () => {
  const seg = { speakerStatus: "locked", speakerLocked: true, speaker: "speaker_0" };
  const result = applyProvisionalSpeaker(seg, { speaker: "speaker_1" });
  assert.equal(result.speaker, "speaker_0");
  assert.equal(result.speakerStatus, SPEAKER_STATUS.LOCKED);
});

// applyConfirmedSpeaker

test("applyConfirmedSpeaker applies patch and sets confirmed status", () => {
  const seg = { speakerStatus: "provisional", speaker: "speaker_0" };
  const result = applyConfirmedSpeaker(seg, { speakerName: "Bob" });
  assert.equal(result.speakerStatus, SPEAKER_STATUS.CONFIRMED);
  assert.equal(result.speakerName, "Bob");
});

test("applyConfirmedSpeaker ignores patch when locked", () => {
  const seg = { speakerStatus: "locked", speakerLocked: true, speakerName: "Alice" };
  const result = applyConfirmedSpeaker(seg, { speakerName: "Bob" });
  assert.equal(result.speakerName, "Alice");
});

// applySuggestedSpeaker

test("applySuggestedSpeaker applies patch and sets suggested status", () => {
  const seg = { speakerStatus: "provisional" };
  const result = applySuggestedSpeaker(seg, { suggestedName: "Charlie" });
  assert.equal(result.speakerStatus, SPEAKER_STATUS.SUGGESTED);
  assert.equal(result.suggestedName, "Charlie");
});

test("applySuggestedSpeaker returns segment unchanged when locked", () => {
  const seg = { speakerStatus: "locked", speakerLocked: true, suggestedName: "Original" };
  const result = applySuggestedSpeaker(seg, { suggestedName: "New" });
  assert.equal(result.suggestedName, "Original");
});
