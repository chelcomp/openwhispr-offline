const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/screenContextRetentionSync.js");

// Mirrors test/helpers/audioRetentionSync.test.js exactly, applied to the
// fully independent screenContextRetentionDays setting.
test("never-set-on-main + real renderer preference (30): pushes the renderer's value, does not adopt the 0 fallback", async () => {
  const { resolveScreenContextRetentionStartupSync } = await load();

  const decision = resolveScreenContextRetentionStartupSync({
    hasBeenSetOnMain: false,
    mainValue: 0,
    rendererValue: 30,
  });

  assert.equal(decision.action, "push");
  assert.equal(decision.value, 30, "the real renderer preference must survive, not the 0 fallback");
});

test("never-set-on-main + renderer also at its own 0 default: pushes 0 (a fresh install with no prior preference)", async () => {
  const { resolveScreenContextRetentionStartupSync } = await load();

  const decision = resolveScreenContextRetentionStartupSync({
    hasBeenSetOnMain: false,
    mainValue: 0,
    rendererValue: 0,
  });

  assert.equal(decision.action, "push");
  assert.equal(decision.value, 0);
});

test("already-set-on-main: main's genuinely persisted value wins (renderer pulls and overwrites)", async () => {
  const { resolveScreenContextRetentionStartupSync } = await load();

  const decision = resolveScreenContextRetentionStartupSync({
    hasBeenSetOnMain: true,
    mainValue: 7,
    rendererValue: 30,
  });

  assert.equal(decision.action, "pull");
  assert.equal(decision.value, 7, "main is authoritative once a real value has been persisted");
});

test("already-set-on-main with main's value at 0: still pulls 0 (0 is a valid, previously-confirmed choice once set)", async () => {
  const { resolveScreenContextRetentionStartupSync } = await load();

  const decision = resolveScreenContextRetentionStartupSync({
    hasBeenSetOnMain: true,
    mainValue: 0,
    rendererValue: 30,
  });

  assert.equal(decision.action, "pull");
  assert.equal(decision.value, 0);
});
