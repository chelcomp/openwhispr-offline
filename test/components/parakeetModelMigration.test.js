// Component-level test for the renderer half of the removed-Parakeet-model
// migration (see docs/specs/audio-transcription-batching.md Design §13 and
// Requirement 10). Run via:
//   node --test --import ./test/setup/tsxRegister.js test/components/*.test.js
// (happy-dom provides `window`/`localStorage` for this runner only.)

const test = require("node:test");
const assert = require("node:assert/strict");

test("meetingParakeetModel is migrated off a removed runtime:online model ID on store load", () => {
  localStorage.setItem("meetingParakeetModel", "nemotron-3.5-asr-streaming-0.6b");
  localStorage.setItem("uploadParakeetModel", "nemotron-speech-streaming-en-0.6b");
  localStorage.setItem("parakeetModel", "parakeet-tdt-0.6b-v3");

  delete require.cache[require.resolve("../../src/stores/settingsStore.ts")];
  require("../../src/stores/settingsStore.ts");

  assert.equal(localStorage.getItem("meetingParakeetModel"), "parakeet-tdt-0.6b-v3");
  assert.equal(localStorage.getItem("uploadParakeetModel"), "parakeet-tdt-0.6b-v3");
  // Already-valid model IDs are left untouched.
  assert.equal(localStorage.getItem("parakeetModel"), "parakeet-tdt-0.6b-v3");

  localStorage.removeItem("meetingParakeetModel");
  localStorage.removeItem("uploadParakeetModel");
  localStorage.removeItem("parakeetModel");
});
