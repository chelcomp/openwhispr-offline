const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const fs = require("fs");
const Module = require("module");

// Mock electron before audioStorage.js / meetingAudioStorage.js load, so
// app.getPath("userData") resolves to a throwaway temp directory instead of
// touching the developer's real userData folder.
let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-audio-storage-test-"));
const fakeElectron = {
  app: { getPath: (name) => (name === "userData" ? userDataDir : userDataDir) },
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") return fakeElectron;
  return origLoad.call(this, request, ...rest);
};

const AudioStorageManager = require("../../src/helpers/audioStorage");
// meetingAudioStorage resolves and caches its storage directory (from
// app.getPath("userData")) the first time any of its functions run, so —
// unlike AudioStorageManager, which is re-instantiated per test — reassigning
// `userDataDir` after that first call would NOT change where it reads/writes.
// Its tests below share one fixed directory and clear it between runs instead.
const meetingAudioStorage = require("../../src/helpers/meetingAudioStorage");

const DAY_MS = 86400000;

function resetUserDataDir() {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-audio-storage-test-"));
}

function touchFile(filePath, ageDays) {
  fs.writeFileSync(filePath, "fake-audio-data");
  // Always back-date by at least 1s, even for "just created" (ageDays: 0)
  // fixtures — otherwise the file's mtime and the cleanup call's cutoff
  // (Date.now(), computed a moment later) can land in the same millisecond,
  // making the `mtimeMs < cutoffMs` comparison a coin-flip tie instead of a
  // deterministic "older than cutoff."
  const ageMs = Math.max(ageDays * DAY_MS, 1000);
  const mtime = new Date(Date.now() - ageMs);
  fs.utimesSync(filePath, mtime, mtime);
}

function clearWebmFiles(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith(".webm")) fs.unlinkSync(path.join(dir, f));
  }
}

test("dictation audio: configured (non-30) retention honors that cutoff, not the old hardcoded 30", () => {
  resetUserDataDir();
  const manager = new AudioStorageManager();
  const oldFile = path.join(manager.audioDir, "EktosWhispr-old-1.webm");
  const newFile = path.join(manager.audioDir, "EktosWhispr-new-2.webm");
  touchFile(oldFile, 10); // older than a 7-day cutoff
  touchFile(newFile, 2); // newer than a 7-day cutoff

  const result = manager.cleanupExpiredAudio(7, null);

  assert.equal(result.deleted, 1);
  assert.equal(result.kept, 1);
  assert.equal(fs.existsSync(oldFile), false, "file older than the configured cutoff is deleted");
  assert.equal(fs.existsSync(newFile), true, "file newer than the configured cutoff survives");
});

test("dictation audio: retention 0 deletes ALL files, including ones created moments ago", () => {
  resetUserDataDir();
  const manager = new AudioStorageManager();
  const freshFile = path.join(manager.audioDir, "EktosWhispr-fresh-3.webm");
  touchFile(freshFile, 0);

  const result = manager.cleanupExpiredAudio(0, null);

  assert.equal(result.deleted, 1);
  assert.equal(fs.existsSync(freshFile), false, "0 means delete everything, not keep forever");
});

test("dictation audio: invalid retention (negative) deletes nothing, even very old files", () => {
  resetUserDataDir();
  const manager = new AudioStorageManager();
  const veryOldFile = path.join(manager.audioDir, "EktosWhispr-veryold-4.webm");
  touchFile(veryOldFile, 400);

  const result = manager.cleanupExpiredAudio(-5, null);

  assert.equal(result.deleted, 0);
  assert.equal(fs.existsSync(veryOldFile), true, "invalid input must not be conflated with 0");
});

test("dictation audio: invalid retention (NaN) deletes nothing", () => {
  resetUserDataDir();
  const manager = new AudioStorageManager();
  const veryOldFile = path.join(manager.audioDir, "EktosWhispr-veryold-5.webm");
  touchFile(veryOldFile, 400);

  const result = manager.cleanupExpiredAudio(NaN, null);

  assert.equal(result.deleted, 0);
  assert.equal(fs.existsSync(veryOldFile), true);
});

test("meeting audio: cleanupExpiredAudio no longer exists — automatic purge must stay removed per CLAUDE.md §7", () => {
  // Tripwire: meeting audio must never be auto-purged by age/retention again.
  // If a future change re-adds cleanupExpiredAudio (even without wiring it
  // back into _setupAudioCleanup()), this forces a conscious decision rather
  // than a silent reintroduction of the removed behavior.
  assert.equal(meetingAudioStorage.cleanupExpiredAudio, undefined);
  assert.equal(typeof meetingAudioStorage.getAudioPath, "function");
  assert.equal(typeof meetingAudioStorage.deleteAudio, "function");
  assert.equal(typeof meetingAudioStorage.getStorageUsage, "function");
  assert.equal(typeof meetingAudioStorage.saveAudio, "function");
  assert.equal(typeof meetingAudioStorage.deleteAllMeetingAudio, "function");
});

test("meeting audio: deleteAllMeetingAudio removes all files unconditionally, regardless of age", () => {
  const dir = path.join(userDataDir, "meeting-audio");
  clearWebmFiles(dir);
  const oldFile = path.join(dir, "note-6-old.webm");
  const freshFile = path.join(dir, "note-7-fresh.webm");
  touchFile(oldFile, 400);
  touchFile(freshFile, 0);

  const result = meetingAudioStorage.deleteAllMeetingAudio();

  assert.deepEqual(result, { deleted: 2 });
  assert.equal(fs.existsSync(oldFile), false, "old file is deleted");
  assert.equal(fs.existsSync(freshFile), false, "fresh file is deleted too — unconditional, not age-based");
});
