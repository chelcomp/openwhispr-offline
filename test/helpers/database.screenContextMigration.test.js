const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

// Covers Requirement 14 / Premise #6's migration-safety bar for the new
// `screen_context_text` column (docs/specs/active-window-screen-context.md).
// Mirrors databaseCalendarMigration.test.js's fixture/skip-if-native-binding
// pattern.

let userDataDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "ektoswhispr-screen-context-migration-db-")
);
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
    message.includes("NODE_MODULE_VERSION") ||
    message.includes("Could not locate the bindings file")
  );
}

function dbFilePath(dir) {
  return path.join(dir, "transcriptions.db");
}

function createFreshDir() {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ektoswhispr-screen-context-migration-db-"));
  return userDataDir;
}

function seedPreMigrationSchema(dir, t) {
  let BetterSqlite;
  try {
    BetterSqlite = require("better-sqlite3");
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }

  const dbPath = dbFilePath(dir);
  let raw;
  try {
    raw = new BetterSqlite(dbPath);
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }

  // Pre-migration schema: no screen_context_text column at all.
  raw.exec(`
    CREATE TABLE transcriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      raw_text TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  raw
    .prepare("INSERT INTO transcriptions (text, raw_text) VALUES (?, ?)")
    .run("Hello world", "hello world raw");
  raw
    .prepare("INSERT INTO transcriptions (text, raw_text) VALUES (?, ?)")
    .run("Second entry", "second entry raw");

  raw.close();
  return dbPath;
}

function columnExists(dbPath, table, column) {
  const BetterSqlite = require("better-sqlite3");
  const raw = new BetterSqlite(dbPath);
  try {
    const columns = raw.prepare(`PRAGMA table_info(${table})`).all();
    return columns.some((c) => c.name === column);
  } finally {
    raw.close();
  }
}

function constructDbManager(t) {
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

test("migration adds screen_context_text without error and preserves existing rows", (t) => {
  const dir = createFreshDir();
  const dbPath = seedPreMigrationSchema(dir, t);
  if (!dbPath) return;

  assert.equal(columnExists(dbPath, "transcriptions", "screen_context_text"), false);

  const dbManager = constructDbManager(t);
  if (!dbManager) return;

  assert.equal(columnExists(dbPath, "transcriptions", "screen_context_text"), true);

  const rows = dbManager.db.prepare("SELECT * FROM transcriptions ORDER BY id ASC").all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].text, "Hello world");
  assert.equal(rows[0].raw_text, "hello world raw");
  assert.equal(rows[0].screen_context_text, null);
  assert.equal(rows[1].text, "Second entry");
  assert.equal(rows[1].screen_context_text, null);

  dbManager.db.close();
});

test("a freshly inserted row with screen context text round-trips through write and read paths", (t) => {
  createFreshDir();
  const dbManager = constructDbManager(t);
  if (!dbManager) return;

  const insertResult = dbManager.saveTranscription("Cleaned text", "Raw text");
  dbManager.updateTranscriptionScreenContext(insertResult.id, "OCR'd screen text here");

  const rows = dbManager.getTranscriptions();
  const row = rows.find((r) => r.id === insertResult.id);
  assert.equal(row.screen_context_text, "OCR'd screen text here");

  dbManager.db.close();
});

test("running the migration a second time against an already-migrated database is a no-op", (t) => {
  const dir = createFreshDir();
  const first = constructDbManager(t);
  if (!first) return;
  first.db.close();

  assert.doesNotThrow(() => {
    const second = constructDbManager(t);
    if (second) second.db.close();
  });

  assert.equal(columnExists(dbFilePath(dir), "transcriptions", "screen_context_text"), true);
});
