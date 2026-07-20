const test = require("node:test");
const assert = require("node:assert/strict");

// Stub electron before windowManager.js loads so it can run outside Electron.
// Mirrors the pattern used in test/helpers/manualMeetingLauncher.test.js.
require.cache[require.resolve("electron")] = {
  exports: {
    app: {
      on: () => {},
      getPath: () => require("os").tmpdir(),
      getName: () => "test",
      getAppPath: () => __dirname,
    },
    screen: {
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getDisplayNearestPoint: () => ({
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      }),
    },
    BrowserWindow: class {
      static getAllWindows() {
        return [];
      }
    },
    shell: {},
    dialog: {},
    ipcMain: {
      _handlers: {},
      on(channel, handler) {
        this._handlers[channel] = handler;
      },
      handle: () => {},
    },
    Menu: {
      buildFromTemplate: () => ({}),
      setApplicationMenu: () => {},
    },
    globalShortcut: { register: () => {}, unregister: () => {} },
  },
};

const electronStub = require("electron");
const WindowManager = require("../../src/helpers/windowManager.js");

// Minimal fake BrowserWindow double for the transcription preview window,
// standing in for the real BrowserWindow ensureTranscriptionPreviewWindow()
// would construct.
function makeFakeWindow() {
  const sendCalls = [];
  let closedHandler = null;
  const webContents = {
    send: (channel, payload) => {
      sendCalls.push({ channel, payload });
    },
  };
  return {
    webContents,
    sendCalls,
    isDestroyed: () => false,
    showInactive: () => {},
    setBounds: () => {},
    setAlwaysOnTop: () => {},
    getBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
    on: (event, handler) => {
      if (event === "closed") closedHandler = handler;
    },
    fireClosed: () => closedHandler && closedHandler(),
    loadFile: () => Promise.resolve(),
    loadURL: () => Promise.resolve(),
  };
}

// Installs a fake preview window into the WindowManager instance the same
// way ensureTranscriptionPreviewWindow() would (minus the real BrowserWindow
// construction/loadFile), so the real showTranscriptionPreview/append/etc.
// public methods (the actual six call sites the fix touches) can be exercised
// directly through the readiness gate.
function makeWindowManagerWithFakePreviewWindow() {
  const wm = new WindowManager();
  const fakeWindow = makeFakeWindow();
  wm.transcriptionPreviewWindow = fakeWindow;
  wm._transcriptionPreviewReady = false;
  wm._transcriptionPreviewPendingSends = [];
  fakeWindow.on("closed", () => {
    wm.transcriptionPreviewWindow = null;
    wm._transcriptionPreviewReady = false;
    wm._transcriptionPreviewPendingSends = [];
    if (wm._transcriptionPreviewReadyTimeout) {
      clearTimeout(wm._transcriptionPreviewReadyTimeout);
      wm._transcriptionPreviewReadyTimeout = null;
    }
  });
  return { wm, fakeWindow };
}

function fireReady(sender) {
  electronStub.ipcMain._handlers["transcription-preview-ready"]({ sender });
}

test("Test A (reproduces the bug): preview-text is queued, not lost, until ready fires", async () => {
  const { wm, fakeWindow } = makeWindowManagerWithFakePreviewWindow();

  await wm.showTranscriptionPreview("hello");
  assert.equal(
    fakeWindow.sendCalls.filter((c) => c.channel === "preview-text").length,
    0,
    "preview-text must not be sent before the renderer signals ready"
  );

  fireReady(fakeWindow.webContents);

  const previewTextSends = fakeWindow.sendCalls.filter((c) => c.channel === "preview-text");
  assert.equal(previewTextSends.length, 1);
  assert.deepEqual(previewTextSends[0], { channel: "preview-text", payload: "hello" });
});

test("Test B (ordering): queued sends across multiple preview-* calls flush in FIFO order", async () => {
  const { wm, fakeWindow } = makeWindowManagerWithFakePreviewWindow();

  await wm.showTranscriptionPreview("a");
  wm.appendTranscriptionPreview("b");
  wm.holdTranscriptionPreview({ showCleanup: false });

  assert.equal(fakeWindow.sendCalls.length, 0);

  fireReady(fakeWindow.webContents);

  assert.equal(fakeWindow.sendCalls.length, 3);
  assert.equal(fakeWindow.sendCalls[0].channel, "preview-text");
  assert.equal(fakeWindow.sendCalls[1].channel, "preview-append");
  assert.equal(fakeWindow.sendCalls[2].channel, "preview-hold");
});

test("Test C (timeout fallback): queued sends flush after TRANSCRIPTION_PREVIEW_READY_TIMEOUT_MS if ready never arrives", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const { wm, fakeWindow } = makeWindowManagerWithFakePreviewWindow();
  // Mirrors the fallback timer ensureTranscriptionPreviewWindow() starts on
  // window creation.
  wm._transcriptionPreviewReadyTimeout = setTimeout(() => {
    wm._transcriptionPreviewReadyTimeout = null;
    wm._markTranscriptionPreviewReady();
  }, 3000);

  await wm.showTranscriptionPreview("hello");
  assert.equal(fakeWindow.sendCalls.length, 0);

  t.mock.timers.tick(3000);

  assert.equal(fakeWindow.sendCalls.length, 1);
  assert.deepEqual(fakeWindow.sendCalls[0], { channel: "preview-text", payload: "hello" });
});

test("Test D (stale-window guard): ready signal from a destroyed prior window instance is ignored", async () => {
  const { wm, fakeWindow } = makeWindowManagerWithFakePreviewWindow();

  await wm.showTranscriptionPreview("hello");

  const staleSender = {}; // Not the current window's webContents.
  fireReady(staleSender);

  assert.equal(fakeWindow.sendCalls.length, 0, "stale ready signal must not flush the queue");
  assert.equal(wm._transcriptionPreviewReady, false);
});

test("Test E (per-instance reset): readiness does not leak across window instances", async () => {
  const { wm, fakeWindow } = makeWindowManagerWithFakePreviewWindow();

  fireReady(fakeWindow.webContents);
  assert.equal(wm._transcriptionPreviewReady, true);

  fakeWindow.fireClosed();
  assert.equal(wm.transcriptionPreviewWindow, null);
  assert.equal(wm._transcriptionPreviewReady, false);

  // A new window instance is created ("recreated") — must start unready.
  const newFakeWindow = makeFakeWindow();
  wm.transcriptionPreviewWindow = newFakeWindow;
  wm._transcriptionPreviewReady = false;
  wm._transcriptionPreviewPendingSends = [];

  await wm.showTranscriptionPreview("world");
  assert.equal(
    newFakeWindow.sendCalls.filter((c) => c.channel === "preview-text").length,
    0,
    "new window instance must not inherit prior readiness"
  );
});
