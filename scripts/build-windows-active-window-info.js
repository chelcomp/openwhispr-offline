#!/usr/bin/env node
/**
 * Ensures the windows-active-window-info binary is available.
 *
 * Mirrors build-windows-key-listener.js's strategy exactly:
 * 1. If binary exists and is up-to-date, do nothing
 * 2. Try to compile locally so source changes are picked up in Windows builds
 * 3. Fall back to downloading a prebuilt binary if local compilation is unavailable
 *
 * This allows developers without a C compiler to still build the app.
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const isWindows = process.platform === "win32";
if (!isWindows) {
  // Only needed on Windows
  process.exit(0);
}

const projectRoot = path.resolve(__dirname, "..");
const cSource = path.join(projectRoot, "resources", "windows-active-window-info.c");
const outputDir = path.join(projectRoot, "resources", "bin");
const outputBinary = path.join(outputDir, "windows-active-window-info.exe");

function log(message) {
  console.log(`[windows-active-window-info] ${message}`);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function isBinaryUpToDate() {
  if (!fs.existsSync(outputBinary)) {
    return false;
  }
  if (!fs.existsSync(cSource)) {
    return true;
  }
  try {
    const binaryStat = fs.statSync(outputBinary);
    const sourceStat = fs.statSync(cSource);
    return binaryStat.mtimeMs >= sourceStat.mtimeMs;
  } catch {
    return false;
  }
}

async function tryDownload() {
  log("Attempting to download prebuilt binary...");

  const downloadScript = path.join(__dirname, "download-windows-active-window-info.js");
  if (!fs.existsSync(downloadScript)) {
    log("Download script not found, skipping download");
    return false;
  }

  const result = spawnSync(process.execPath, [downloadScript, "--force"], {
    stdio: "inherit",
    cwd: projectRoot,
  });

  if (result.status === 0 && fs.existsSync(outputBinary)) {
    log("Successfully downloaded prebuilt binary");
    return true;
  }

  log("Download failed or binary not found after download");
  return false;
}

function quotePath(p) {
  return `"${p.replace(/"/g, '\\"')}"`;
}

// GDI+ requires linking gdiplus, gdi32, user32; IStream/CreateStreamOnHGlobal
// require ole32. tlhelp32 (process snapshot) is part of kernel32, no extra lib.
function tryCompile() {
  if (!fs.existsSync(cSource)) {
    log("C source not found, cannot compile locally");
    return false;
  }

  log("Attempting local compilation...");

  const libs = ["gdiplus", "gdi32", "user32", "ole32"];
  const msvcLibs = libs.map((l) => `${l}.lib`).join(" ");
  const gccLibs = libs.map((l) => `-l${l}`);

  const compilers = [
    {
      name: "MSVC",
      check: { command: "cl", args: [] },
      useShell: true,
      getCommand: () =>
        `cl /O2 /nologo ${quotePath(cSource)} /Fe:${quotePath(outputBinary)} ${msvcLibs}`,
    },
    {
      name: "MinGW-w64",
      check: { command: "gcc", args: ["--version"] },
      useShell: false,
      command: "gcc",
      args: ["-O2", cSource, "-o", outputBinary, ...gccLibs],
    },
    {
      name: "Clang",
      check: { command: "clang", args: ["--version"] },
      useShell: false,
      command: "clang",
      args: ["-O2", cSource, "-o", outputBinary, ...gccLibs],
    },
  ];

  for (const compiler of compilers) {
    log(`Trying ${compiler.name}...`);

    const checkResult = spawnSync(compiler.check.command, compiler.check.args, {
      stdio: "pipe",
      shell: true,
    });

    if (checkResult.status !== 0 && checkResult.error) {
      log(`${compiler.name} not found, trying next...`);
      continue;
    }

    let result;
    if (compiler.useShell) {
      const cmd = compiler.getCommand();
      log(`Compiling with: ${cmd}`);
      result = spawnSync(cmd, [], {
        stdio: "inherit",
        cwd: projectRoot,
        shell: true,
      });
    } else {
      log(`Compiling with: ${compiler.command} ${compiler.args.join(" ")}`);
      result = spawnSync(compiler.command, compiler.args, {
        stdio: "inherit",
        cwd: projectRoot,
        shell: false,
      });
    }

    if (result.status === 0 && fs.existsSync(outputBinary)) {
      log(`Successfully built with ${compiler.name}`);
      return true;
    }

    log(`${compiler.name} compilation failed, trying next...`);
  }

  return false;
}

async function main() {
  ensureDir(outputDir);

  if (isBinaryUpToDate()) {
    log("Binary is up to date, skipping build");
    return;
  }

  const compiled = tryCompile();
  if (compiled) {
    return;
  }

  const downloaded = await tryDownload();
  if (downloaded) {
    return;
  }

  console.warn(
    "[windows-active-window-info] Could not obtain windows-active-window-info binary."
  );
  console.warn(
    "[windows-active-window-info] Screen-context capture will gracefully no-op (Requirement 7)."
  );
  console.warn(
    "[windows-active-window-info] To compile locally, install Visual Studio Build Tools or MinGW-w64."
  );
}

main().catch((error) => {
  console.error("[windows-active-window-info] Unexpected error:", error);
  // Don't fail the build
});
