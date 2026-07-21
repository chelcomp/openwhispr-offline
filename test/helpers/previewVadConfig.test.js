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
