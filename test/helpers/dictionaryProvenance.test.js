const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ektoswhispr-dict-provenance-db-"));
const originalLoad = Module._load;

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: {
        getPath: () => userDataDir,
        getAppPath: () => process.cwd(),
        isReady: () => false,
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

process.env.NODE_ENV = "test";

const DatabaseManager = require("../../src/helpers/database.js");

function isNativeBindingUnavailable(error) {
  const message = String(error?.message || error);
  return (
    message.includes("NODE_MODULE_VERSION") || message.includes("Could not locate the bindings file")
  );
}

function createDb(t) {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ektoswhispr-dict-provenance-db-"));
  try {
    const BetterSqlite = require("better-sqlite3");
    const probe = new BetterSqlite(path.join(userDataDir, "probe.db"));
    probe.close();
    fs.rmSync(path.join(userDataDir, "probe.db"), { force: true });
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }

  try {
    return new DatabaseManager();
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }
}

test("setDictionary persists learned_from provenance only for newly-inserted learned words", (t) => {
  const db = createDb(t);
  if (!db) return;

  const provenance = new Map([["sinead", "Shunade"]]);
  db.setDictionary(["Sinead"], "learned", provenance);

  const rows = db.getDictionaryWithProvenance();
  const row = rows.find((r) => r.word === "Sinead");
  assert.ok(row, "expected Sinead row to exist");
  assert.equal(row.source, "learned");
  assert.equal(row.learned_from, "Shunade");
});

test("getPendingDictionary (the cloud-sync push payload) never exposes learned_from", (t) => {
  const db = createDb(t);
  if (!db) return;

  const provenance = new Map([["sinead", "Shunade"]]);
  db.setDictionary(["Sinead"], "learned", provenance);

  const pending = db.getPendingDictionary();
  const row = pending.find((r) => r.word === "Sinead");
  assert.ok(row, "expected the newly-learned word to be pending sync");
  assert.equal(
    Object.prototype.hasOwnProperty.call(row, "learned_from"),
    false,
    "learned_from must never be included in the cloud-sync push payload"
  );
});

test("manual additions never get learned_from populated, even if a provenance map is passed", (t) => {
  const db = createDb(t);
  if (!db) return;

  const provenance = new Map([["manualword", "ignored"]]);
  db.setDictionary(["ManualWord"], "manual", provenance);

  const rows = db.getDictionaryWithProvenance();
  const row = rows.find((r) => r.word === "ManualWord");
  assert.ok(row);
  assert.equal(row.source, "manual");
  assert.equal(row.learned_from, null);
});

test("existing setDictionary callers that omit the provenance argument are unaffected (back-compat)", (t) => {
  const db = createDb(t);
  if (!db) return;

  // Two-arg call, matching every pre-existing call site in the codebase.
  db.setDictionary(["hello", "world"], "manual");
  assert.deepEqual(db.getDictionary(), ["hello", "world"]);

  const rows = db.getDictionaryWithProvenance();
  assert.ok(rows.every((r) => r.learned_from === null));
});

test("promoting a learned word to manual clears its learned_from provenance", (t) => {
  const db = createDb(t);
  if (!db) return;

  const provenance = new Map([["sinead", "Shunade"]]);
  db.setDictionary(["Sinead"], "learned", provenance);

  let row = db.getDictionaryWithProvenance().find((r) => r.word === "Sinead");
  assert.equal(row.learned_from, "Shunade");

  // User manually re-saves/endorses the word — same word list, source now 'manual'.
  db.setDictionary(["Sinead"], "manual");

  row = db.getDictionaryWithProvenance().find((r) => r.word === "Sinead");
  assert.equal(row.source, "manual");
  assert.equal(row.learned_from, null);
});

test("migration safety: a pre-existing DB without learned_from upgrades without losing dictionary data", (t) => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ektoswhispr-dict-provenance-db-"));
  let legacyDb;
  try {
    const BetterSqlite = require("better-sqlite3");
    // Simulate a pre-upgrade DB: custom_dictionary table exists but predates the
    // learned_from column (and the other sync columns added over time).
    // Must match DatabaseManager's own filename resolution (transcriptions.db
    // outside development mode) so DatabaseManager opens this same pre-seeded file.
    const dbPath = path.join(userDataDir, "transcriptions.db");
    legacyDb = new BetterSqlite(dbPath);
    legacyDb.exec(`
      CREATE TABLE custom_dictionary (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        word TEXT NOT NULL UNIQUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    legacyDb.prepare("INSERT INTO custom_dictionary (word) VALUES (?)").run("legacyword");
    legacyDb.close();
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return;
    }
    throw error;
  }

  // Opening via DatabaseManager runs the additive migration path.
  const db = new DatabaseManager();
  assert.deepEqual(db.getDictionary(), ["legacyword"]);

  const rows = db.getDictionaryWithProvenance();
  const legacyRow = rows.find((r) => r.word === "legacyword");
  assert.ok(legacyRow, "pre-existing dictionary word must survive the upgrade");
  assert.equal(legacyRow.learned_from, null);

  // The new column is fully usable post-migration.
  const provenance = new Map([["newword", "oldword"]]);
  db.setDictionary(["legacyword", "newword"], "learned", provenance);
  const newRow = db.getDictionaryWithProvenance().find((r) => r.word === "newword");
  assert.equal(newRow.learned_from, "oldword");
});
