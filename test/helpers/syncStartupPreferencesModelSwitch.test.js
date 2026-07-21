const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// Regression test for docs/specs/on-demand-model-lifecycle.md R4: a
// same-provider transcription model change (e.g. Whisper "tiny" -> "turbo",
// or Parakeet model A -> model B) must unload the stale model immediately,
// not lazily. `sync-startup-preferences` previously only stopped the *other*
// engine's server on a cross-provider switch (Whisper <-> Parakeet) and never
// stopped the *current* engine when only its model changed within the same
// provider, leaving the old model loaded until the next lazy swap-on-mismatch
// or the idle timeout — this file locks in the fix.
//
// Mirrors test/helpers/llamaServerGpuRestart.test.js's isolated-handler
// pattern: call setupHandlers() against a minimal fake `this` rather than
// instantiating the full IPCHandlers class.

const ipcHandlersPath = require.resolve("../../src/helpers/ipcHandlers");
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

function makeWhisperManager(currentServerModel) {
  const stopCalls = [];
  return {
    currentServerModel,
    stopServer: async () => {
      stopCalls.push(true);
    },
    _stopCalls: stopCalls,
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

test("sync-startup-preferences stops the current Whisper server when only the model changes within the same provider", async () => {
  const whisperManager = makeWhisperManager("ggml-tiny.bin");
  const parakeetManager = makeParakeetManager(null);
  const handler = loadHandler("sync-startup-preferences", { whisperManager, parakeetManager });

  await handler({}, {
    useLocalWhisper: true,
    localTranscriptionProvider: "whisper",
    model: "ggml-turbo.bin",
  });

  assert.equal(whisperManager._stopCalls.length, 1);
});

test("sync-startup-preferences does not stop Whisper when the model is unchanged", async () => {
  const whisperManager = makeWhisperManager("ggml-tiny.bin");
  const parakeetManager = makeParakeetManager(null);
  const handler = loadHandler("sync-startup-preferences", { whisperManager, parakeetManager });

  await handler({}, {
    useLocalWhisper: true,
    localTranscriptionProvider: "whisper",
    model: "ggml-tiny.bin",
  });

  assert.equal(whisperManager._stopCalls.length, 0);
});

test("sync-startup-preferences stops the current Parakeet server when only the model changes within the same provider", async () => {
  const whisperManager = makeWhisperManager(null);
  const parakeetManager = makeParakeetManager("parakeet-tdt-0.6b-v3");
  const handler = loadHandler("sync-startup-preferences", { whisperManager, parakeetManager });

  await handler({}, {
    useLocalWhisper: true,
    localTranscriptionProvider: "nvidia",
    model: "parakeet-unified-en-0.6b",
  });

  assert.equal(parakeetManager._stopCalls.length, 1);
});

test("sync-startup-preferences does not stop Parakeet when the model is unchanged", async () => {
  const whisperManager = makeWhisperManager(null);
  const parakeetManager = makeParakeetManager("parakeet-tdt-0.6b-v3");
  const handler = loadHandler("sync-startup-preferences", { whisperManager, parakeetManager });

  await handler({}, {
    useLocalWhisper: true,
    localTranscriptionProvider: "nvidia",
    model: "parakeet-tdt-0.6b-v3",
  });

  assert.equal(parakeetManager._stopCalls.length, 0);
});

test("sync-startup-preferences still stops the other engine on a cross-provider switch (existing behavior, unaffected)", async () => {
  const whisperManager = makeWhisperManager("ggml-tiny.bin");
  const parakeetManager = makeParakeetManager(null);
  const handler = loadHandler("sync-startup-preferences", { whisperManager, parakeetManager });

  await handler({}, {
    useLocalWhisper: true,
    localTranscriptionProvider: "nvidia",
    model: "parakeet-tdt-0.6b-v3",
  });

  assert.equal(whisperManager._stopCalls.length, 1);
  assert.equal(parakeetManager._stopCalls.length, 0);
});
