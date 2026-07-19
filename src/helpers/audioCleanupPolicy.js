/**
 * Pure decision function for the periodic audio cleanup job (dictation +
 * meeting audio, see `_setupAudioCleanup()` in ipcHandlers.js). Extracted so
 * the caller-side "is this retention value valid, and what should the
 * cleanup pass do with it" logic is unit-testable via plain `node --test`,
 * mirroring the `src/helpers/dictationRouting.js` pattern used for reasoning
 * route decisions.
 *
 * A configured retention value of `0` is a deliberate, valid choice meaning
 * "delete all existing audio immediately" — it is NOT treated as "disabled"
 * and needs no special-cased branch here; the existing cutoff math in
 * `audioStorage.js`/`meetingAudioStorage.js` already deletes everything for
 * `retentionDays = 0` on its own. Only negative, non-finite (NaN/Infinity),
 * or otherwise non-numeric values are treated as invalid, in which case the
 * cleanup pass should be skipped entirely for that tick — explicitly not
 * conflated with the valid, deliberate value `0`.
 *
 * @param {number} retentionDays
 * @returns {{ shouldRun: boolean, retentionDays: number|null }}
 */
function decideAudioCleanup(retentionDays) {
  const isValid = Number.isFinite(retentionDays) && retentionDays >= 0;
  if (!isValid) {
    return { shouldRun: false, retentionDays: null };
  }
  return { shouldRun: true, retentionDays };
}

/**
 * Startup-ordering safeguard: the very first immediate cleanup pass at app
 * boot must be skipped whenever `AUDIO_RETENTION_DAYS` has never been
 * persisted at all (fresh install, headless/CLI-bridge session, or an
 * existing user's first launch after upgrading to this fix) — giving the
 * renderer's startup sync (see `src/helpers/audioRetentionSync.js`) a chance
 * to establish the real, authoritative value before any file is touched.
 * Every subsequent tick (interval or a future restart once a value has been
 * persisted) proceeds normally.
 *
 * @param {boolean} hasBeenSetOnMain
 * @returns {boolean} whether the immediate cleanup pass should run this boot
 */
function shouldRunImmediateCleanup(hasBeenSetOnMain) {
  return Boolean(hasBeenSetOnMain);
}

module.exports = { decideAudioCleanup, shouldRunImmediateCleanup };
