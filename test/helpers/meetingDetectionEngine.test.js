const test = require("node:test");
const assert = require("node:assert/strict");

// Stub electron's BrowserWindow before meetingDetectionEngine.js loads so the
// class can be constructed outside Electron (same pattern as hotkeySlotRollback.test.js).
require.cache[require.resolve("electron")] = {
  exports: {
    BrowserWindow: class {
      static getAllWindows() {
        return [];
      }
    },
  },
};

const MeetingDetectionEngine = require("../../src/helpers/meetingDetectionEngine.js");

function makeProcessDetector() {
  const listeners = {};
  return {
    on: (event, cb) => {
      listeners[event] = cb;
    },
    start: () => {},
    stop: () => {},
  };
}

function makeAudioActivityDetector() {
  const listeners = {};
  return {
    on: (event, cb) => {
      listeners[event] = cb;
    },
    start: () => {},
    stop: () => {},
    dismiss: () => {},
    resetPrompt: () => {},
    setUserRecording: () => {},
  };
}

function makeWindowManager() {
  return {
    notificationPrefs: {},
    showMeetingNotification: async () => {},
    dismissMeetingNotification: () => {},
    queueMeetingNoteNavigation: async () => {},
  };
}

test("startManualMeeting() creates a note and navigates without any calendar delegation", async () => {
  const windowManager = makeWindowManager();
  const queuedCalls = [];
  windowManager.queueMeetingNoteNavigation = async (payload) => {
    queuedCalls.push(payload);
  };

  const broadcasts = [];

  // databaseManagerStub intentionally has no getActiveEvents/getCalendarEventById
  // property at all — proves startManualMeeting() never touches them (if the old
  // delegation branch still existed, calling a missing method would throw).
  const databaseManagerStub = {
    saveNote: (title) => ({ success: true, note: { id: 42, title } }),
    getMeetingsFolder: () => ({ id: 7, name: "Meetings" }),
  };

  const engine = new MeetingDetectionEngine(
    makeProcessDetector(),
    makeAudioActivityDetector(),
    windowManager,
    databaseManagerStub
  );
  engine.broadcastToWindows = (channel, data) => broadcasts.push({ channel, data });

  await engine.startManualMeeting();

  assert.equal(queuedCalls.length, 1);
  assert.equal(queuedCalls[0].noteId, 42);
  assert.equal(queuedCalls[0].folderId, 7);
  assert.equal(queuedCalls[0].trigger, "hotkey");

  assert.ok(broadcasts.some((b) => b.channel === "note-added" && b.data.id === 42));
});

test("startManualMeeting() throws if it ever calls getActiveEvents (branch must be fully removed)", async () => {
  const windowManager = makeWindowManager();

  const databaseManagerStub = {
    saveNote: (title) => ({ success: true, note: { id: 1, title } }),
    getMeetingsFolder: () => ({ id: 1, name: "Meetings" }),
    getActiveEvents: () => {
      throw new Error("getActiveEvents should never be called — the delegation branch was removed");
    },
  };

  const engine = new MeetingDetectionEngine(
    makeProcessDetector(),
    makeAudioActivityDetector(),
    windowManager,
    databaseManagerStub
  );
  engine.broadcastToWindows = () => {};

  // Must resolve normally, never invoking the throwing getActiveEvents stub.
  await assert.doesNotReject(() => engine.startManualMeeting());
});

test("the class no longer has a joinCalendarMeeting method", () => {
  const engine = new MeetingDetectionEngine(
    makeProcessDetector(),
    makeAudioActivityDetector(),
    makeWindowManager(),
    {}
  );

  assert.equal(typeof engine.joinCalendarMeeting, "undefined");
});

test("handleNotificationResponse('start') never calls getCalendarEventById, even for a would-be-real calendar_id", async () => {
  const windowManager = makeWindowManager();
  const queuedCalls = [];
  windowManager.queueMeetingNoteNavigation = async (payload) => {
    queuedCalls.push(payload);
  };

  const databaseManagerStub = {
    saveNote: (title) => ({ success: true, note: { id: 99, title } }),
    getMeetingsFolder: () => ({ id: 3, name: "Meetings" }),
    getCalendarEventById: () => {
      throw new Error("getCalendarEventById should never be called — isRealEvent block was removed");
    },
  };

  const engine = new MeetingDetectionEngine(
    makeProcessDetector(),
    makeAudioActivityDetector(),
    windowManager,
    databaseManagerStub
  );
  engine.broadcastToWindows = () => {};

  const detectionId = "process:zoom";
  // calendar_id here is a value that would have made the old isRealEvent check
  // true (not "__detected__"/"__manual__").
  engine.activeDetections.set(detectionId, {
    source: "process",
    key: "zoom",
    dismissed: false,
    event: {
      id: "would-be-real-event",
      calendar_id: "real-cal-id-123",
      summary: "Real Meeting",
    },
  });

  await assert.doesNotReject(() => engine.handleNotificationResponse(detectionId, "start"));

  assert.equal(queuedCalls.length, 1);
  assert.equal(queuedCalls[0].noteId, 99);
  assert.equal(queuedCalls[0].folderId, 3);
  assert.equal(engine.activeDetections.has(detectionId), false);
});
