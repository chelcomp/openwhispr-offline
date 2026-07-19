const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/audioRetentionSync.js");

// This is the regression coverage for the "existing user upgrading" bug: main
// has never persisted AUDIO_RETENTION_DAYS, but the renderer already has a
// real, previously-chosen non-zero value (e.g. from before this main-process
// setting ever existed). The renderer's value must win and get pushed to
// main — main's 0 fallback must NOT clobber it.
test("never-set-on-main + real renderer preference (30): pushes the renderer's value, does not adopt the 0 fallback", async () => {
  const { resolveAudioRetentionStartupSync } = await load();

  const decision = resolveAudioRetentionStartupSync({
    hasBeenSetOnMain: false,
    mainValue: 0,
    rendererValue: 30,
  });

  assert.equal(decision.action, "push");
  assert.equal(decision.value, 30, "the real renderer preference must survive, not the 0 fallback");
});

test("never-set-on-main + renderer also at its own 0 default: pushes 0 (a fresh install with no prior preference)", async () => {
  const { resolveAudioRetentionStartupSync } = await load();

  const decision = resolveAudioRetentionStartupSync({
    hasBeenSetOnMain: false,
    mainValue: 0,
    rendererValue: 0,
  });

  assert.equal(decision.action, "push");
  assert.equal(decision.value, 0);
});

test("already-set-on-main: main's genuinely persisted value wins (renderer pulls and overwrites)", async () => {
  const { resolveAudioRetentionStartupSync } = await load();

  const decision = resolveAudioRetentionStartupSync({
    hasBeenSetOnMain: true,
    mainValue: 7,
    rendererValue: 30,
  });

  assert.equal(decision.action, "pull");
  assert.equal(decision.value, 7, "main is authoritative once a real value has been persisted");
});

test("already-set-on-main with main's value at 0: still pulls 0 (0 is a valid, previously-confirmed choice once set)", async () => {
  const { resolveAudioRetentionStartupSync } = await load();

  const decision = resolveAudioRetentionStartupSync({
    hasBeenSetOnMain: true,
    mainValue: 0,
    rendererValue: 30,
  });

  assert.equal(decision.action, "pull");
  assert.equal(decision.value, 0);
});
