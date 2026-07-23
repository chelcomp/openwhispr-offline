// Pure decision function for the renderer's screen-context-retention startup
// sync (see `initializeSettings()` in `src/stores/settingsStore.ts`). Ported
// line-for-line from `audioRetentionSync.js`'s `resolveAudioRetentionStartupSync()`
// — same "main's persisted value wins if genuinely already set, otherwise the
// renderer's own value wins and gets pushed up" logic, applied to the fully
// independent `screenContextRetentionDays` setting.
//
// See docs/specs/active-window-screen-context.md Requirement 17/Design for why
// this mirrors audioRetentionDays's exact fallback semantics.

/**
 * @param {{ hasBeenSetOnMain: boolean, mainValue: number, rendererValue: number }} params
 * @returns {{ action: "pull"|"push", value: number }}
 */
export function resolveScreenContextRetentionStartupSync({
  hasBeenSetOnMain,
  mainValue,
  rendererValue,
}) {
  if (hasBeenSetOnMain) {
    return { action: "pull", value: mainValue };
  }
  return { action: "push", value: rendererValue };
}
