// Pure decision function for the renderer's audio-retention startup sync
// (see `initializeSettings()` in `src/stores/settingsStore.ts`). Extracted
// so the "pull main's value, or push the renderer's own value up to main"
// branch is unit-testable via plain `node --test`, mirroring the
// `dictationRouting.js` pattern.
//
// The very first time this setting is ever synced (main has never persisted
// `AUDIO_RETENTION_DAYS` at all), main's fallback of 0 must NOT silently
// clobber an existing user's real, pre-existing renderer preference (e.g. 30,
// chosen before this main-process setting ever existed) — that value needs
// to win and be established as the persisted value instead. Once main has a
// genuinely-persisted value (from a real prior sync, whichever direction it
// came from), main is authoritative from then on and the renderer pulls,
// mirroring the existing getActivationMode/getUiLanguage/getVoiceAgentKey
// startup-sync pattern.

/**
 * @param {{ hasBeenSetOnMain: boolean, mainValue: number, rendererValue: number }} params
 * @returns {{ action: "pull"|"push", value: number }}
 */
export function resolveAudioRetentionStartupSync({ hasBeenSetOnMain, mainValue, rendererValue }) {
  if (hasBeenSetOnMain) {
    return { action: "pull", value: mainValue };
  }
  return { action: "push", value: rendererValue };
}
