const test = require("node:test");
const assert = require("node:assert/strict");

test("clampPreviewVadField clamps out-of-range/invalid input to LIMITS", async () => {
  const { clampPreviewVadField, DEFAULT_PREVIEW_VAD_CONFIG } = await import(
    "../../src/helpers/previewVadConfig.js"
  );

  assert.equal(clampPreviewVadField("minSpeechDurationMs", 5), 20);
  assert.equal(clampPreviewVadField("minSpeechDurationMs", 9999), 500);
  assert.equal(clampPreviewVadField("minSpeechDurationMs", "bad"), DEFAULT_PREVIEW_VAD_CONFIG.minSpeechDurationMs);
  assert.equal(clampPreviewVadField("minSpeechDurationMs", null), DEFAULT_PREVIEW_VAD_CONFIG.minSpeechDurationMs);

  assert.equal(clampPreviewVadField("minSilenceDurationMs", 1), 100);
  assert.equal(clampPreviewVadField("minSilenceDurationMs", 9999), 2000);

  assert.equal(clampPreviewVadField("samplesOverlap", -1), 0);
  assert.equal(clampPreviewVadField("samplesOverlap", 5), 0.95);

  assert.equal(clampPreviewVadField("energyThreshold", -1), 0.001);
  assert.equal(clampPreviewVadField("energyThreshold", 10), 0.05);
  assert.equal(
    clampPreviewVadField("energyThreshold", "bad"),
    DEFAULT_PREVIEW_VAD_CONFIG.energyThreshold
  );

  assert.equal(clampPreviewVadField("minSegmentRms", -1), 0.0005);
  assert.equal(clampPreviewVadField("minSegmentRms", 10), 0.05);
  assert.equal(
    clampPreviewVadField("minSegmentRms", null),
    DEFAULT_PREVIEW_VAD_CONFIG.minSegmentRms
  );

  assert.equal(clampPreviewVadField("noiseFloorFactor", 0), 1);
  assert.equal(clampPreviewVadField("noiseFloorFactor", 100), 10);
  assert.equal(
    clampPreviewVadField("noiseFloorFactor", undefined),
    DEFAULT_PREVIEW_VAD_CONFIG.noiseFloorFactor
  );

  assert.equal(clampPreviewVadField("noiseFloorAlpha", -1), 0.01);
  assert.equal(clampPreviewVadField("noiseFloorAlpha", 100), 0.5);
  assert.equal(
    clampPreviewVadField("noiseFloorAlpha", "bad"),
    DEFAULT_PREVIEW_VAD_CONFIG.noiseFloorAlpha
  );

  assert.equal(clampPreviewVadField("maxMerges", -5), 0);
  assert.equal(clampPreviewVadField("maxMerges", 100), 10);
  assert.equal(clampPreviewVadField("maxMerges", null), DEFAULT_PREVIEW_VAD_CONFIG.maxMerges);

  assert.equal(clampPreviewVadField("maxMergedMs", 100), 5000);
  assert.equal(clampPreviewVadField("maxMergedMs", 999999), 60000);
  assert.equal(
    clampPreviewVadField("maxMergedMs", "bad"),
    DEFAULT_PREVIEW_VAD_CONFIG.maxMergedMs
  );

  assert.equal(clampPreviewVadField("speechPadMs", -10), 0);
  assert.equal(clampPreviewVadField("speechPadMs", 99999), 500);

  assert.equal(clampPreviewVadField("maxSpeechDurationS", 0), 5);
  assert.equal(clampPreviewVadField("maxSpeechDurationS", 999), 60);
});

test("migration safety: all newly-exposed defaults exactly match dictationBatchingSession.js's own DEFAULTS constants", async () => {
  const { DEFAULT_PREVIEW_VAD_CONFIG } = await import("../../src/helpers/previewVadConfig.js");
  // Compare against the real, live source-of-truth constants (not hardcoded
  // literals) so this test actually guards against drift between the two
  // namespaces, per CLAUDE.md §6 / Requirement 11's migration-safety bar —
  // dictationBatchingSession.js's DEFAULTS are what today's code silently
  // falls through to for these 6 fields (never passed at all before this
  // spec), so an exact match here is what proves "no behavior change".
  const { DEFAULTS: SESSION_DEFAULTS } = require("../../src/helpers/dictationBatchingSession.js");

  // Sanity-pin the literals too (so this test still fails loudly if
  // dictationBatchingSession.js's own constants are ever changed without a
  // deliberate migration-safety review), then assert the cross-namespace match.
  assert.equal(SESSION_DEFAULTS.energyThreshold, 0.006);
  assert.equal(SESSION_DEFAULTS.minSegmentRms, 0.003);
  assert.equal(SESSION_DEFAULTS.noiseFloorFactor, 3);
  assert.equal(SESSION_DEFAULTS.noiseFloorAlpha, 0.05);
  assert.equal(SESSION_DEFAULTS.maxMerges, 2);
  assert.equal(SESSION_DEFAULTS.maxMergedMs, 20000);

  for (const key of [
    "energyThreshold",
    "minSegmentRms",
    "noiseFloorFactor",
    "noiseFloorAlpha",
    "maxMerges",
    "maxMergedMs",
  ]) {
    assert.equal(
      DEFAULT_PREVIEW_VAD_CONFIG[key],
      SESSION_DEFAULTS[key],
      `previewVad.json's "${key}" default must exactly match dictationBatchingSession.js's own DEFAULTS.${key}`
    );
  }
});

test("sanitizePreviewVadConfig fills missing fields from DEFAULTS", async () => {
  const { sanitizePreviewVadConfig, DEFAULT_PREVIEW_VAD_CONFIG } = await import(
    "../../src/helpers/previewVadConfig.js"
  );

  const cfg = sanitizePreviewVadConfig({ minSpeechDurationMs: 120 });

  assert.equal(cfg.minSpeechDurationMs, 120);
  assert.equal(cfg.minSilenceDurationMs, DEFAULT_PREVIEW_VAD_CONFIG.minSilenceDurationMs);
  assert.equal(cfg.speechPadMs, DEFAULT_PREVIEW_VAD_CONFIG.speechPadMs);
  assert.equal(cfg.maxSpeechDurationS, DEFAULT_PREVIEW_VAD_CONFIG.maxSpeechDurationS);
  assert.equal(cfg.samplesOverlap, DEFAULT_PREVIEW_VAD_CONFIG.samplesOverlap);
});

test("sanitizePreviewVadConfig clamps invalid values instead of passing them through", async () => {
  const { sanitizePreviewVadConfig } = await import("../../src/helpers/previewVadConfig.js");

  const cfg = sanitizePreviewVadConfig({
    minSpeechDurationMs: -50,
    minSilenceDurationMs: "not-a-number",
    speechPadMs: 99999,
    maxSpeechDurationS: 0,
    samplesOverlap: 5,
  });

  assert.equal(cfg.minSpeechDurationMs, 20);
  assert.equal(cfg.minSilenceDurationMs, 500);
  assert.equal(cfg.speechPadMs, 500);
  assert.equal(cfg.maxSpeechDurationS, 5);
  assert.equal(cfg.samplesOverlap, 0.95);
});

test("resolvePreviewVadConfig({}) returns the full default object with the validated experimental values", async () => {
  const { resolvePreviewVadConfig } = await import("../../src/helpers/previewVadConfig.js");

  const cfg = resolvePreviewVadConfig({});

  assert.deepEqual(cfg, {
    minSpeechDurationMs: 80,
    minSilenceDurationMs: 500,
    speechPadMs: 100,
    maxSpeechDurationS: 20,
    samplesOverlap: 0.3,
    energyThreshold: 0.006,
    minSegmentRms: 0.003,
    noiseFloorFactor: 3,
    noiseFloorAlpha: 0.05,
    maxMerges: 2,
    maxMergedMs: 20000,
  });
});

test("resolvePreviewVadConfig honors persisted, valid user-tunable values", async () => {
  const { resolvePreviewVadConfig } = await import("../../src/helpers/previewVadConfig.js");

  const cfg = resolvePreviewVadConfig({
    minSpeechDurationMs: 150,
    minSilenceDurationMs: 700,
  });

  assert.equal(cfg.minSpeechDurationMs, 150);
  assert.equal(cfg.minSilenceDurationMs, 700);
  // Non-user-tunable fields remain the new namespace's own fixed defaults.
  assert.equal(cfg.speechPadMs, 100);
  assert.equal(cfg.maxSpeechDurationS, 20);
  assert.equal(cfg.samplesOverlap, 0.3);
});
