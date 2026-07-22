const { DEFAULTS, LIMITS } = require("../constants/previewVad.json");

const DEFAULT_PREVIEW_VAD_CONFIG = Object.freeze({ ...DEFAULTS });
const PREVIEW_VAD_LIMITS = Object.freeze(LIMITS);

function clampPreviewVadField(key, value) {
  const fallback = DEFAULTS[key];
  const n = value === null || value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isFinite(n)) return fallback;
  const { min, max, round } = LIMITS[key];
  const clamped = Math.min(max, Math.max(min, n));
  return round ? Math.round(clamped) : clamped;
}

function sanitizePreviewVadConfig(input = {}) {
  const merged = { ...DEFAULTS, ...(input || {}) };
  const out = {};
  for (const key of Object.keys(DEFAULTS)) {
    out[key] = clampPreviewVadField(key, merged[key]);
  }
  return out;
}

function resolvePreviewVadConfig(persistedSettings = {}) {
  return sanitizePreviewVadConfig(persistedSettings);
}

module.exports = {
  DEFAULT_PREVIEW_VAD_CONFIG,
  PREVIEW_VAD_LIMITS,
  clampPreviewVadField,
  sanitizePreviewVadConfig,
  resolvePreviewVadConfig,
};
