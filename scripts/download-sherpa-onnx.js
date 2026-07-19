#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { downloadFile, findBinaryInDir, parseArgs, setExecutable } = require("./lib/download-utils");

const SHERPA_ONNX_VERSION = "1.13.4";
const GITHUB_RELEASE_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/v${SHERPA_ONNX_VERSION}`;

// Binary configurations for each platform
// Note: macOS uses universal2 builds that work on both arm64 and x64
const BINARIES = {
  "darwin-arm64": {
    archiveName: `sherpa-onnx-v${SHERPA_ONNX_VERSION}-osx-universal2-shared.tar.bz2`,
    binaryPath: "sherpa-onnx-offline-websocket-server",
    outputName: "sherpa-onnx-ws-darwin-arm64",
    onlineBinaryPath: "sherpa-onnx-online-websocket-server",
    onlineOutputName: "sherpa-onnx-online-ws-darwin-arm64",
    diarizeBinaryPath: "sherpa-onnx-offline-speaker-diarization",
    diarizeOutputName: "sherpa-onnx-diarize-darwin-arm64",
    libPattern: "*.dylib",
  },
  "darwin-x64": {
    archiveName: `sherpa-onnx-v${SHERPA_ONNX_VERSION}-osx-universal2-shared.tar.bz2`,
    binaryPath: "sherpa-onnx-offline-websocket-server",
    outputName: "sherpa-onnx-ws-darwin-x64",
    onlineBinaryPath: "sherpa-onnx-online-websocket-server",
    onlineOutputName: "sherpa-onnx-online-ws-darwin-x64",
    diarizeBinaryPath: "sherpa-onnx-offline-speaker-diarization",
    diarizeOutputName: "sherpa-onnx-diarize-darwin-x64",
    libPattern: "*.dylib",
  },
  "win32-x64": {
    archiveName: `sherpa-onnx-v${SHERPA_ONNX_VERSION}-win-x64-shared-MD-Release.tar.bz2`,
    binaryPath: "sherpa-onnx-offline-websocket-server.exe",
    outputName: "sherpa-onnx-ws-win32-x64.exe",
    onlineBinaryPath: "sherpa-onnx-online-websocket-server.exe",
    onlineOutputName: "sherpa-onnx-online-ws-win32-x64.exe",
    diarizeBinaryPath: "sherpa-onnx-offline-speaker-diarization.exe",
    diarizeOutputName: "sherpa-onnx-diarize-win32-x64.exe",
    libPattern: "*.dll",
  },
  "linux-x64": {
    archiveName: `sherpa-onnx-v${SHERPA_ONNX_VERSION}-linux-x64-shared.tar.bz2`,
    binaryPath: "sherpa-onnx-offline-websocket-server",
    outputName: "sherpa-onnx-ws-linux-x64",
    onlineBinaryPath: "sherpa-onnx-online-websocket-server",
    onlineOutputName: "sherpa-onnx-online-ws-linux-x64",
    diarizeBinaryPath: "sherpa-onnx-offline-speaker-diarization",
    diarizeOutputName: "sherpa-onnx-diarize-linux-x64",
    libPattern: "*.so*",
  },
};

// CUDA variants — Windows and Linux only (macOS uses Metal/CoreML, not CUDA).
// These produce an additional -cuda suffixed binary in resources/bin.
// Usage: npm run download:sherpa-onnx:cuda
const CUDA_BINARIES = {
  "win32-x64": {
    archiveName: `sherpa-onnx-v${SHERPA_ONNX_VERSION}-win-x64-cuda.tar.bz2`,
    binaryPath: "sherpa-onnx-offline-websocket-server.exe",
    outputName: "sherpa-onnx-ws-win32-x64-cuda.exe",
    onlineBinaryPath: "sherpa-onnx-online-websocket-server.exe",
    onlineOutputName: "sherpa-onnx-online-ws-win32-x64-cuda.exe",
    libPattern: "*.dll",
  },
  "linux-x64": {
    archiveName: `sherpa-onnx-v${SHERPA_ONNX_VERSION}-cuda-12.x-cudnn-9.x-linux-x64-gpu.tar.bz2`,
    binaryPath: "sherpa-onnx-offline-websocket-server",
    outputName: "sherpa-onnx-ws-linux-x64-cuda",
    onlineBinaryPath: "sherpa-onnx-online-websocket-server",
    onlineOutputName: "sherpa-onnx-online-ws-linux-x64-cuda",
    libPattern: "*.so*",
  },
};

const BIN_DIR = path.join(__dirname, "..", "resources", "bin");

function getDownloadUrl(archiveName) {
  return `${GITHUB_RELEASE_URL}/${archiveName}`;
}

function extractTarBz2(archivePath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  // Use relative paths from archive dir as cwd, so neither -f nor -C args
  // contain Windows drive letter colons (GNU tar treats C: as remote host)
  const cwd = path.dirname(archivePath);
  execFileSync("tar", ["-xjf", path.basename(archivePath), "-C", path.relative(cwd, destDir)], {
    stdio: "inherit",
    cwd,
  });
}

function findLibrariesInDir(dir, pattern, maxDepth = 5, currentDepth = 0) {
  if (currentDepth >= maxDepth) return [];

  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        results.push(...findLibrariesInDir(fullPath, pattern, maxDepth, currentDepth + 1));
      } else if (matchesPattern(entry.name, pattern)) {
        results.push(fullPath);
      }
    }
  } catch {
    // Ignore permission errors
  }

  return results;
}

function matchesPattern(filename, pattern) {
  if (pattern === "*.dylib") {
    return filename.endsWith(".dylib");
  } else if (pattern === "*.dll") {
    return filename.endsWith(".dll");
  } else if (pattern === "*.so*") {
    return /\.so(\.\d+)*$/.test(filename) || filename.endsWith(".so");
  }
  return false;
}

function tryCopyBinary(src, dest, label, platformArch) {
  if (!fs.existsSync(src)) {
    console.error(`  ${platformArch}: Binary '${path.basename(src)}' not found in archive`);
    return false;
  }
  try {
    fs.copyFileSync(src, dest);
    setExecutable(dest);
    console.log(`  ${platformArch}: Extracted to ${label}`);
    return true;
  } catch (err) {
    if (err.code === "EBUSY" && fs.existsSync(dest)) {
      console.log(`  ${platformArch}: ${label} already exists and is in use — skipped`);
      return true;
    }
    throw err;
  }
}

async function downloadBinary(platformArch, config, isForce = false) {
  if (!config) {
    console.log(`  ${platformArch}: Not supported`);
    return false;
  }

  const outputPath = path.join(BIN_DIR, config.outputName);
  const onlineOutputPath = config.onlineOutputName
    ? path.join(BIN_DIR, config.onlineOutputName)
    : null;
  const diarizeOutputPath = config.diarizeOutputName
    ? path.join(BIN_DIR, config.diarizeOutputName)
    : null;

  const allExist =
    fs.existsSync(outputPath) &&
    (!onlineOutputPath || fs.existsSync(onlineOutputPath)) &&
    (!diarizeOutputPath || fs.existsSync(diarizeOutputPath));
  if (allExist && !isForce) {
    console.log(`  ${platformArch}: Already exists (use --force to re-download)`);
    return true;
  }

  const url = getDownloadUrl(config.archiveName);
  console.log(`  ${platformArch}: Downloading from ${url}`);

  const archivePath = path.join(BIN_DIR, config.archiveName);

  try {
    await downloadFile(url, archivePath);

    const extractDir = path.join(BIN_DIR, `temp-sherpa-${platformArch}`);
    fs.mkdirSync(extractDir, { recursive: true });
    extractTarBz2(archivePath, extractDir);

    // Offline WebSocket server
    if (isForce || !fs.existsSync(outputPath)) {
      const binaryName = path.basename(config.binaryPath);
      const binaryFound = findBinaryInDir(extractDir, binaryName);
      if (!tryCopyBinary(binaryFound, outputPath, config.outputName, platformArch)) return false;
    } else {
      console.log(`  ${platformArch}: ${config.outputName} already exists — skipped`);
    }

    // Online WebSocket server (streaming models)
    if (config.onlineBinaryPath && onlineOutputPath) {
      if (isForce || !fs.existsSync(onlineOutputPath)) {
        const onlineBinaryName = path.basename(config.onlineBinaryPath);
        const onlineFound = findBinaryInDir(extractDir, onlineBinaryName);
        if (!tryCopyBinary(onlineFound, onlineOutputPath, config.onlineOutputName, platformArch)) return false;
      } else {
        console.log(`  ${platformArch}: ${config.onlineOutputName} already exists — skipped`);
      }
    }

    // Diarization binary (optional for CUDA builds)
    if (config.diarizeBinaryPath && diarizeOutputPath) {
      if (isForce || !fs.existsSync(diarizeOutputPath)) {
        const diarizeBinaryName = path.basename(config.diarizeBinaryPath);
        const diarizeFound = findBinaryInDir(extractDir, diarizeBinaryName);
        if (!tryCopyBinary(diarizeFound, diarizeOutputPath, config.diarizeOutputName, platformArch)) return false;
      } else {
        console.log(`  ${platformArch}: ${config.diarizeOutputName} already exists — skipped`);
      }
    }

    // Copy shared libraries
    if (config.libPattern) {
      const libraries = findLibrariesInDir(extractDir, config.libPattern);

      // Separate versioned and unversioned libraries to create symlinks where possible
      // e.g. libonnxruntime.dylib -> libonnxruntime.1.23.2.dylib (saves ~71MB)
      const versionedLibs = new Map(); // base name -> versioned file name

      for (const libPath of libraries) {
        const libName = path.basename(libPath);
        const destPath = path.join(BIN_DIR, libName);

        // Detect versioned dylib pattern: libFoo.X.Y.Z.dylib
        const versionMatch = libName.match(/^(lib.+?)\.(\d+\.\d+\.\d+)\.(dylib|so|dll)$/);
        if (versionMatch) {
          const baseName = `${versionMatch[1]}.${versionMatch[3]}`; // e.g. libonnxruntime.dylib
          versionedLibs.set(baseName, libName);
        }

        fs.copyFileSync(libPath, destPath);
        setExecutable(destPath);
        console.log(`  ${platformArch}: Copied library ${libName}`);
      }

      // Replace unversioned copies with symlinks to versioned ones (macOS/Linux only)
      if (process.platform !== "win32") {
        for (const [baseName, versionedName] of versionedLibs) {
          const basePath = path.join(BIN_DIR, baseName);
          const versionedPath = path.join(BIN_DIR, versionedName);
          if (
            fs.existsSync(basePath) &&
            fs.existsSync(versionedPath) &&
            !fs.lstatSync(basePath).isSymbolicLink()
          ) {
            fs.unlinkSync(basePath);
            fs.symlinkSync(versionedName, basePath);
            console.log(`  ${platformArch}: Symlinked ${baseName} -> ${versionedName}`);
          }
        }
      }
    }

    // Cleanup
    fs.rmSync(extractDir, { recursive: true, force: true });
    if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
    return true;
  } catch (error) {
    console.error(`  ${platformArch}: Failed - ${error.message}`);
    if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
    return false;
  }
}

async function main() {
  const isCuda = process.argv.includes("--cuda");

  console.log(
    `\nDownloading sherpa-onnx binaries (v${SHERPA_ONNX_VERSION})${isCuda ? " [CUDA]" : ""}...\n`
  );

  fs.mkdirSync(BIN_DIR, { recursive: true });

  const args = parseArgs();

  if (isCuda) {
    const platformArch = args.platformArch;
    const cudaConfig = CUDA_BINARIES[platformArch];
    if (!cudaConfig) {
      console.error(`CUDA binaries not available for ${platformArch} (only win32-x64, linux-x64)`);
      process.exitCode = 1;
      return;
    }
    console.log(`Downloading CUDA binary for ${platformArch}:`);
    const ok = await downloadBinary(platformArch, cudaConfig, args.isForce);
    if (!ok) {
      process.exitCode = 1;
    } else {
      console.log("\nCUDA binary ready. Enable in the app: Settings → Speech to Text → NVIDIA Parakeet → Use CUDA.");
    }
    return;
  }

  if (args.isCurrent) {
    if (!BINARIES[args.platformArch]) {
      console.error(`Unsupported platform/arch: ${args.platformArch}`);
      process.exitCode = 1;
      return;
    }

    console.log(`Downloading for target platform (${args.platformArch}):`);
    const ok = await downloadBinary(args.platformArch, BINARIES[args.platformArch], args.isForce);
    if (!ok) {
      console.error(`Failed to download binaries for ${args.platformArch}`);
      process.exitCode = 1;
      return;
    }

    // Remove old CLI-style binaries replaced by WS server binaries
    const oldBinaryName = args.platformArch.startsWith("win32")
      ? `sherpa-onnx-${args.platformArch}.exe`
      : `sherpa-onnx-${args.platformArch}`;
    const oldBinaryPath = path.join(BIN_DIR, oldBinaryName);
    if (fs.existsSync(oldBinaryPath)) {
      console.log(`  Removing old CLI binary: ${oldBinaryName}`);
      fs.unlinkSync(oldBinaryPath);
    }

    if (args.shouldCleanup) {
      const keepPrefixes = [
        `sherpa-onnx-ws-${args.platformArch}`,
        `sherpa-onnx-online-ws-${args.platformArch}`,
        `sherpa-onnx-diarize-${args.platformArch}`,
      ];
      const files = fs.readdirSync(BIN_DIR).filter((f) => f.startsWith("sherpa-onnx"));
      files.forEach((file) => {
        if (!keepPrefixes.some((prefix) => file.startsWith(prefix))) {
          const filePath = path.join(BIN_DIR, file);
          console.log(`Removing old binary: ${file}`);
          fs.unlinkSync(filePath);
        }
      });
    }
  } else {
    console.log("Downloading binaries for all platforms:");
    for (const platformArch of Object.keys(BINARIES)) {
      await downloadBinary(platformArch, BINARIES[platformArch], args.isForce);
    }
  }

  console.log("\n---");

  const files = fs.readdirSync(BIN_DIR).filter((f) => f.startsWith("sherpa-onnx"));
  if (files.length > 0) {
    console.log("Available sherpa-onnx binaries:\n");
    files.forEach((f) => {
      const stats = fs.statSync(path.join(BIN_DIR, f));
      console.log(`  - ${f} (${Math.round(stats.size / 1024 / 1024)}MB)`);
    });
  } else {
    console.log("No binaries downloaded yet.");
    console.log(
      `\nCheck: https://github.com/k2-fsa/sherpa-onnx/releases/tag/v${SHERPA_ONNX_VERSION}`
    );
  }
}

// Export config for potential imports
module.exports = {
  SHERPA_ONNX_VERSION,
  BINARIES,
  BIN_DIR,
  getDownloadUrl,
};

// Only run main() when executed directly
if (require.main === module) {
  main().catch(console.error);
}
