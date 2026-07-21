const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/modelIdleTimeoutSync.js");

// --- resolveModelIdleTimeoutMs: bounds clamping -----------------------------
// Run against both "transcriptionIdleTimeoutMs-style" and "llmIdleTimeoutMs-style"
// inputs, since it's one shared function used by both settings.

test("resolveModelIdleTimeoutMs clamps a value below the 30s minimum up to the minimum", async () => {
  const { resolveModelIdleTimeoutMs, MIN_MODEL_IDLE_TIMEOUT_MS } = await load();
  assert.equal(resolveModelIdleTimeoutMs(1000), MIN_MODEL_IDLE_TIMEOUT_MS);
  assert.equal(resolveModelIdleTimeoutMs(0), MIN_MODEL_IDLE_TIMEOUT_MS);
  assert.equal(resolveModelIdleTimeoutMs(-5000), MIN_MODEL_IDLE_TIMEOUT_MS);
});

test("resolveModelIdleTimeoutMs clamps a value above the 60min maximum down to the maximum", async () => {
  const { resolveModelIdleTimeoutMs, MAX_MODEL_IDLE_TIMEOUT_MS } = await load();
  assert.equal(resolveModelIdleTimeoutMs(999 * 60 * 1000), MAX_MODEL_IDLE_TIMEOUT_MS);
});

test("resolveModelIdleTimeoutMs passes valid in-bounds values through unchanged", async () => {
  const { resolveModelIdleTimeoutMs } = await load();
  assert.equal(resolveModelIdleTimeoutMs(45000), 45000);
  assert.equal(resolveModelIdleTimeoutMs(300000), 300000);
  assert.equal(resolveModelIdleTimeoutMs(30 * 1000), 30000);
  assert.equal(resolveModelIdleTimeoutMs(60 * 60 * 1000), 3600000);
});

test("resolveModelIdleTimeoutMs falls back to the 5-minute default for non-finite/invalid input", async () => {
  const { resolveModelIdleTimeoutMs, DEFAULT_MODEL_IDLE_TIMEOUT_MS } = await load();
  assert.equal(resolveModelIdleTimeoutMs(NaN), DEFAULT_MODEL_IDLE_TIMEOUT_MS);
  assert.equal(resolveModelIdleTimeoutMs(undefined), DEFAULT_MODEL_IDLE_TIMEOUT_MS);
  assert.equal(resolveModelIdleTimeoutMs("not-a-number"), DEFAULT_MODEL_IDLE_TIMEOUT_MS);
});

test("resolveModelIdleTimeoutMs supports an {min, max} override without touching the shared defaults", async () => {
  const { resolveModelIdleTimeoutMs } = await load();
  assert.equal(resolveModelIdleTimeoutMs(1000, { min: 500, max: 2000 }), 1000);
  assert.equal(resolveModelIdleTimeoutMs(100, { min: 500, max: 2000 }), 500);
  assert.equal(resolveModelIdleTimeoutMs(5000, { min: 500, max: 2000 }), 2000);
});

// --- resolveModelIdleTimeoutStartupSync: independent per-key sync ----------
// Asserted independently for both "transcriptionIdleTimeoutMs" and
// "llmIdleTimeoutMs"-style calls, including a case proving the two settings
// never cross-contaminate.

test("never-set-on-main + real renderer preference: pushes the renderer's value (transcription key)", async () => {
  const { resolveModelIdleTimeoutStartupSync } = await load();
  const decision = resolveModelIdleTimeoutStartupSync({
    hasBeenSetOnMain: false,
    mainValue: 300000,
    rendererValue: 45000,
  });
  assert.equal(decision.action, "push");
  assert.equal(decision.value, 45000);
});

test("never-set-on-main + real renderer preference: pushes the renderer's value (llm key)", async () => {
  const { resolveModelIdleTimeoutStartupSync } = await load();
  const decision = resolveModelIdleTimeoutStartupSync({
    hasBeenSetOnMain: false,
    mainValue: 300000,
    rendererValue: 120000,
  });
  assert.equal(decision.action, "push");
  assert.equal(decision.value, 120000);
});

test("already-set-on-main: main's genuinely persisted value wins (transcription key)", async () => {
  const { resolveModelIdleTimeoutStartupSync } = await load();
  const decision = resolveModelIdleTimeoutStartupSync({
    hasBeenSetOnMain: true,
    mainValue: 60000,
    rendererValue: 300000,
  });
  assert.equal(decision.action, "pull");
  assert.equal(decision.value, 60000);
});

test("already-set-on-main: main's genuinely persisted value wins (llm key)", async () => {
  const { resolveModelIdleTimeoutStartupSync } = await load();
  const decision = resolveModelIdleTimeoutStartupSync({
    hasBeenSetOnMain: true,
    mainValue: 600000,
    rendererValue: 300000,
  });
  assert.equal(decision.action, "pull");
  // Clamped down to the shared 60-minute ceiling? No — 600000ms (10min) is
  // within bounds, passes through unchanged.
  assert.equal(decision.value, 600000);
});

test("startup sync of one key never affects the other key's resolved value (no cross-contamination)", async () => {
  const { resolveModelIdleTimeoutStartupSync } = await load();

  const transcriptionDecision = resolveModelIdleTimeoutStartupSync({
    hasBeenSetOnMain: true,
    mainValue: 45000,
    rendererValue: 300000,
  });
  const llmDecision = resolveModelIdleTimeoutStartupSync({
    hasBeenSetOnMain: false,
    mainValue: 300000,
    rendererValue: 300000,
  });

  assert.equal(transcriptionDecision.value, 45000);
  assert.equal(llmDecision.value, 300000);
  assert.notEqual(transcriptionDecision.value, llmDecision.value);
});

test("resolveModelIdleTimeoutStartupSync clamps out-of-bounds values from either source", async () => {
  const { resolveModelIdleTimeoutStartupSync, MIN_MODEL_IDLE_TIMEOUT_MS, MAX_MODEL_IDLE_TIMEOUT_MS } =
    await load();

  const belowMin = resolveModelIdleTimeoutStartupSync({
    hasBeenSetOnMain: true,
    mainValue: 1000,
    rendererValue: 300000,
  });
  assert.equal(belowMin.value, MIN_MODEL_IDLE_TIMEOUT_MS);

  const aboveMax = resolveModelIdleTimeoutStartupSync({
    hasBeenSetOnMain: false,
    mainValue: 300000,
    rendererValue: 999 * 60 * 1000,
  });
  assert.equal(aboveMax.value, MAX_MODEL_IDLE_TIMEOUT_MS);
});
