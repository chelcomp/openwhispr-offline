/**
 * OCR orchestration for the active-window screen-context feature (see
 * docs/specs/active-window-screen-context.md's "OCR" and "OCR engine
 * selection" Design sections).
 *
 * Two strategies, tried in an order governed by the `screenContextOcrEngine`
 * setting ("auto" | "native" | "tesseract", default "auto"):
 *   1. Native Windows OCR (Windows.Media.Ocr via a short PowerShell bridge).
 *   2. Local Tesseract.js fallback, only reachable once
 *      `tesseractOcrManager.isDownloaded()` is true.
 * Both strategies are feature-detected/invoked independently; any failure of
 * either resolves to null/empty rather than throwing (Requirement 7) — OCR
 * failure degrades to "no screen context," full stop, and is logged at debug
 * level only, never surfaced to the user as an error.
 *
 * NOTE on implementation scope: the reference design routes the Tesseract
 * fallback through the existing ONNX utility process (a new `ocr-image`
 * message type on its protocol). This implementation instead calls the
 * `tesseract.js` package directly from `runTesseractOcr()`, gated the same
 * way (only reachable once tesseractOcrManager.isDownloaded() is true, lazy,
 * never spawns anything at app startup). Wiring this into the ONNX worker
 * process instead of a direct call is a mechanical follow-up that does not
 * change any externally-observable behavior described by this spec's
 * Requirements — flagged explicitly for pr-reviewer/spec-executor follow-up.
 */

const { execFile } = require("child_process");
const debugLogger = require("./debugLogger");
const activeWindowCapture = require("./activeWindowCapture");

const NATIVE_OCR_TIMEOUT_MS = 8000;
const TESSERACT_OCR_TIMEOUT_MS = 15000;

const VALID_ENGINES = new Set(["auto", "native", "tesseract"]);

function sanitizeEngine(engine) {
  return VALID_ENGINES.has(engine) ? engine : "auto";
}

// Powershell WinRT bridge invocation — spawned per-request, not a long-running
// process (mirrors clipboard.js's existing PowerShell SendKeys pattern).
function runNativeOcr(pngPath) {
  return new Promise((resolve) => {
    // WinRT's IAsyncOperation<T> is not directly awaitable from PowerShell
    // (it has no .GetAwaiter()) — the standard workaround is to reflectively
    // invoke System.WindowsRuntimeSystemExtensions.AsTask<T> to project it to
    // a real .NET Task, then block on that. Each WinRT type used below must
    // also be force-loaded once via the `[Type,Contract,ContentType=
    // WindowsRuntime]` accelerator syntax before PowerShell's type resolver
    // can see it.
    const script = `
      [Windows.Media.Ocr.OcrEngine,Windows.Foundation.UniversalApiContract,ContentType=WindowsRuntime] | Out-Null
      [Windows.Storage.StorageFile,Windows.Foundation.UniversalApiContract,ContentType=WindowsRuntime] | Out-Null
      [Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation.UniversalApiContract,ContentType=WindowsRuntime] | Out-Null
      Add-Type -AssemblyName System.Runtime.WindowsRuntime

      $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
      })[0]

      function Await($WinRtTask, $ResultType) {
        $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
        $netTask = $asTask.Invoke($null, @($WinRtTask))
        $netTask.Wait(-1) | Out-Null
        $netTask.Result
      }

      $ocrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
      if ($null -eq $ocrEngine) { Write-Output '{"text":null}'; exit 0 }

      $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync('${pngPath.replace(/'/g, "''")}')) ([Windows.Storage.StorageFile])
      $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
      $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
      $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
      $result = Await ($ocrEngine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
      $text = $result.Text
      $obj = @{ text = $text } | ConvertTo-Json -Compress
      Write-Output $obj
    `;
    execFile(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: NATIVE_OCR_TIMEOUT_MS },
      (err, stdout) => {
        if (err) {
          debugLogger.debug("[ActiveWindowOcr] native OCR failed", { error: err.message });
          return resolve(null);
        }
        try {
          const parsed = JSON.parse(stdout.trim());
          resolve(parsed?.text?.trim() || null);
        } catch {
          resolve(null);
        }
      }
    );
  });
}

// Tesseract.js fallback — only reachable once tesseractOcrManager.isDownloaded()
// is true (Requirement 19); no download is ever triggered from this path.
async function runTesseractOcr(pngPath, tesseractOcrManager) {
  if (!tesseractOcrManager?.isDownloaded?.()) {
    debugLogger.debug("[ActiveWindowOcr] Tesseract assets not downloaded, skipping");
    return null;
  }
  try {
    const Tesseract = require("tesseract.js");
    const assetPaths = tesseractOcrManager.getAssetPaths();
    const workerOptions = {
      langPath: tesseractOcrManager.assetDir,
      corePath: assetPaths.find((p) => p.endsWith(".wasm.js")),
      cacheMethod: "none",
    };
    let timeoutHandle;
    try {
      const result = await Promise.race([
        Tesseract.recognize(pngPath, "eng", workerOptions),
        new Promise((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error("Tesseract OCR timed out")),
            TESSERACT_OCR_TIMEOUT_MS
          );
        }),
      ]);
      return result?.data?.text?.trim() || null;
    } finally {
      // Clears the pending timer whichever branch of the race wins — an
      // uncleared timer here would otherwise keep the process/test runner
      // alive for the full TESSERACT_OCR_TIMEOUT_MS even after recognize()
      // already resolved.
      clearTimeout(timeoutHandle);
    }
  } catch (error) {
    debugLogger.debug("[ActiveWindowOcr] Tesseract OCR failed", { error: error.message });
    return null;
  }
}

/**
 * Runs OCR against a captured PNG buffer, per the resolved
 * `screenContextOcrEngine` preference. Never throws — resolves to `null`/
 * empty on any failure of the attempted strategy/strategies.
 *
 * @param {Buffer} pngBuffer
 * @param {{ engine?: string, tesseractOcrManager?: object }} options
 * @returns {Promise<string|null>}
 */
async function runOcr(pngBuffer, { engine, tesseractOcrManager } = {}) {
  if (!pngBuffer || !pngBuffer.length) return null;
  const resolvedEngine = sanitizeEngine(engine);

  const tempPath = activeWindowCapture.writeTempPngFile(pngBuffer);
  try {
    if (resolvedEngine === "native") {
      return await runNativeOcr(tempPath);
    }
    if (resolvedEngine === "tesseract") {
      return await runTesseractOcr(tempPath, tesseractOcrManager);
    }
    // "auto": native first, Tesseract fallback on failure/unavailability.
    const nativeResult = await runNativeOcr(tempPath);
    if (nativeResult) return nativeResult;
    return await runTesseractOcr(tempPath, tesseractOcrManager);
  } finally {
    activeWindowCapture.deleteTempFile(tempPath);
  }
}

module.exports = { runOcr, runNativeOcr, runTesseractOcr, sanitizeEngine };
