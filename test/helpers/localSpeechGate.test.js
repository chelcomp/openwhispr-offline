const test = require("node:test");
const assert = require("node:assert/strict");

test("fails open when no windows were recorded", async () => {
  const { createLocalSpeechGateState, getLocalSpeechGateDecision } =
    await import("../../src/helpers/localSpeechGate.js");

  assert.deepEqual(getLocalSpeechGateDecision(createLocalSpeechGateState()), {
    skip: false,
    reason: "unavailable",
  });
  assert.deepEqual(getLocalSpeechGateDecision(null), { skip: false, reason: "unavailable" });
});

test("treats near silence as skippable", async () => {
  const { createLocalSpeechGateState, recordLocalSpeechWindow, getLocalSpeechGateDecision } =
    await import("../../src/helpers/localSpeechGate.js");

  const state = createLocalSpeechGateState();
  // All windows sit below SILENCE_RMS_THRESHOLD (0.0008).
  recordLocalSpeechWindow(state, 0.0004, 0.003);
  recordLocalSpeechWindow(state, 0.0006, 0.005);
  recordLocalSpeechWindow(state, 0.0005, 0.004);

  assert.deepEqual(getLocalSpeechGateDecision(state), {
    skip: true,
    reason: "silence",
    peakRms: 0.0006,
    peakAmplitude: 0.005,
    windowCount: 3,
    speechWindowCount: 0,
    maxConsecutiveSpeechWindows: 0,
  });
});

test("rejects isolated noise bursts without sustained speech", async () => {
  const { createLocalSpeechGateState, recordLocalSpeechWindow, getLocalSpeechGateDecision } =
    await import("../../src/helpers/localSpeechGate.js");

  const state = createLocalSpeechGateState();
  // Above SILENCE_RMS_THRESHOLD (0.0008) but below the speech-window
  // thresholds (rms 0.0015 / peak 0.008) and STRONG_SPEECH_RMS_THRESHOLD (0.003).
  recordLocalSpeechWindow(state, 0.001, 0.006);
  recordLocalSpeechWindow(state, 0.0012, 0.007);
  recordLocalSpeechWindow(state, 0.0011, 0.005);

  const decision = getLocalSpeechGateDecision(state);

  assert.equal(decision.skip, true);
  assert.equal(decision.reason, "insufficient_speech");
  assert.equal(decision.peakRms, 0.0012);
  assert.equal(decision.peakAmplitude, 0.007);
  assert.equal(decision.windowCount, 3);
  assert.equal(decision.speechWindowCount, 0);
  assert.equal(decision.maxConsecutiveSpeechWindows, 0);
});

test("allows sustained speech-like energy through", async () => {
  const { createLocalSpeechGateState, recordLocalSpeechWindow, getLocalSpeechGateDecision } =
    await import("../../src/helpers/localSpeechGate.js");

  const state = createLocalSpeechGateState();
  recordLocalSpeechWindow(state, 0.003, 0.025);
  recordLocalSpeechWindow(state, 0.0056, 0.06);
  recordLocalSpeechWindow(state, 0.0061, 0.065);

  assert.deepEqual(getLocalSpeechGateDecision(state), {
    skip: false,
    reason: "speech_detected",
    peakRms: 0.0061,
    peakAmplitude: 0.065,
    windowCount: 3,
    speechWindowCount: 3,
    maxConsecutiveSpeechWindows: 3,
  });
});
