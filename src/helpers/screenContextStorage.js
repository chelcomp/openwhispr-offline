const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { app } = require("electron");
const debugLogger = require("./debugLogger");

// Mirrors src/helpers/audioStorage.js's AudioStorageManager shape, adapted to
// PNG screenshots instead of .webm audio. See
// docs/specs/active-window-screen-context.md's "Screenshot persistence and
// retention" Design section — persisted only when the user opts into
// `persistActiveWindowScreenshots` (default false); this directory is created
// lazily on first actual save, never at app startup (Premise #2).
class ScreenContextStorageManager {
  constructor() {
    this.captureDir = path.join(app.getPath("userData"), "screen-context-captures");
  }

  ensureCaptureDir() {
    try {
      fs.mkdirSync(this.captureDir, { recursive: true });
    } catch (error) {
      debugLogger.error(
        "Failed to create screen-context captures directory",
        { error: error.message },
        "screen-context-storage"
      );
    }
  }

  _buildFilename(timestamp) {
    const d = new Date(timestamp || Date.now());
    const shortId = crypto.randomBytes(4).toString("hex");
    if (!isNaN(d.getTime())) {
      const pad = (n) => String(n).padStart(2, "0");
      const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      const time = `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
      return `EktosWhispr-${date}-${time}-${shortId}.png`;
    }
    return `EktosWhispr-${shortId}.png`;
  }

  saveScreenshot(pngBuffer, timestamp) {
    try {
      this.ensureCaptureDir();
      const filename = this._buildFilename(timestamp);
      const filePath = path.join(this.captureDir, filename);
      fs.writeFileSync(filePath, pngBuffer);
      debugLogger.debug(
        "Screen context screenshot saved",
        { filename, size: pngBuffer.length },
        "screen-context-storage"
      );
      return { success: true, path: filePath };
    } catch (error) {
      debugLogger.error(
        "Failed to save screen context screenshot",
        { error: error.message },
        "screen-context-storage"
      );
      return { success: false };
    }
  }

  // Mirrors AudioStorageManager.cleanupExpiredAudio()'s exact edge-value
  // contract: retentionDays = 0 is a deliberate, valid "delete everything
  // now" — never conflated with negative/NaN/Infinity, which are invalid and
  // skip the whole tick. No databaseManager/flag-clearing step, since
  // persisted screenshots have no corresponding DB row (Design, "Screenshot
  // persistence and retention").
  cleanupExpiredScreenshots(retentionDays) {
    if (!Number.isFinite(retentionDays) || retentionDays < 0) {
      let kept = 0;
      try {
        kept = fs.readdirSync(this.captureDir).filter((f) => f.endsWith(".png")).length;
      } catch {}
      debugLogger.warn(
        "Screen context cleanup skipped — invalid retention value",
        { retentionDays },
        "screen-context-storage"
      );
      return { deleted: 0, kept };
    }
    let files;
    try {
      files = fs.readdirSync(this.captureDir).filter((f) => f.endsWith(".png"));
    } catch (error) {
      // Directory doesn't exist yet — persistence is off, or nothing has ever
      // been saved. Nothing to clean up; this is the common case, not an error.
      return { deleted: 0, kept: 0 };
    }
    try {
      const cutoffMs = Date.now() - retentionDays * 86400000;
      let deleted = 0;
      let kept = 0;

      for (const file of files) {
        const filePath = path.join(this.captureDir, file);
        try {
          const stats = fs.statSync(filePath);
          if (stats.mtimeMs < cutoffMs) {
            fs.unlinkSync(filePath);
            deleted++;
          } else {
            kept++;
          }
        } catch (error) {
          debugLogger.error(
            "Failed to process screenshot file during cleanup",
            { file, error: error.message },
            "screen-context-storage"
          );
        }
      }

      debugLogger.info(
        "Screen context cleanup complete",
        { deleted, kept, retentionDays },
        "screen-context-storage"
      );
      return { deleted, kept };
    } catch (error) {
      debugLogger.error(
        "Screen context cleanup failed",
        { error: error.message },
        "screen-context-storage"
      );
      return { deleted: 0, kept: 0 };
    }
  }

  deleteAllScreenshots() {
    try {
      const files = fs.readdirSync(this.captureDir).filter((f) => f.endsWith(".png"));
      for (const file of files) {
        try {
          fs.unlinkSync(path.join(this.captureDir, file));
        } catch (error) {
          debugLogger.error(
            "Failed to delete screenshot file",
            { file, error: error.message },
            "screen-context-storage"
          );
        }
      }
      debugLogger.info(
        "All screen context screenshots deleted",
        { count: files.length },
        "screen-context-storage"
      );
      return { deleted: files.length };
    } catch (error) {
      // Directory may never have been created — that's success (nothing to delete).
      return { deleted: 0 };
    }
  }

  getStorageUsage() {
    try {
      const files = fs.readdirSync(this.captureDir).filter((f) => f.endsWith(".png"));
      let totalBytes = 0;
      for (const file of files) {
        try {
          const stats = fs.statSync(path.join(this.captureDir, file));
          totalBytes += stats.size;
        } catch {
          // Skip files that can't be stat'd
        }
      }
      return { fileCount: files.length, totalBytes };
    } catch {
      // Directory not created yet — 0 usage.
      return { fileCount: 0, totalBytes: 0 };
    }
  }
}

module.exports = ScreenContextStorageManager;
