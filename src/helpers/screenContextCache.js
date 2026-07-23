/**
 * OCR-reuse cache for rapid consecutive dictations (Requirement 13, see
 * docs/specs/active-window-screen-context.md's "OCR cache reuse across rapid
 * consecutive dictations" Design section).
 *
 * Purely in-memory, process-lifetime-only — never persisted to disk, cleared
 * on app restart. Distinct from the persisted `screen_context_text` history
 * column, which stores what was *used* for an already-completed
 * transcription, not a reusable cache entry.
 *
 * Reuses the cheap "same app" identity check `activeAppCapture.detectAsync()`
 * already provides (owning process executable name via
 * `windows-fast-paste.exe --detect-only`) rather than adding a new
 * `--identify-only` mode to the new capture helper — it is strictly cheaper
 * than the full capture+OCR path (no bitmap capture, no OCR invocation),
 * satisfying this requirement's "measurably cheaper" bar without introducing
 * a second native binary code path.
 */

export const OCR_REUSE_WINDOW_MS = 2000;

// Normalizes an app identifier for comparison — the cheap identity check
// (activeAppCapture.detectAsync()) returns a lowercased, ".exe"-stripped
// name (e.g. "notepad"), while the full capture helper's processName field
// is the raw executable filename (e.g. "Notepad.exe"). Both must compare
// equal for the same app, or Requirement 13's cache can never hit.
function normalizeAppIdentifier(appIdentifier) {
  if (!appIdentifier || typeof appIdentifier !== "string") return null;
  return appIdentifier
    .trim()
    .toLowerCase()
    .replace(/\.exe$/, "");
}

export class ScreenContextCache {
  constructor() {
    this.lastScreenContext = null; // { appIdentifier, ocrText, capturedAtTimestamp } | null
    this.lastRecordingStoppedAt = null;
  }

  /** Called whenever a dictation recording actually stops. */
  recordRecordingStopped(timestamp = Date.now()) {
    this.lastRecordingStoppedAt = timestamp;
  }

  /**
   * @param {string|null} currentAppIdentifier
   * @param {number} hotkeyDownTimestamp
   * @param {number} reuseWindowMs
   * @returns {boolean}
   */
  shouldReuse(currentAppIdentifier, hotkeyDownTimestamp, reuseWindowMs = OCR_REUSE_WINDOW_MS) {
    if (!this.lastScreenContext || this.lastRecordingStoppedAt == null) return false;
    const normalizedCurrent = normalizeAppIdentifier(currentAppIdentifier);
    if (!normalizedCurrent || normalizedCurrent !== this.lastScreenContext.appIdentifier) {
      return false;
    }
    return hotkeyDownTimestamp - this.lastRecordingStoppedAt <= reuseWindowMs;
  }

  getCachedText() {
    return this.lastScreenContext?.ocrText ?? null;
  }

  /** A failed/null fresh capture must never overwrite the cache with a null entry. */
  update(appIdentifier, ocrText, capturedAtTimestamp = Date.now()) {
    this.lastScreenContext = {
      appIdentifier: normalizeAppIdentifier(appIdentifier),
      ocrText,
      capturedAtTimestamp,
    };
  }
}

/**
 * Orchestrates the identity-check-first, reuse-or-refresh decision described
 * by Requirement 13. Injected `identify`/`captureAndOcr` callbacks make this
 * independently testable without a real native helper.
 *
 * @param {{
 *   cache: ScreenContextCache,
 *   identify: () => Promise<string|null>,
 *   captureAndOcr: () => Promise<{ appIdentifier: string|null, ocrText: string|null }>,
 *   hotkeyDownTimestamp: number,
 *   reuseWindowMs?: number,
 * }} params
 * @returns {Promise<{ text: string|null, reused: boolean }>}
 */
export async function resolveScreenContextWithCache({
  cache,
  identify,
  captureAndOcr,
  hotkeyDownTimestamp,
  reuseWindowMs = OCR_REUSE_WINDOW_MS,
}) {
  const currentAppIdentifier = await identify();

  if (cache.shouldReuse(currentAppIdentifier, hotkeyDownTimestamp, reuseWindowMs)) {
    return { text: cache.getCachedText(), reused: true };
  }

  const result = await captureAndOcr();
  if (result?.ocrText) {
    cache.update(result.appIdentifier ?? currentAppIdentifier, result.ocrText);
    return { text: result.ocrText, reused: false };
  }
  // Failed/null fresh capture leaves any prior valid cache entry in place —
  // never overwritten with a null entry (Requirement 13).
  return { text: null, reused: false };
}

