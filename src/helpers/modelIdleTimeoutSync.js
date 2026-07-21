// Pure helpers for the two independent model-idle-timeout settings
// (`transcriptionIdleTimeoutMs` for Whisper/Parakeet, `llmIdleTimeoutMs` for
// llama-server — see docs/specs/on-demand-model-lifecycle.md Design §5).
//
// Mirrors src/helpers/audioRetentionSync.js's "pull main's genuinely-persisted
// value, or push the renderer's own value up to main" startup-sync shape,
// generalized to be called once per setting key (never cross-contaminating
// the other setting's value). Consumed by settingsStore.ts (renderer) for
// both the UI-side clamp and the startup sync; the main-process IPC handlers
// in ipcHandlers.js apply the same bounds via their own small clamp (this
// file uses ESM `export`, so it is not `require()`-able from CJS main-process
// code — the same constraint audioRetentionSync.js already has).

// Both settings share identical bounds today (30s min / 60min max) and the
// same 5-minute default — see the spec's "Resolved decision" for why. An
// optional `{min, max}` override is accepted so the two could diverge later
// without changing every call site.
export const DEFAULT_MODEL_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
export const MIN_MODEL_IDLE_TIMEOUT_MS = 30 * 1000; // 30 seconds
export const MAX_MODEL_IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes

/**
 * Clamp/validate a raw idle-timeout value (ms) to the allowed bounds.
 * Non-finite/non-numeric input falls back to the default rather than being
 * silently coerced to a boundary value.
 *
 * @param {number} value
 * @param {{ min?: number, max?: number, defaultValue?: number }} [options]
 * @returns {number}
 */
export function resolveModelIdleTimeoutMs(value, options = {}) {
  const min = options.min ?? MIN_MODEL_IDLE_TIMEOUT_MS;
  const max = options.max ?? MAX_MODEL_IDLE_TIMEOUT_MS;
  const defaultValue = options.defaultValue ?? DEFAULT_MODEL_IDLE_TIMEOUT_MS;

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return defaultValue;

  return Math.max(min, Math.min(max, Math.round(numeric)));
}

/**
 * Startup-sync decision for a single idle-timeout setting key, called once
 * per key (transcriptionIdleTimeoutMs, llmIdleTimeoutMs) by
 * `initializeSettings()` in settingsStore.ts. Never reads/writes the other
 * key — full independence between the two settings is a hard requirement.
 *
 * @param {{ hasBeenSetOnMain: boolean, mainValue: number, rendererValue: number }} params
 * @returns {{ action: "pull"|"push", value: number }}
 */
export function resolveModelIdleTimeoutStartupSync({ hasBeenSetOnMain, mainValue, rendererValue }) {
  if (hasBeenSetOnMain) {
    return { action: "pull", value: resolveModelIdleTimeoutMs(mainValue) };
  }
  return { action: "push", value: resolveModelIdleTimeoutMs(rendererValue) };
}
