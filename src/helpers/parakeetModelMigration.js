// Parakeet models removed from the product per the audio-transcription-batching
// spec's Option A decision (2026-07-20): these three `runtime: "online"` model
// IDs have no offline/batch sherpa-onnx execution path and were dropped entirely
// (see docs/specs/audio-transcription-batching.md Design §13). Any user who was
// persisted on one of these IDs — either the main process's PARAKEET_MODEL .env
// value (environment.js) or the renderer's parakeetModel/meetingParakeetModel/
// uploadParakeetModel localStorage keys (settingsStore.ts) — is migrated forward
// to DEFAULT_PARAKEET_MODEL_ID on every launch (idempotent, no sentinel needed:
// a simple array-membership rewrite has no drift risk from being re-checked).
export const REMOVED_PARAKEET_MODEL_IDS = [
  "nemotron-speech-streaming-en-0.6b",
  "nemotron-3.5-asr-streaming-0.6b",
  "nemotron-3.5-asr-streaming-0.6b-1120ms",
];

export const DEFAULT_PARAKEET_MODEL_ID = "parakeet-tdt-0.6b-v3";

// Pure function: returns the migrated model ID if `modelId` matches one of the
// removed IDs, otherwise returns `modelId` unchanged (including falsy/empty
// values, which are left alone — there is nothing to migrate).
export function resolveMigratedParakeetModelId(modelId) {
  if (modelId && REMOVED_PARAKEET_MODEL_IDS.includes(modelId)) {
    return DEFAULT_PARAKEET_MODEL_ID;
  }
  return modelId;
}
