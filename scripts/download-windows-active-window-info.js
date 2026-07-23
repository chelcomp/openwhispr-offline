#!/usr/bin/env node
/**
 * Downloads the prebuilt windows-active-window-info.exe binary from GitHub
 * releases. Used for the active-window screen-context capture feature (see
 * docs/specs/active-window-screen-context.md). Mirrors
 * download-windows-key-listener.js's structure exactly.
 *
 * Usage:
 *   node scripts/download-windows-active-window-info.js [--force]
 */

const fs = require("fs");
const path = require("path");
const {
  downloadFile,
  extractZip,
  fetchLatestRelease,
  setExecutable,
} = require("./lib/download-utils");

const REPO = "OpenWhispr/openwhispr";
const TAG_PREFIX = "windows-active-window-info-v";
const ZIP_NAME = "windows-active-window-info-win32-x64.zip";
const BINARY_NAME = "windows-active-window-info.exe";

const VERSION_OVERRIDE = process.env.WINDOWS_ACTIVE_WINDOW_INFO_VERSION || null;

const BIN_DIR = path.join(__dirname, "..", "resources", "bin");

async function main() {
  if (process.platform !== "win32") {
    console.log("[windows-active-window-info] Skipping download (not Windows)");
    return;
  }

  const forceDownload = process.argv.includes("--force");
  const outputPath = path.join(BIN_DIR, BINARY_NAME);

  if (fs.existsSync(outputPath) && !forceDownload) {
    console.log("[windows-active-window-info] Already exists (use --force to re-download)");
    console.log(`  ${outputPath}`);
    return;
  }

  if (VERSION_OVERRIDE) {
    console.log(`\n[windows-active-window-info] Using pinned version: ${VERSION_OVERRIDE}`);
  } else {
    console.log("\n[windows-active-window-info] Fetching latest release...");
  }
  const tagToFind = VERSION_OVERRIDE || TAG_PREFIX;
  const release = await fetchLatestRelease(REPO, { tagPrefix: tagToFind });

  if (!release) {
    console.error(
      "[windows-active-window-info] Could not find a release matching prefix:",
      TAG_PREFIX
    );
    console.log(
      "[windows-active-window-info] Screen context capture will be unavailable (Requirement 7 — graceful no-op, never fatal)"
    );
    return;
  }

  const zipAsset = release.assets.find((a) => a.name === ZIP_NAME);
  if (!zipAsset) {
    console.error(
      `[windows-active-window-info] Release ${release.tag} does not contain ${ZIP_NAME}`
    );
    return;
  }

  console.log(`\nDownloading windows-active-window-info (${release.tag})...\n`);
  fs.mkdirSync(BIN_DIR, { recursive: true });

  const zipPath = path.join(BIN_DIR, ZIP_NAME);
  console.log(`  Downloading from: ${zipAsset.url}`);

  try {
    await downloadFile(zipAsset.url, zipPath);

    const extractDir = path.join(BIN_DIR, "temp-windows-active-window-info");
    fs.mkdirSync(extractDir, { recursive: true });

    console.log("  Extracting...");
    await extractZip(zipPath, extractDir);

    const binaryPath = path.join(extractDir, BINARY_NAME);
    if (fs.existsSync(binaryPath)) {
      fs.copyFileSync(binaryPath, outputPath);
      setExecutable(outputPath);
      console.log(`  Extracted to: ${BINARY_NAME}`);
    } else {
      throw new Error(`Binary not found in archive: ${BINARY_NAME}`);
    }

    fs.rmSync(extractDir, { recursive: true, force: true });
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

    const stats = fs.statSync(outputPath);
    console.log(
      `\n[windows-active-window-info] Successfully downloaded ${release.tag} (${Math.round(stats.size / 1024)}KB)`
    );
  } catch (error) {
    console.error(`\n[windows-active-window-info] Download failed: ${error.message}`);
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    console.log(
      "[windows-active-window-info] Screen context capture will be unavailable (graceful no-op, per Requirement 7)"
    );
  }
}

main().catch((error) => {
  console.error("[windows-active-window-info] Unexpected error:", error);
});
