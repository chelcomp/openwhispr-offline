const fs = require("fs");
const { promises: fsPromises } = require("fs");
const path = require("path");
const { app } = require("electron");
const debugLogger = require("./debugLogger");
const {
  downloadFile,
  createDownloadSignal,
  checkDiskSpace,
  cleanupStaleDownloads,
} = require("./downloadUtils");

// Pinned tesseract.js-core/tessdata release, overridable via env var, mirroring
// LLAMA_CPP_VERSION's convention in llamaCudaManager.js.
const TESSERACT_JS_VERSION = process.env.TESSERACT_JS_VERSION || "5.0.0";
const TESSERACT_CORE_URL = `https://cdn.jsdelivr.net/npm/tesseract.js-core@${TESSERACT_JS_VERSION}/tesseract-core-simd.wasm.js`;
const TESSERACT_ENG_TRAINEDDATA_URL =
  "https://raw.githubusercontent.com/naptha/tessdata/gh-pages/4.0.0_fast/eng.traineddata";

const REQUIRED_ASSETS = [
  { name: "tesseract-core-simd.wasm.js", url: TESSERACT_CORE_URL },
  { name: "eng.traineddata", url: TESSERACT_ENG_TRAINEDDATA_URL },
];

// Modeled directly on src/helpers/llamaCudaManager.js's shape (see
// docs/specs/active-window-screen-context.md Requirement 19). Tesseract.js's
// WASM runtime is not bundled in the app installer/ASAR — it is a
// downloadable, opt-in asset, fetched only via an explicit Settings click (or,
// if execution ever needs it, the first time the "tesseract" OCR strategy is
// actually reached with assets missing — but the primary/default path is the
// explicit button, never a silent first-use download).
class TesseractOcrManager {
  constructor() {
    this._assetDir = null;
    this._downloadSignal = null;
    this._downloading = false;
  }

  get assetDir() {
    if (!this._assetDir) {
      this._assetDir = path.join(app.getPath("userData"), "tesseract-ocr");
    }
    return this._assetDir;
  }

  // Tesseract.js's WASM runtime is cross-platform (unlike CUDA's per-platform
  // binary gating) — kept as a method for architectural symmetry with
  // LlamaCudaManager.isSupported() and forward-compatibility only.
  isSupported() {
    return true;
  }

  getAssetPaths() {
    return REQUIRED_ASSETS.map((asset) => path.join(this.assetDir, asset.name));
  }

  isDownloaded() {
    return this.getAssetPaths().every((p) => {
      try {
        return fs.existsSync(p) && fs.statSync(p).size > 0;
      } catch {
        return false;
      }
    });
  }

  getStatus() {
    return {
      supported: this.isSupported(),
      downloaded: this.isDownloaded(),
      downloading: this._downloading,
    };
  }

  async download(onProgress) {
    if (this._downloading) throw new Error("Download already in progress");

    this._downloading = true;
    const { signal, abort } = createDownloadSignal();
    this._downloadSignal = { abort };

    try {
      await fsPromises.mkdir(this.assetDir, { recursive: true });
      await cleanupStaleDownloads(this.assetDir);

      // Tesseract's assets are far smaller than CUDA's (low tens of MB), but
      // the same pre-check guard still applies unconditionally, per the
      // mirrored llamaCudaManager.js pattern — not skipped just because the
      // payload is small.
      const estimatedTotalBytes = 20_000_000;
      const spaceCheck = await checkDiskSpace(this.assetDir, estimatedTotalBytes * 2.5);
      if (!spaceCheck.ok) {
        throw new Error(
          `Not enough disk space. Need ~${Math.round((estimatedTotalBytes * 2.5) / 1_000_000)}MB, ` +
            `only ${Math.round(spaceCheck.availableBytes / 1_000_000)}MB available.`
        );
      }

      let downloadedSoFar = 0;
      for (const asset of REQUIRED_ASSETS) {
        const destPath = path.join(this.assetDir, asset.name);
        await downloadFile(asset.url, destPath, {
          signal,
          onProgress: (downloaded, total) => {
            if (!onProgress) return;
            const combinedDone = downloadedSoFar + downloaded;
            const combinedTotal = estimatedTotalBytes;
            onProgress(combinedDone, combinedTotal, combinedDone / combinedTotal);
          },
        });
        downloadedSoFar += _statSizeOrZero(destPath);
      }

      debugLogger.info("Tesseract OCR assets installed", { assetDir: this.assetDir });
      return { success: true };
    } catch (error) {
      if (error.isAbort) return { success: false, cancelled: true };
      throw error;
    } finally {
      this._downloading = false;
      this._downloadSignal = null;
    }
  }

  cancelDownload() {
    if (this._downloadSignal) {
      this._downloadSignal.abort();
      this._downloadSignal = null;
      return true;
    }
    return false;
  }

  async deleteAssets() {
    let deletedCount = 0;
    try {
      for (const p of this.getAssetPaths()) {
        try {
          await fsPromises.unlink(p);
          deletedCount++;
        } catch {}
      }
    } catch {}
    debugLogger.info("Tesseract OCR assets deleted", { deletedCount });
    return { success: true, deletedCount };
  }
}

// Helper kept module-local: best-effort file-size read used only to keep the
// combined progress callback roughly proportional across the two downloaded
// assets. Never throws — a failed stat just means progress reporting is
// slightly less precise for that asset, not a functional issue.
function _statSizeOrZero(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

module.exports = TesseractOcrManager;
