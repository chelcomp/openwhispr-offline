const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ektoswhispr-calendar-migration-db-"));
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

// The 20 database.js methods removed by docs/specs/remove-dead-google-calendar-code.md (R2):
// 18 fully-dead Google Calendar methods + getActiveEvents/getCalendarEventById (uncalled after R1).
const REMOVED_METHOD_NAMES = [
  "saveGoogleTokens",
  "getGoogleTokens",
  "getGoogleTokensByEmail",
  "getAllGoogleTokens",
  "getGoogleAccounts",
  "removeGoogleAccount",
  "deleteGoogleTokens",
  "saveGoogleCalendars",
  "applyPrimaryOnlyToSelection",
  "getGoogleCalendars",
  "updateCalendarSelection",
  "getSelectedCalendars",
  "upsertCalendarEvents",
  "getUpcomingEvents",
  "getNoteByCalendarEventId",
  "clearCalendarData",
  "updateCalendarSyncToken",
  "removeCalendarEvents",
  "removeEventsFromDeselectedCalendars",
  "getActiveEvents",
  "getCalendarEventById",
];

function dbFilePath(dir) {
  // NODE_ENV === "test" (not "development"), so initDatabase() uses "transcriptions.db".
  return path.join(dir, "transcriptions.db");
}

function createFreshDir() {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ektoswhispr-calendar-migration-db-"));
  return userDataDir;
}

function seedLegacyCalendarTables(dir, t) {
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

  raw.exec(`
    CREATE TABLE google_calendar_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      google_email TEXT NOT NULL UNIQUE,
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      scope TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  raw
    .prepare(
      "INSERT INTO google_calendar_tokens (google_email, access_token, refresh_token, expires_at, scope) VALUES (?, ?, ?, ?, ?)"
    )
    .run("fake@example.com", "fake-access-token", "fake-refresh-token", 9999999999, "calendar.readonly");

  raw.exec(`
    CREATE TABLE google_calendars (
      id TEXT PRIMARY KEY,
      summary TEXT NOT NULL,
      description TEXT,
      background_color TEXT,
      is_selected INTEGER NOT NULL DEFAULT 1,
      sync_token TEXT,
      account_email TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  raw
    .prepare("INSERT INTO google_calendars (id, summary, account_email) VALUES (?, ?, ?)")
    .run("fake-calendar-1", "Fake Calendar", "fake@example.com");

  raw.exec(`
    CREATE TABLE calendar_events (
      id TEXT PRIMARY KEY,
      calendar_id TEXT NOT NULL,
      summary TEXT,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      is_all_day INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'confirmed',
      hangout_link TEXT,
      conference_data TEXT,
      organizer_email TEXT,
      attendees_count INTEGER DEFAULT 0,
      synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  raw
    .prepare(
      "INSERT INTO calendar_events (id, calendar_id, summary, start_time, end_time) VALUES (?, ?, ?, ?, ?)"
    )
    .run(
      "fake-event-1",
      "fake-calendar-1",
      "Fake Event",
      "2026-01-01T10:00:00.000Z",
      "2026-01-01T11:00:00.000Z"
    );

  raw.close();
  return dbPath;
}

function tableExists(dbPath, tableName) {
  const BetterSqlite = require("better-sqlite3");
  const raw = new BetterSqlite(dbPath);
  try {
    const row = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName);
    return !!row;
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

test("initDatabase() drops the 3 legacy Google Calendar tables for existing installs", (t) => {
  const dir = createFreshDir();
  const dbPath = seedLegacyCalendarTables(dir, t);
  if (!dbPath) return;

  assert.equal(tableExists(dbPath, "google_calendar_tokens"), true);
  assert.equal(tableExists(dbPath, "google_calendars"), true);
  assert.equal(tableExists(dbPath, "calendar_events"), true);

  const dbManager = constructDbManager(t);
  if (!dbManager) return;

  assert.equal(tableExists(dbPath, "google_calendar_tokens"), false);
  assert.equal(tableExists(dbPath, "google_calendars"), false);
  assert.equal(tableExists(dbPath, "calendar_events"), false);

  dbManager.db.close();
});

test("the DROP TABLE IF EXISTS migration is idempotent across repeated boots", (t) => {
  const dir = createFreshDir();
  const dbPath = seedLegacyCalendarTables(dir, t);
  if (!dbPath) return;

  const first = constructDbManager(t);
  if (!first) return;
  first.db.close();

  // Re-construct against the same file — must not throw, tables must stay absent.
  assert.doesNotThrow(() => {
    const second = constructDbManager(t);
    if (second) second.db.close();
  });

  assert.equal(tableExists(dbPath, "google_calendar_tokens"), false);
  assert.equal(tableExists(dbPath, "google_calendars"), false);
  assert.equal(tableExists(dbPath, "calendar_events"), false);
});

test("unrelated notes-table columns/methods survive the migration untouched", (t) => {
  createFreshDir();
  const dbManager = constructDbManager(t);
  if (!dbManager) return;

  const noteResult = dbManager.saveNote("Test note", "content", "personal");
  assert.ok(noteResult?.note?.id);

  // notes.calendar_event_id / notes.participants remain live columns (R2 Non-goals).
  const updateResult = dbManager.updateNote(noteResult.note.id, {
    calendar_event_id: "some-event-id",
    participants: "[]",
  });
  assert.equal(updateResult.success, true);
  assert.equal(updateResult.note.calendar_event_id, "some-event-id");
  assert.equal(updateResult.note.participants, "[]");

  dbManager.db.close();
});

test("all 20 removed Google Calendar methods are gone from DatabaseManager.prototype", () => {
  for (const name of REMOVED_METHOD_NAMES) {
    assert.equal(
      typeof DatabaseManager.prototype[name],
      "undefined",
      `DatabaseManager.prototype.${name} should not exist`
    );
  }
});
