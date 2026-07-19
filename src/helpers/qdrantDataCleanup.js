const fs = require("fs");
const os = require("os");
const path = require("path");
const { app } = require("electron");

const SENTINEL_FILENAME = ".qdrant-removed";

// Local data directories left behind by the now-removed Qdrant sidecar +
// MiniLM embedding subsystem (see docs/specs/remove-qdrant-dependency.md).
const ORPHANED_DIRS = [
  path.join(os.homedir(), ".cache", "ektoswhispr", "qdrant-data"),
  path.join(os.homedir(), ".cache", "ektoswhispr", "embedding-models"),
];

function getSentinelPath() {
  return path.join(app.getPath("userData"), SENTINEL_FILENAME);
}

/**
 * One-time, best-effort cleanup of orphaned Qdrant/embedding-model data
 * directories for users upgrading from a version that shipped the Qdrant
 * sidecar. Runs unconditionally on all platforms. Never blocks app boot and
 * never surfaces errors to the user — if the sentinel can't be written, the
 * cleanup is simply retried on the next launch (the delete itself is
 * idempotent, so this is safe).
 */
async function cleanupOrphanedQdrantData(debugLogger) {
  const sentinelPath = getSentinelPath();
  if (fs.existsSync(sentinelPath)) return;

  await Promise.all(
    ORPHANED_DIRS.map(async (dir) => {
      try {
        await fs.promises.rm(dir, { recursive: true, force: true });
      } catch (err) {
        debugLogger?.info?.("Qdrant data cleanup failed for a directory (non-fatal)", {
          dir,
          error: err.message,
        });
      }
    })
  );

  try {
    await fs.promises.writeFile(sentinelPath, new Date().toISOString());
  } catch {
    // Best-effort: if userData isn't writable, cleanup is retried next launch.
  }

  debugLogger?.info?.("One-time Qdrant/embedding-model data cleanup complete");
}

module.exports = { cleanupOrphanedQdrantData };
