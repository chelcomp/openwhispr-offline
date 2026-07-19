const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

/**
 * Regression-locks the "final pasted text" invariant (spec:
 * docs/specs/text-monitor-final-text-only.md, Requirement 1): whatever `text`
 * string the renderer sends to the `paste-text` IPC handler is the exact same
 * string used as textEditMonitor.startMonitoring()'s baseline — never a
 * derived/transformed value (smart-spacing, snippet expansion) that the OS
 * paste itself may use. This holds regardless of *why* `text` has the value it
 * does upstream (Text Cleanup applied vs. not, agent/voice-agent bypass, etc.)
 * — the handler itself never re-derives or diverges from the argument it was
 * given, so it's tested here by invoking the real registered handler twice
 * with different `text` values standing in for "cleaned-up text" and "raw
 * transcript" respectively.
 *
 * The real IPCHandlers constructor does heavy, unrelated app-startup work
 * (GPU detection, audio-cleanup timers, hundreds of other IPC registrations),
 * so this test bypasses it via Object.create and calls setupHandlers()
 * directly on a minimally-stubbed instance — setupHandlers() only *registers*
 * handler closures; it has no other side effects at call time (verified: it's
 * a flat sequence of ipcMain.handle(...) calls).
 */

const originalLoad = Module._load;
const registeredHandlers = new Map();

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: {
        getPath: () => process.cwd(),
        getAppPath: () => process.cwd(),
        isReady: () => false,
        getVersion: () => "0.0.0",
        on: () => {},
      },
      ipcMain: {
        handle: (name, fn) => {
          registeredHandlers.set(name, fn);
        },
        on: () => {},
      },
      shell: {},
      BrowserWindow: function BrowserWindow() {},
      systemPreferences: { subscribeWorkspaceNotification: () => {} },
      net: {},
    };
  }
  // Deterministic, instant stand-in for the real OS-foreground-app detector
  // (which shells out to a native binary on Windows/Linux) — irrelevant to
  // this invariant and would otherwise add non-determinism/latency.
  if (request === "./activeAppCapture") {
    return { detectAsync: async () => null, getLastAppName: () => null, setMacOSAppName: () => {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};

process.env.NODE_ENV = "test";

const IPCHandlers = require("../../src/helpers/ipcHandlers.js");

test.after(() => {
  Module._load = originalLoad;
});

function createHandlerUnderTest({ monitorCalls, pasteCalls, autoLearnEnabled = true }) {
  const instance = Object.create(IPCHandlers.prototype);
  instance.databaseManager = { getDictionary: () => [] };
  instance.clipboardManager = {
    pasteText: async (textToPaste, opts) => {
      pasteCalls.push({ textToPaste, opts });
      return { success: true };
    },
  };
  instance.textEditMonitor = {
    lastTargetPid: null,
    lastTargetAppName: null,
    startMonitoring: (originalText, timeoutMs, opts) => {
      monitorCalls.push({ originalText, timeoutMs, opts });
    },
  };
  instance.windowManager = { mainWindow: null, showDictationPanel: () => {} };
  instance.environmentManager = {};
  instance._autoLearnEnabled = autoLearnEnabled;

  instance.setupHandlers();
  const handler = registeredHandlers.get("paste-text");
  assert.ok(handler, "paste-text handler must be registered");
  return handler;
}

async function invokeAndWaitForMonitor(handler, text, options, monitorCalls) {
  const result = await handler({ sender: {} }, text, options);
  // startMonitoring() is scheduled via setTimeout(..., 500) after the paste
  // resolves — wait past that before asserting.
  const deadline = Date.now() + 3000;
  while (monitorCalls.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return result;
}

test("paste-text: monitor baseline equals the given text when it stands in for cleaned-up (Text Cleanup active) output", async () => {
  const monitorCalls = [];
  const pasteCalls = [];
  const handler = createHandlerUnderTest({ monitorCalls, pasteCalls });

  const cleanedUpText = "This is the cleaned-up sentence from the AI cleanup pass.";
  await invokeAndWaitForMonitor(handler, cleanedUpText, {}, monitorCalls);

  assert.equal(monitorCalls.length, 1);
  assert.equal(monitorCalls[0].originalText, cleanedUpText);
});

test("paste-text: monitor baseline equals the given text when it stands in for the raw transcript (Text Cleanup inactive/bypassed)", async () => {
  const monitorCalls = [];
  const pasteCalls = [];
  const handler = createHandlerUnderTest({ monitorCalls, pasteCalls });

  const rawTranscript = "this is the raw unprocessed transcript text";
  await invokeAndWaitForMonitor(handler, rawTranscript, {}, monitorCalls);

  assert.equal(monitorCalls.length, 1);
  assert.equal(monitorCalls[0].originalText, rawTranscript);
});

test("paste-text: monitor baseline is the untransformed text, not the smart-spaced/snippet-expanded paste content", async () => {
  const monitorCalls = [];
  const pasteCalls = [];
  const handler = createHandlerUnderTest({ monitorCalls, pasteCalls });

  const text = "hello world";
  await invokeAndWaitForMonitor(handler, text, {}, monitorCalls);

  assert.equal(pasteCalls.length, 1);
  // clipboardManager.pasteText() receives smart-spacing-transformed text (a
  // trailing space appended) — different from the raw `text` argument.
  assert.notEqual(pasteCalls[0].textToPaste, text);
  assert.ok(pasteCalls[0].textToPaste.startsWith(text));

  // The monitor must still get the exact, untransformed `text` argument.
  assert.equal(monitorCalls.length, 1);
  assert.equal(monitorCalls[0].originalText, text);
});

test("paste-text: no monitoring is started when auto-learn is disabled", async () => {
  const monitorCalls = [];
  const pasteCalls = [];
  // Simulate auto-learn being toggled off in Settings.
  const handler = createHandlerUnderTest({ monitorCalls, pasteCalls, autoLearnEnabled: false });

  await handler({ sender: {} }, "some text", {});
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(monitorCalls.length, 0);
});
