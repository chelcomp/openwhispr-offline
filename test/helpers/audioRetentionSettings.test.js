const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const fs = require("fs");
const Module = require("module");

// Mock electron and the OS keyring before environment.js loads, so this test
// never touches the developer's real userData folder or keychain.
// saveAudioRetentionDays()/saveAllKeysToEnvFile() reload the freshly-written
// .env via dotenv — quiet mode suppresses dotenv's promotional "tip" stdout
// writes, which otherwise race with (and can corrupt) node:test's own
// message-passing protocol when this file runs as part of a larger suite.
process.env.DOTENV_CONFIG_QUIET = "true";
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), "ow-audio-retention-test-"));
process.resourcesPath = tmpUserData;
const fakeElectron = {
  app: { getPath: () => tmpUserData },
  safeStorage: { isEncryptionAvailable: () => false },
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") return fakeElectron;
  if (request === "@napi-rs/keyring") throw new Error("keyring disabled in tests");
  return origLoad.call(this, request, ...rest);
};

const EnvironmentManager = require("../../src/helpers/environment");

test("getAudioRetentionDays falls back to 0 when never persisted", () => {
  const env = new EnvironmentManager();
  delete process.env.AUDIO_RETENTION_DAYS;
  assert.equal(env.getAudioRetentionDays(), 0);
});

test("hasAudioRetentionDaysBeenSet is false until a value is saved", () => {
  const env = new EnvironmentManager();
  delete process.env.AUDIO_RETENTION_DAYS;
  assert.equal(env.hasAudioRetentionDaysBeenSet(), false);

  env.saveAudioRetentionDays(0);
  assert.equal(
    env.hasAudioRetentionDaysBeenSet(),
    true,
    "an explicit save of 0 still counts as 'has been set', distinct from never-set"
  );
});

test("saveAudioRetentionDays round-trips a configured value", () => {
  const env = new EnvironmentManager();
  const result = env.saveAudioRetentionDays(7);
  assert.equal(result.success, true);
  assert.equal(result.days, 7);
  assert.equal(env.getAudioRetentionDays(), 7);
  assert.equal(process.env.AUDIO_RETENTION_DAYS, "7");
});

test("saveAudioRetentionDays normalizes negative/non-finite input to 0", () => {
  const env = new EnvironmentManager();
  env.saveAudioRetentionDays(-5);
  assert.equal(env.getAudioRetentionDays(), 0);
  assert.equal(process.env.AUDIO_RETENTION_DAYS, "0");

  env.saveAudioRetentionDays(NaN);
  assert.equal(env.getAudioRetentionDays(), 0);
});

test("saveAudioRetentionDays floors fractional input", () => {
  const env = new EnvironmentManager();
  env.saveAudioRetentionDays(7.9);
  assert.equal(env.getAudioRetentionDays(), 7);
});

test("getAudioRetentionDays normalizes a malformed persisted value (hand-edited .env) to the 0 fallback", () => {
  const env = new EnvironmentManager();
  process.env.AUDIO_RETENTION_DAYS = "not-a-number";
  assert.equal(env.getAudioRetentionDays(), 0);

  process.env.AUDIO_RETENTION_DAYS = "-3";
  assert.equal(env.getAudioRetentionDays(), 0);
});
