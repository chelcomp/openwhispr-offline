const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Mirrors test/helpers/llamaCudaManager.test.js's structure — same
// Module._load-based electron mock providing a temp app.getPath("userData")
// directory per test. isSupported() is not platform-gated here (Tesseract's
// WASM runtime is expected to report true universally), so no
// setPlatformArch fixture is needed.

const tesseractOcrManagerPath = require.resolve("../../src/helpers/tesseractOcrManager");
const originalLoad = Module._load;

function loadTesseractOcrManager(userDataDir) {
  delete require.cache[tesseractOcrManagerPath];

  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "electron") {
      return { app: { getPath: () => userDataDir } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const TesseractOcrManager = require("../../src/helpers/tesseractOcrManager");
    return new TesseractOcrManager();
  } finally {
    Module._load = originalLoad;
  }
}

function makeTempUserDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ektoswhispr-tesseract-test-"));
}

test("isSupported is true universally (WASM, no platform gating)", () => {
  const manager = loadTesseractOcrManager(makeTempUserDataDir());
  assert.equal(manager.isSupported(), true);
});

test("isDownloaded is false before any asset files exist", () => {
  const manager = loadTesseractOcrManager(makeTempUserDataDir());
  assert.equal(manager.isDownloaded(), false);
});

test("isDownloaded is true once all expected asset files exist on disk", () => {
  const userDataDir = makeTempUserDataDir();
  const manager = loadTesseractOcrManager(userDataDir);

  fs.mkdirSync(manager.assetDir, { recursive: true });
  for (const p of manager.getAssetPaths()) {
    fs.writeFileSync(p, "fake-asset-bytes");
  }

  assert.equal(manager.isDownloaded(), true);
});

test("isDownloaded is false when only some of the required assets exist", () => {
  const userDataDir = makeTempUserDataDir();
  const manager = loadTesseractOcrManager(userDataDir);

  fs.mkdirSync(manager.assetDir, { recursive: true });
  fs.writeFileSync(manager.getAssetPaths()[0], "fake-asset-bytes");

  assert.equal(manager.isDownloaded(), false);
});

test("getStatus reflects supported/downloaded/downloading flags", () => {
  const userDataDir = makeTempUserDataDir();
  const manager = loadTesseractOcrManager(userDataDir);

  assert.deepEqual(manager.getStatus(), {
    supported: true,
    downloaded: false,
    downloading: false,
  });

  fs.mkdirSync(manager.assetDir, { recursive: true });
  for (const p of manager.getAssetPaths()) {
    fs.writeFileSync(p, "fake-asset-bytes");
  }
  manager._downloading = true;

  assert.deepEqual(manager.getStatus(), {
    supported: true,
    downloaded: true,
    downloading: true,
  });
});

test("download() rejects when a download is already in progress", async () => {
  const manager = loadTesseractOcrManager(makeTempUserDataDir());
  manager._downloading = true;

  await assert.rejects(() => manager.download(), /Download already in progress/);
});

test("download()'s disk-space pre-check rejects before any network call when space is insufficient", async () => {
  // Mutate downloadUtils's exports BEFORE (re-)requiring tesseractOcrManager,
  // since it destructures checkDiskSpace/downloadFile at require-time —
  // mutating after the fact wouldn't be observed by an already-captured
  // reference.
  const downloadUtils = require("../../src/helpers/downloadUtils");
  const originalCheckDiskSpace = downloadUtils.checkDiskSpace;
  const originalDownloadFile = downloadUtils.downloadFile;
  let downloadFileCalls = 0;
  downloadUtils.checkDiskSpace = async () => ({ ok: false, availableBytes: 0 });
  downloadUtils.downloadFile = async () => {
    downloadFileCalls++;
  };

  try {
    const manager = loadTesseractOcrManager(makeTempUserDataDir());
    await assert.rejects(() => manager.download(), /disk space/i);
    assert.equal(
      downloadFileCalls,
      0,
      "downloadFile must never be called after a failed disk check"
    );
  } finally {
    downloadUtils.checkDiskSpace = originalCheckDiskSpace;
    downloadUtils.downloadFile = originalDownloadFile;
  }
});

test("cancelDownload returns false when nothing is downloading", () => {
  const manager = loadTesseractOcrManager(makeTempUserDataDir());
  assert.equal(manager.cancelDownload(), false);
});

test("cancelDownload aborts the active signal and clears it", () => {
  const manager = loadTesseractOcrManager(makeTempUserDataDir());
  let aborted = false;
  manager._downloadSignal = { abort: () => (aborted = true) };

  assert.equal(manager.cancelDownload(), true);
  assert.equal(aborted, true);
  assert.equal(manager._downloadSignal, null);
});

test("deleteAssets removes the downloaded asset files and reports the count", async () => {
  const userDataDir = makeTempUserDataDir();
  const manager = loadTesseractOcrManager(userDataDir);

  fs.mkdirSync(manager.assetDir, { recursive: true });
  for (const p of manager.getAssetPaths()) {
    fs.writeFileSync(p, "fake-asset-bytes");
  }

  const result = await manager.deleteAssets();
  assert.deepEqual(result, { success: true, deletedCount: 2 });
  assert.equal(manager.isDownloaded(), false);
});

test("deleteAssets is a no-op success when nothing was ever downloaded", async () => {
  const manager = loadTesseractOcrManager(makeTempUserDataDir());
  const result = await manager.deleteAssets();
  assert.deepEqual(result, { success: true, deletedCount: 0 });
});
