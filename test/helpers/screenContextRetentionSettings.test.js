const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const fs = require("fs");
const Module = require("module");

// Mirrors test/helpers/audioRetentionSettings.test.js exactly, targeting the
// new getScreenContextRetentionDays()/saveScreenContextRetentionDays()/
// hasScreenContextRetentionDaysBeenSet() trio and SCREEN_CONTEXT_RETENTION_DAYS
// env var (see docs/specs/active-window-screen-context.md).
process.env.DOTENV_CONFIG_QUIET = "true";
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), "ow-screen-context-retention-test-"));
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

test("getScreenContextRetentionDays falls back to 0 when never persisted", () => {
  const env = new EnvironmentManager();
  delete process.env.SCREEN_CONTEXT_RETENTION_DAYS;
  assert.equal(env.getScreenContextRetentionDays(), 0);
});

test("hasScreenContextRetentionDaysBeenSet is false until a value is saved", () => {
  const env = new EnvironmentManager();
  delete process.env.SCREEN_CONTEXT_RETENTION_DAYS;
  assert.equal(env.hasScreenContextRetentionDaysBeenSet(), false);

  env.saveScreenContextRetentionDays(0);
  assert.equal(
    env.hasScreenContextRetentionDaysBeenSet(),
    true,
    "an explicit save of 0 still counts as 'has been set', distinct from never-set"
  );
});

test("saveScreenContextRetentionDays round-trips a configured value", () => {
  const env = new EnvironmentManager();
  const result = env.saveScreenContextRetentionDays(7);
  assert.equal(result.success, true);
  assert.equal(result.days, 7);
  assert.equal(env.getScreenContextRetentionDays(), 7);
  assert.equal(process.env.SCREEN_CONTEXT_RETENTION_DAYS, "7");
});

test("saveScreenContextRetentionDays normalizes negative/non-finite input to 0", () => {
  const env = new EnvironmentManager();
  env.saveScreenContextRetentionDays(-5);
  assert.equal(env.getScreenContextRetentionDays(), 0);
  assert.equal(process.env.SCREEN_CONTEXT_RETENTION_DAYS, "0");

  env.saveScreenContextRetentionDays(NaN);
  assert.equal(env.getScreenContextRetentionDays(), 0);
});

test("saveScreenContextRetentionDays floors fractional input", () => {
  const env = new EnvironmentManager();
  env.saveScreenContextRetentionDays(7.9);
  assert.equal(env.getScreenContextRetentionDays(), 7);
});

test("getScreenContextRetentionDays normalizes a malformed persisted value (hand-edited .env) to the 0 fallback", () => {
  const env = new EnvironmentManager();
  process.env.SCREEN_CONTEXT_RETENTION_DAYS = "not-a-number";
  assert.equal(env.getScreenContextRetentionDays(), 0);

  process.env.SCREEN_CONTEXT_RETENTION_DAYS = "-3";
  assert.equal(env.getScreenContextRetentionDays(), 0);
});

test("screenContextRetentionDays is independent of audioRetentionDays", () => {
  const env = new EnvironmentManager();
  env.saveAudioRetentionDays(30);
  env.saveScreenContextRetentionDays(0);
  assert.equal(env.getAudioRetentionDays(), 30);
  assert.equal(env.getScreenContextRetentionDays(), 0);
});
