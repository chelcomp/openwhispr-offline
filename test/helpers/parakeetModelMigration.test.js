const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const fs = require("fs");
const Module = require("module");

const load = () => import("../../src/helpers/parakeetModelMigration.js");

test("removed model IDs are rewritten to the default offline model", async () => {
  const { resolveMigratedParakeetModelId, REMOVED_PARAKEET_MODEL_IDS, DEFAULT_PARAKEET_MODEL_ID } =
    await load();

  for (const removedId of REMOVED_PARAKEET_MODEL_IDS) {
    assert.equal(resolveMigratedParakeetModelId(removedId), DEFAULT_PARAKEET_MODEL_ID);
  }
});

test("already-valid model IDs are left untouched", async () => {
  const { resolveMigratedParakeetModelId } = await load();

  assert.equal(resolveMigratedParakeetModelId("parakeet-tdt-0.6b-v3"), "parakeet-tdt-0.6b-v3");
  assert.equal(
    resolveMigratedParakeetModelId("parakeet-unified-en-0.6b"),
    "parakeet-unified-en-0.6b"
  );
  assert.equal(resolveMigratedParakeetModelId(""), "");
  assert.equal(resolveMigratedParakeetModelId(undefined), undefined);
  assert.equal(resolveMigratedParakeetModelId(null), null);
});

test("running the migration twice is idempotent", async () => {
  const { resolveMigratedParakeetModelId, DEFAULT_PARAKEET_MODEL_ID } = await load();

  const once = resolveMigratedParakeetModelId("nemotron-speech-streaming-en-0.6b");
  const twice = resolveMigratedParakeetModelId(once);
  assert.equal(once, DEFAULT_PARAKEET_MODEL_ID);
  assert.equal(twice, DEFAULT_PARAKEET_MODEL_ID);
});

// Mock electron before environment.js loads, so this test never touches the
// developer's real userData folder or keychain.
process.env.DOTENV_CONFIG_QUIET = "true";
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), "ow-parakeet-migration-test-"));
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

test("environment.js migrates a removed PARAKEET_MODEL .env value on construction", () => {
  process.env.PARAKEET_MODEL = "nemotron-3.5-asr-streaming-0.6b-1120ms";
  new EnvironmentManager();
  assert.equal(process.env.PARAKEET_MODEL, "parakeet-tdt-0.6b-v3");
  delete process.env.PARAKEET_MODEL;
});

test("environment.js leaves an already-valid PARAKEET_MODEL untouched", () => {
  process.env.PARAKEET_MODEL = "parakeet-unified-en-0.6b";
  new EnvironmentManager();
  assert.equal(process.env.PARAKEET_MODEL, "parakeet-unified-en-0.6b");
  delete process.env.PARAKEET_MODEL;
});

test("environment.js migration is idempotent across repeated construction", () => {
  process.env.PARAKEET_MODEL = "nemotron-speech-streaming-en-0.6b";
  new EnvironmentManager();
  new EnvironmentManager();
  assert.equal(process.env.PARAKEET_MODEL, "parakeet-tdt-0.6b-v3");
  delete process.env.PARAKEET_MODEL;
});
