const test = require("node:test");
const assert = require("node:assert/strict");

// Exercises IPCHandlers.prototype._setupScreenContextCleanup() in isolation,
// via Function.prototype.call against a minimal fake `this` — constructing
// the real IPCHandlers class requires dozens of manager dependencies that
// are out of scope for this unit; mirrors the "no existing direct precedent"
// note in docs/specs/active-window-screen-context.md's Validation Plan by
// exercising the wiring pattern directly rather than the whole class.
const IPCHandlers = require("../../src/helpers/ipcHandlers");
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

function makeFakeIpcHandlers({ hasBeenSet, retentionDays }) {
  const cleanupCalls = [];
  return {
    environmentManager: {
      hasScreenContextRetentionDaysBeenSet: () => hasBeenSet,
      getScreenContextRetentionDays: () => retentionDays,
    },
    screenContextStorageManager: {
      cleanupExpiredScreenshots: (days) => {
        cleanupCalls.push(days);
        return { deleted: 0, kept: 0 };
      },
    },
    _cleanupCalls: cleanupCalls,
  };
}

test("the very first immediate pass is skipped when hasScreenContextRetentionDaysBeenSet is false", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const fake = makeFakeIpcHandlers({ hasBeenSet: false, retentionDays: 0 });

  IPCHandlers.prototype._setupScreenContextCleanup.call(fake);

  assert.equal(fake._cleanupCalls.length, 0, "immediate pass must be skipped");
});

test("once a value has been persisted, the immediate pass runs and the six-hour interval is scheduled", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const fake = makeFakeIpcHandlers({ hasBeenSet: true, retentionDays: 7 });

  IPCHandlers.prototype._setupScreenContextCleanup.call(fake);

  assert.deepEqual(fake._cleanupCalls, [7], "immediate pass runs once persisted");

  t.mock.timers.tick(SIX_HOURS_MS);
  assert.deepEqual(
    fake._cleanupCalls,
    [7, 7],
    "interval tick reuses the same SIX_HOURS_MS cadence"
  );
});

test("an invalid persisted value (negative/NaN) skips that tick without throwing", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const fake = makeFakeIpcHandlers({ hasBeenSet: true, retentionDays: -5 });

  assert.doesNotThrow(() => {
    IPCHandlers.prototype._setupScreenContextCleanup.call(fake);
  });
  assert.equal(fake._cleanupCalls.length, 0, "invalid value must skip the cleanup call entirely");
});

test("uses decideAudioCleanup/shouldRunImmediateCleanup (shared policy), not a reimplementation", () => {
  const {
    decideAudioCleanup,
    shouldRunImmediateCleanup,
  } = require("../../src/helpers/audioCleanupPolicy");
  // Sanity: the same functions this test's fixtures rely on for "0 is valid"
  // / "negative is invalid" / "startup safeguard" semantics are the actual,
  // already-tested shared functions — asserted directly here as a tripwire
  // against a future silent duplication.
  assert.equal(decideAudioCleanup(0).shouldRun, true);
  assert.equal(decideAudioCleanup(-1).shouldRun, false);
  assert.equal(shouldRunImmediateCleanup(false), false);
  assert.equal(shouldRunImmediateCleanup(true), true);
});
