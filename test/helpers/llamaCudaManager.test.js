const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const llamaCudaManagerPath = require.resolve("../../src/helpers/llamaCudaManager");

const originalLoad = Module._load;
const originalPlatform = process.platform;
const originalArch = process.arch;

function setPlatformArch(platform, arch) {
  Object.defineProperty(process, "platform", { value: platform });
  Object.defineProperty(process, "arch", { value: arch });
}

test.afterEach(() => {
  setPlatformArch(originalPlatform, originalArch);
});

function loadLlamaCudaManager(userDataDir) {
  delete require.cache[llamaCudaManagerPath];

  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "electron") {
      return { app: { getPath: () => userDataDir } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const LlamaCudaManager = require("../../src/helpers/llamaCudaManager");
    return new LlamaCudaManager();
  } finally {
    Module._load = originalLoad;
  }
}

function makeTempUserDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ektoswhispr-cuda-test-"));
}

// --- isSupported ----------------------------------------------------------

test("isSupported is true for win32-x64 and linux-x64", () => {
  const userDataDir = makeTempUserDataDir();
  for (const [platform, arch] of [
    ["win32", "x64"],
    ["linux", "x64"],
  ]) {
    setPlatformArch(platform, arch);
    const manager = loadLlamaCudaManager(userDataDir);
    assert.equal(manager.isSupported(), true, `${platform}-${arch} should be supported`);
  }
});

test("isSupported is false for darwin or arm64", () => {
  const userDataDir = makeTempUserDataDir();
  for (const [platform, arch] of [
    ["darwin", "arm64"],
    ["darwin", "x64"],
    ["linux", "arm64"],
    ["win32", "arm64"],
  ]) {
    setPlatformArch(platform, arch);
    const manager = loadLlamaCudaManager(userDataDir);
    assert.equal(manager.isSupported(), false, `${platform}-${arch} should not be supported`);
  }
});

// --- getBinaryPath / isDownloaded ------------------------------------------

test("getBinaryPath returns null for an unsupported platform", () => {
  setPlatformArch("darwin", "arm64");
  const manager = loadLlamaCudaManager(makeTempUserDataDir());
  assert.equal(manager.getBinaryPath(), null);
  assert.equal(manager.isDownloaded(), false);
});

test("getBinaryPath returns null when the binary has not been downloaded", () => {
  setPlatformArch("win32", "x64");
  const manager = loadLlamaCudaManager(makeTempUserDataDir());
  assert.equal(manager.getBinaryPath(), null);
  assert.equal(manager.isDownloaded(), false);
});

test("getBinaryPath resolves once the output binary exists in binDir", () => {
  setPlatformArch("win32", "x64");
  const userDataDir = makeTempUserDataDir();
  const manager = loadLlamaCudaManager(userDataDir);

  fs.mkdirSync(manager.binDir, { recursive: true });
  const expectedPath = path.join(manager.binDir, "llama-server-cuda.exe");
  fs.writeFileSync(expectedPath, "binary");

  assert.equal(manager.getBinaryPath(), expectedPath);
  assert.equal(manager.isDownloaded(), true);
});

// --- getStatus --------------------------------------------------------

test("getStatus reflects supported/downloaded/downloading flags", () => {
  setPlatformArch("win32", "x64");
  const userDataDir = makeTempUserDataDir();
  const manager = loadLlamaCudaManager(userDataDir);

  assert.deepEqual(manager.getStatus(), {
    supported: true,
    downloaded: false,
    downloading: false,
  });

  fs.mkdirSync(manager.binDir, { recursive: true });
  fs.writeFileSync(path.join(manager.binDir, "llama-server-cuda.exe"), "binary");
  manager._downloading = true;

  assert.deepEqual(manager.getStatus(), {
    supported: true,
    downloaded: true,
    downloading: true,
  });
});

// --- download() guards --------------------------------------------------

test("download() rejects when a download is already in progress", async () => {
  setPlatformArch("win32", "x64");
  const manager = loadLlamaCudaManager(makeTempUserDataDir());
  manager._downloading = true;

  await assert.rejects(() => manager.download(), /Download already in progress/);
});

test("download() rejects on an unsupported platform", async () => {
  setPlatformArch("darwin", "arm64");
  const manager = loadLlamaCudaManager(makeTempUserDataDir());

  await assert.rejects(() => manager.download(), /CUDA not available for this platform/);
});

// --- cancelDownload -----------------------------------------------------

test("cancelDownload returns false when nothing is downloading", () => {
  const manager = loadLlamaCudaManager(makeTempUserDataDir());
  assert.equal(manager.cancelDownload(), false);
});

test("cancelDownload aborts the active signal and clears it", () => {
  const manager = loadLlamaCudaManager(makeTempUserDataDir());
  let aborted = false;
  manager._downloadSignal = { abort: () => (aborted = true) };

  assert.equal(manager.cancelDownload(), true);
  assert.equal(aborted, true);
  assert.equal(manager._downloadSignal, null);
});

// --- deleteBinary -----------------------------------------------------

test("deleteBinary removes the output binary and matching shared libs", async () => {
  setPlatformArch("win32", "x64");
  const userDataDir = makeTempUserDataDir();
  const manager = loadLlamaCudaManager(userDataDir);

  fs.mkdirSync(manager.binDir, { recursive: true });
  fs.writeFileSync(path.join(manager.binDir, "llama-server-cuda.exe"), "binary");
  fs.writeFileSync(path.join(manager.binDir, "cublas64.dll"), "lib");
  fs.writeFileSync(path.join(manager.binDir, "unrelated.txt"), "keep me");

  const result = await manager.deleteBinary();

  assert.deepEqual(result, { success: true, deletedCount: 2 });
  const remaining = fs.readdirSync(manager.binDir);
  assert.deepEqual(remaining, ["unrelated.txt"]);
});

test("deleteBinary is a no-op success on an unsupported platform", async () => {
  setPlatformArch("darwin", "arm64");
  const manager = loadLlamaCudaManager(makeTempUserDataDir());

  const result = await manager.deleteBinary();
  assert.deepEqual(result, { success: true });
});
