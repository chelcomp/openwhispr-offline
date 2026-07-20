// Component test for the renderer half of the transcription-preview
// ready-handshake (see docs/specs/transcription-preview-window-ready-race.md).
//
// Run via: node --test --import ./test/setup/tsxRegister.js test/components/*.test.js
// (the happy-dom + esbuild/tsx shim is only active for this file, not the
// rest of the suite — see test/setup/tsxRegister.js for details. This file
// itself is plain JS driving a required-and-transformed .tsx component, so
// it doesn't need a .jsx extension.)

const test = require("node:test");
const assert = require("node:assert/strict");
const { render, screen, cleanup, act } = require("@testing-library/react");
const React = require("react");
const TranscriptionPreviewOverlay =
  require("../../src/components/TranscriptionPreviewOverlay.tsx").default;

function makeElectronApiStub() {
  const listeners = {};
  const registerListener = (name) => (callback) => {
    listeners[name] = callback;
    return () => {
      delete listeners[name];
    };
  };

  return {
    listeners,
    notifyTranscriptionPreviewReadyCalls: 0,
    onPreviewText(callback) {
      return registerListener("onPreviewText")(callback);
    },
    onPreviewAppend(callback) {
      return registerListener("onPreviewAppend")(callback);
    },
    onPreviewHold(callback) {
      return registerListener("onPreviewHold")(callback);
    },
    onPreviewResult(callback) {
      return registerListener("onPreviewResult")(callback);
    },
    onPreviewCleanupUpdate(callback) {
      return registerListener("onPreviewCleanupUpdate")(callback);
    },
    onPreviewHide(callback) {
      return registerListener("onPreviewHide")(callback);
    },
    notifyTranscriptionPreviewReady() {
      this.notifyTranscriptionPreviewReadyCalls += 1;
    },
    hideDictationPreview: async () => ({ success: true }),
    dismissDictationPreview: async () => ({ success: true }),
  };
}

test.afterEach(() => {
  cleanup();
  delete global.window.electronAPI;
});

test("calls notifyTranscriptionPreviewReady exactly once after mount, after listeners are registered", () => {
  const electronApiStub = makeElectronApiStub();
  global.window.electronAPI = electronApiStub;

  render(React.createElement(TranscriptionPreviewOverlay));

  assert.equal(electronApiStub.notifyTranscriptionPreviewReadyCalls, 1);
  // All six preview-* listeners must already be registered by the time the
  // ready signal is sent — this is the actual bug-fixing contract.
  assert.equal(typeof electronApiStub.listeners.onPreviewText, "function");
  assert.equal(typeof electronApiStub.listeners.onPreviewAppend, "function");
  assert.equal(typeof electronApiStub.listeners.onPreviewHold, "function");
  assert.equal(typeof electronApiStub.listeners.onPreviewResult, "function");
  assert.equal(typeof electronApiStub.listeners.onPreviewCleanupUpdate, "function");
  assert.equal(typeof electronApiStub.listeners.onPreviewHide, "function");
});

test("firing onPreviewText after mount updates the visible live text", async () => {
  const electronApiStub = makeElectronApiStub();
  global.window.electronAPI = electronApiStub;

  render(React.createElement(TranscriptionPreviewOverlay));

  await act(async () => {
    electronApiStub.listeners.onPreviewText("hello world");
  });

  assert.ok(screen.getByText("hello world"));
});
