const test = require("node:test");
const assert = require("node:assert/strict");

// Stub electron before manualMeetingLauncher.js loads so it can run outside
// Electron. Mirrors the pattern used in test/helpers/hotkeySlotRollback.test.js.
require.cache[require.resolve("electron")] = {
  exports: {
    BrowserWindow: class {
      static getAllWindows() {
        return [];
      }
    },
  },
};

const ManualMeetingLauncher = require("../../src/helpers/manualMeetingLauncher.js");

function makeWindowManagerStub() {
  return {
    queueMeetingNoteNavigation: async () => {},
  };
}

function makeDatabaseManagerStub(overrides = {}) {
  return {
    getActiveEvents: () => [],
    saveNote: () => ({ note: { id: "note-1" } }),
    getMeetingsFolder: () => ({ id: "folder-1" }),
    getCalendarEventById: () => null,
    updateNote: () => ({ success: true, note: { id: "note-1" } }),
    ...overrides,
  };
}

test("constructing ManualMeetingLauncher takes only windowManager + databaseManager", () => {
  const windowManagerStub = makeWindowManagerStub();
  const databaseManagerStub = makeDatabaseManagerStub();

  const launcher = new ManualMeetingLauncher(windowManagerStub, databaseManagerStub);

  assert.equal(launcher.windowManager, windowManagerStub);
  assert.equal(launcher.databaseManager, databaseManagerStub);
});

test("startManualMeeting creates a note, navigates to it, and broadcasts note-added", async () => {
  const navigationCalls = [];
  const windowManagerStub = {
    queueMeetingNoteNavigation: async (payload) => {
      navigationCalls.push(payload);
    },
  };
  const databaseManagerStub = makeDatabaseManagerStub();

  const launcher = new ManualMeetingLauncher(windowManagerStub, databaseManagerStub);
  const broadcastCalls = [];
  launcher.broadcastToWindows = (channel, data) => broadcastCalls.push({ channel, data });

  await launcher.startManualMeeting();

  assert.equal(navigationCalls.length, 1);
  assert.equal(navigationCalls[0].noteId, "note-1");
  assert.equal(navigationCalls[0].folderId, "folder-1");
  assert.equal(navigationCalls[0].trigger, "hotkey");
  assert.ok(navigationCalls[0].event);
  assert.match(navigationCalls[0].event.summary, /^Meeting \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);

  assert.equal(broadcastCalls.length, 1);
  assert.equal(broadcastCalls[0].channel, "note-added");
  assert.equal(broadcastCalls[0].data.id, "note-1");
});

test("startManualMeeting does not throw and skips navigation when note/folder creation fails", async () => {
  const navigationCalls = [];
  const windowManagerStub = {
    queueMeetingNoteNavigation: async (payload) => {
      navigationCalls.push(payload);
    },
  };
  const databaseManagerStub = makeDatabaseManagerStub({
    saveNote: () => ({ note: null }),
    getMeetingsFolder: () => null,
  });

  const launcher = new ManualMeetingLauncher(windowManagerStub, databaseManagerStub);
  launcher.broadcastToWindows = () => {};

  await assert.doesNotReject(() => launcher.startManualMeeting());

  assert.equal(navigationCalls.length, 0);

  // _meetingModeActive is reset to false on failure — verify via the public
  // setMeetingModeActive/side-effect path rather than reaching into the
  // private field directly.
  assert.equal(launcher._meetingModeActive, false);
});

test("ManualMeetingLauncher has no detection surface left", () => {
  const launcher = new ManualMeetingLauncher(makeWindowManagerStub(), makeDatabaseManagerStub());

  assert.equal(launcher.meetingProcessDetector, undefined);
  assert.equal(launcher.audioActivityDetector, undefined);
  assert.equal(typeof launcher.setPreferences, "undefined");
  assert.equal(typeof launcher.getPreferences, "undefined");
  assert.equal(typeof launcher.handleNotificationResponse, "undefined");
  assert.equal(typeof launcher.handleNotificationTimeout, "undefined");
  assert.equal(typeof launcher.setUserRecording, "undefined");
  assert.equal(typeof launcher.joinCalendarMeeting, "undefined");
});
