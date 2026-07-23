const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const fs = require("fs");
const Module = require("module");

// Mirrors test/helpers/audioStorage.test.js's fixture/temp-dir setup pattern,
// applied to ScreenContextStorageManager's PNG-based artifact.
let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-screen-context-storage-test-"));
const fakeElectron = {
  app: { getPath: () => userDataDir },
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") return fakeElectron;
  return origLoad.call(this, request, ...rest);
};

const ScreenContextStorageManager = require("../../src/helpers/screenContextStorage");

const DAY_MS = 86400000;

function resetUserDataDir() {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-screen-context-storage-test-"));
}

function touchFile(filePath, ageDays) {
  fs.writeFileSync(filePath, "fake-png-data");
  const ageMs = Math.max(ageDays * DAY_MS, 1000);
  const mtime = new Date(Date.now() - ageMs);
  fs.utimesSync(filePath, mtime, mtime);
}

test("saveScreenshot writes a PNG file to disk and returns success + path", () => {
  resetUserDataDir();
  const manager = new ScreenContextStorageManager();
  const result = manager.saveScreenshot(Buffer.from("fake-png-bytes"), Date.now());
  assert.equal(result.success, true);
  assert.equal(fs.existsSync(result.path), true);
  assert.ok(fs.statSync(result.path).size > 0);
});

test("cleanupExpiredScreenshots(0) deletes ALL files, including ones created moments ago", () => {
  resetUserDataDir();
  const manager = new ScreenContextStorageManager();
  manager.ensureCaptureDir();
  const freshFile = path.join(manager.captureDir, "fresh.png");
  touchFile(freshFile, 0);

  const result = manager.cleanupExpiredScreenshots(0);

  assert.equal(result.deleted, 1);
  assert.equal(fs.existsSync(freshFile), false, "0 means delete everything, not disabled");
});

test("cleanupExpiredScreenshots(7) honors that cutoff", () => {
  resetUserDataDir();
  const manager = new ScreenContextStorageManager();
  manager.ensureCaptureDir();
  const oldFile = path.join(manager.captureDir, "old.png");
  const newFile = path.join(manager.captureDir, "new.png");
  touchFile(oldFile, 10);
  touchFile(newFile, 2);

  const result = manager.cleanupExpiredScreenshots(7);

  assert.equal(result.deleted, 1);
  assert.equal(result.kept, 1);
  assert.equal(fs.existsSync(oldFile), false);
  assert.equal(fs.existsSync(newFile), true);
});

test("cleanupExpiredScreenshots skips the tick entirely for invalid values (negative, NaN, Infinity)", () => {
  resetUserDataDir();
  const manager = new ScreenContextStorageManager();
  manager.ensureCaptureDir();
  const veryOldFile = path.join(manager.captureDir, "veryold.png");
  touchFile(veryOldFile, 400);

  for (const invalid of [-5, NaN, Infinity]) {
    const result = manager.cleanupExpiredScreenshots(invalid);
    assert.equal(result.deleted, 0);
    assert.equal(
      fs.existsSync(veryOldFile),
      true,
      `invalid value ${invalid} must not delete anything`
    );
  }
});

test("deleteAllScreenshots removes every file regardless of age and returns the count", () => {
  resetUserDataDir();
  const manager = new ScreenContextStorageManager();
  manager.ensureCaptureDir();
  touchFile(path.join(manager.captureDir, "a.png"), 400);
  touchFile(path.join(manager.captureDir, "b.png"), 0);

  const result = manager.deleteAllScreenshots();

  assert.equal(result.deleted, 2);
  assert.equal(fs.readdirSync(manager.captureDir).filter((f) => f.endsWith(".png")).length, 0);
});

test("getStorageUsage reports accurate fileCount/totalBytes", () => {
  resetUserDataDir();
  const manager = new ScreenContextStorageManager();
  manager.ensureCaptureDir();
  fs.writeFileSync(path.join(manager.captureDir, "a.png"), Buffer.alloc(100));
  fs.writeFileSync(path.join(manager.captureDir, "b.png"), Buffer.alloc(50));

  const usage = manager.getStorageUsage();
  assert.equal(usage.fileCount, 2);
  assert.equal(usage.totalBytes, 150);
});

test("getStorageUsage returns zero usage when the directory has never been created", () => {
  resetUserDataDir();
  const manager = new ScreenContextStorageManager();
  const usage = manager.getStorageUsage();
  assert.deepEqual(usage, { fileCount: 0, totalBytes: 0 });
});

test("cleanupExpiredScreenshots no-ops (not an error) when the directory has never been created", () => {
  resetUserDataDir();
  const manager = new ScreenContextStorageManager();
  const result = manager.cleanupExpiredScreenshots(30);
  assert.deepEqual(result, { deleted: 0, kept: 0 });
});
