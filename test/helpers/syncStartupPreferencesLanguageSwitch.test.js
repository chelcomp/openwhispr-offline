const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// Regression test for docs/specs/dictation-language-detection-fix.md R7: a
// resolved-effective-language change alone must unload the running
// whisper-server (unload-only, no reload as a direct consequence of this
// handler) — mirrors syncStartupPreferencesModelSwitch.test.js's exact
// loadHandler/fake-ipcMain fixture, with the fake whisperManager fixture
// gaining a serverManager: { ready, languageSignature } sub-object.

const ipcHandlersPath = require.resolve("../../src/helpers/ipcHandlers");
const whisperServerPath = require.resolve("../../src/helpers/whisperServer");
const originalLoad = Module._load;

function loadHandler(handlerName, { whisperManager, parakeetManager, modelManager } = {}) {
  delete require.cache[ipcHandlersPath];

  const registered = new Map();
  const fakeIpcMain = {
    handle: (name, fn) => registered.set(name, fn),
    on: () => {},
    removeHandler: () => {},
  };

  const loadWithMocks = function loadWithMocks(request, parent, isMain) {
    if (request === "electron") {
      return {
        ipcMain: fakeIpcMain,
        app: { getPath: () => "/tmp" },
        shell: {},
        BrowserWindow: {},
        systemPreferences: {},
        net: {},
      };
    }
    if (request === "./modelManagerBridge") {
      return { default: modelManager || { stopServer: async () => {} } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  let IPCHandlers;
  Module._load = loadWithMocks;
  try {
    IPCHandlers = require("../../src/helpers/ipcHandlers");
  } finally {
    Module._load = originalLoad;
  }

  const fakeThis = Object.create(IPCHandlers.prototype);
  fakeThis.environmentManager = {
    saveAllKeysToEnvFile: async () => {},
  };
  fakeThis.whisperManager = whisperManager;
  fakeThis.parakeetManager = parakeetManager;

  IPCHandlers.prototype.setupHandlers.call(fakeThis);

  const handler = registered.get(handlerName);
  if (!handler) throw new Error(`Handler "${handlerName}" was not registered`);

  return async (...args) => {
    Module._load = loadWithMocks;
    try {
      return await handler(...args);
    } finally {
      Module._load = originalLoad;
    }
  };
}

function makeWhisperManager({ currentServerModel = null, ready = false, languageSignature = "language:auto" } = {}) {
  const stopCalls = [];
  const startCalls = [];
  return {
    currentServerModel,
    serverManager: { ready, languageSignature },
    stopServer: async () => {
      stopCalls.push(true);
    },
    // A real spy (not just an absent method) so the "no reload" assertion
    // isn't vacuously true against a fixture that simply lacks the method.
    startServer: async (...args) => {
      startCalls.push(args);
    },
    _stopCalls: stopCalls,
    _startCalls: startCalls,
  };
}

function makeParakeetManager(currentModel) {
  const stopCalls = [];
  return {
    getCurrentModel: () => currentModel,
    stopServer: async () => {
      stopCalls.push(true);
    },
    _stopCalls: stopCalls,
  };
}

test("stops the Whisper server when only the effective language changes (model unchanged, server currently ready)", async () => {
  const whisperManager = makeWhisperManager({
    currentServerModel: "ggml-base.bin",
    ready: true,
    languageSignature: "language:en",
  });
  const parakeetManager = makeParakeetManager(null);
  const handler = loadHandler("sync-startup-preferences", { whisperManager, parakeetManager });

  await handler(
    {},
    {
      useLocalWhisper: true,
      localTranscriptionProvider: "whisper",
      model: "ggml-base.bin",
      language: "pt",
    }
  );

  assert.equal(whisperManager._stopCalls.length, 1);
  assert.equal(whisperManager._startCalls.length, 0, "no reload as a direct consequence of this handler");
});

test("does not stop Whisper when the language is unchanged", async () => {
  const whisperManager = makeWhisperManager({
    currentServerModel: "ggml-base.bin",
    ready: true,
    languageSignature: "language:en",
  });
  const parakeetManager = makeParakeetManager(null);
  const handler = loadHandler("sync-startup-preferences", { whisperManager, parakeetManager });

  await handler(
    {},
    {
      useLocalWhisper: true,
      localTranscriptionProvider: "whisper",
      model: "ggml-base.bin",
      language: "en",
    }
  );

  assert.equal(whisperManager._stopCalls.length, 0);
});

test("does not stop Whisper when no server is currently running", async () => {
  const whisperManager = makeWhisperManager({
    currentServerModel: "ggml-base.bin",
    ready: false,
    languageSignature: "language:en",
  });
  const parakeetManager = makeParakeetManager(null);
  const handler = loadHandler("sync-startup-preferences", { whisperManager, parakeetManager });

  await handler(
    {},
    {
      useLocalWhisper: true,
      localTranscriptionProvider: "whisper",
      model: "ggml-base.bin",
      language: "pt",
    }
  );

  assert.equal(whisperManager._stopCalls.length, 0);
});

test("does not touch Parakeet when only the language changes under the nvidia provider", async () => {
  const whisperManager = makeWhisperManager({ currentServerModel: null, ready: false });
  const parakeetManager = makeParakeetManager("parakeet-tdt-0.6b-v3");
  const handler = loadHandler("sync-startup-preferences", { whisperManager, parakeetManager });

  await handler(
    {},
    {
      useLocalWhisper: true,
      localTranscriptionProvider: "nvidia",
      model: "parakeet-tdt-0.6b-v3",
      language: "pt",
    }
  );

  // Parakeet's own model is unchanged, so the existing same-provider
  // model-mismatch-unload check doesn't fire for it either — the language
  // change has no bearing on Parakeet at all (Non-goals boundary).
  assert.equal(parakeetManager._stopCalls.length, 0);
});

test.after(() => {
  delete require.cache[whisperServerPath];
});
