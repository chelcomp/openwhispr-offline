/**
 * Windows-only active-window screenshot capture (see
 * docs/specs/active-window-screen-context.md's "Capture: identifying and
 * grabbing the focused window (Windows only)" Design section).
 *
 * Spawns `windows-active-window-info.exe` (a short-lived, one-shot helper —
 * see resources/windows-active-window-info.c), reads its framed stdout
 * output (a JSON metadata line followed by raw PNG bytes), downscales the
 * bitmap (via Electron's `nativeImage`, no new image-processing dependency)
 * so its long edge never exceeds `MAX_LONG_EDGE_PX`, and returns the PNG
 * buffer. Never throws — every failure
 * mode (missing binary, helper error, "no eligible window" self-exclusion of
 * EktosWhispr's own overlay) resolves to `null` so a capture failure degrades
 * to "no screen context" (Requirement 7), never a crash.
 *
 * No disk persistence by default (Requirement 8) — the PNG buffer returned
 * here lives only in memory unless the caller (the `capture-active-window-context`
 * IPC handler) explicitly opts into `persistActiveWindowScreenshots`.
 */

const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const debugLogger = require("./debugLogger");

const MAX_LONG_EDGE_PX = 1920;
const CAPTURE_TIMEOUT_MS = 5000;

let _binaryResolved = false;
let _binaryPath = null;

// Lazily/optionally resolved — `require("electron")` returns a plain string
// (the electron binary path) rather than the API surface when this module is
// loaded outside an Electron process (e.g. under plain `node --test`), so
// `nativeImage` is simply absent there and downscaling is skipped gracefully
// rather than throwing.
let _nativeImage;
try {
  _nativeImage = require("electron").nativeImage;
} catch {
  _nativeImage = null;
}

/**
 * Downscales a PNG buffer so its long edge never exceeds MAX_LONG_EDGE_PX,
 * keeping OCR fast and memory low (Design: "Capture" section). Best-effort —
 * any failure (unavailable nativeImage, unparsable/empty image data) returns
 * the original buffer unchanged rather than throwing, since a slightly larger
 * screenshot is a performance nit, not a correctness bug (Requirement 7's
 * "never crash the app" spirit extends to this helper step too).
 */
function _downscaleIfNeeded(pngBuffer) {
  if (!_nativeImage || !pngBuffer || !pngBuffer.length) return pngBuffer;
  try {
    const image = _nativeImage.createFromBuffer(pngBuffer);
    if (!image || image.isEmpty()) return pngBuffer;
    const { width, height } = image.getSize();
    const longEdge = Math.max(width, height);
    if (!longEdge || longEdge <= MAX_LONG_EDGE_PX) return pngBuffer;
    const scale = MAX_LONG_EDGE_PX / longEdge;
    const resized = image.resize({
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
    });
    const resizedBuffer = resized.toPNG();
    return resizedBuffer && resizedBuffer.length ? resizedBuffer : pngBuffer;
  } catch (error) {
    debugLogger.debug("[ActiveWindowCapture] downscale failed, using original buffer", {
      error: error.message,
    });
    return pngBuffer;
  }
}

function isSupportedPlatform() {
  return process.platform === "win32";
}

function _resolveBinary() {
  if (_binaryResolved) return _binaryPath;
  _binaryResolved = true;

  const binaryName = "windows-active-window-info.exe";
  const candidates = new Set([
    path.join(__dirname, "..", "..", "resources", "bin", binaryName),
    path.join(__dirname, "..", "..", "resources", binaryName),
  ]);

  if (process.resourcesPath) {
    [
      path.join(process.resourcesPath, binaryName),
      path.join(process.resourcesPath, "bin", binaryName),
      path.join(process.resourcesPath, "resources", binaryName),
      path.join(process.resourcesPath, "resources", "bin", binaryName),
      path.join(process.resourcesPath, "app.asar.unpacked", "resources", binaryName),
      path.join(process.resourcesPath, "app.asar.unpacked", "resources", "bin", binaryName),
    ].forEach((c) => candidates.add(c));
  }

  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) {
        _binaryPath = candidate;
        return _binaryPath;
      }
    } catch {}
  }

  debugLogger.info("[ActiveWindowCapture] windows-active-window-info.exe not found", {
    searched: [...candidates],
  });
  return null;
}

// Parses the helper's framed stdout: a JSON metadata line (title, process
// name, bounds, hasEligibleWindow) followed by a newline, then raw PNG bytes.
function _parseFramedOutput(buffer) {
  const newlineIndex = buffer.indexOf(0x0a); // '\n'
  if (newlineIndex === -1) return null;
  const headerRaw = buffer.slice(0, newlineIndex).toString("utf8").trim();
  let header;
  try {
    header = JSON.parse(headerRaw);
  } catch {
    return null;
  }
  if (!header || header.hasEligibleWindow === false) return { header, png: null };
  const png = buffer.slice(newlineIndex + 1);
  if (!png.length) return { header, png: null };
  return { header, png };
}

/**
 * Captures the currently focused window (Windows only) and returns
 * `{ appIdentifier, png }` where `png` is a Buffer (already downscaled) or
 * `null` when the binary is missing/erroring/reports no eligible window.
 * `appIdentifier` is the owning process's executable name, used by the
 * OCR-reuse cache (Requirement 13) — present even when `png` is null, if the
 * helper still identified a window but failed to capture its bitmap.
 */
function captureActiveWindow() {
  if (!isSupportedPlatform()) {
    return Promise.resolve({ appIdentifier: null, png: null, supported: false });
  }

  const bin = _resolveBinary();
  if (!bin) {
    return Promise.resolve({ appIdentifier: null, png: null, supported: true });
  }

  return new Promise((resolve) => {
    execFile(
      bin,
      [],
      { timeout: CAPTURE_TIMEOUT_MS, maxBuffer: 50 * 1024 * 1024, encoding: "buffer" },
      (err, stdout) => {
        if (err) {
          debugLogger.debug("[ActiveWindowCapture] capture failed", { error: err.message });
          return resolve({ appIdentifier: null, png: null, supported: true });
        }
        const parsed = _parseFramedOutput(stdout);
        if (!parsed || !parsed.png) {
          return resolve({
            appIdentifier: parsed?.header?.processName || null,
            png: null,
            supported: true,
          });
        }
        resolve({
          appIdentifier: parsed.header.processName || null,
          png: _downscaleIfNeeded(parsed.png),
          supported: true,
        });
      }
    );
  });
}

/**
 * Writes a PNG buffer to a per-request temp file (only when an OCR strategy
 * requires a file path as input, e.g. the native PowerShell OCR bridge).
 * Returns the temp path; caller is responsible for deleting it in a `finally`
 * block immediately after use (Requirement 8).
 */
function writeTempPngFile(pngBuffer) {
  const tempPath = path.join(os.tmpdir(), `ektoswhispr-screen-context-${crypto.randomUUID()}.png`);
  fs.writeFileSync(tempPath, pngBuffer);
  return tempPath;
}

function deleteTempFile(tempPath) {
  try {
    if (tempPath) fs.unlinkSync(tempPath);
  } catch {
    // Best-effort cleanup — a failed unlink here must never surface as an error.
  }
}

module.exports = {
  isSupportedPlatform,
  captureActiveWindow,
  writeTempPngFile,
  deleteTempFile,
  MAX_LONG_EDGE_PX,
  _resolveBinary,
  _downscaleIfNeeded,
};
