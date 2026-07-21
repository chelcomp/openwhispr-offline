const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// Exercises the `set-gpu-device-index` (purpose === "intelligence") handler in
// ipcHandlers.js in isolation: it must resolve and pass along the
// previously-active model's registry contextSize when restarting llama-server
// after a GPU-device change, rather than calling start(modelPath) with no
// options (which would silently reset to the DEFAULT_CONTEXT_SIZE fallback).
//
// Rather than instantiating the full IPCHandlers class (whose constructor has
// many unrelated side effects — audio cleanup timers, text-edit monitoring,
// GPU detection probing, etc.), we call `setupHandlers()` directly against a
// minimal fake `this`, mirroring only what this one handler touches. This
// keeps the test scoped to the behavior described in the spec without
// requiring a heavyweight mock of the entire manager graph.

const ipcHandlersPath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;

function loadHandler(handlerName, { modelManager, environmentManager } = {}) {
  delete require.cache[ipcHandlersPath];

  const registered = new Map();
  const fakeIpcMain = {
    handle: (name, fn) => registered.set(name, fn),
    on: () => {},
    removeHandler: () => {},
  };

  // The "set-gpu-device-index" handler body does `require("./modelManagerBridge")`
  // at *invocation* time (not at module-load time), so the mock must stay
  // active for the lifetime of the returned handler, not just during the
  // initial require of ipcHandlers.js.
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
      return { default: modelManager };
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
  fakeThis.environmentManager = environmentManager || {
    saveAllKeysToEnvFile: async () => {},
  };
  fakeThis.whisperManager = { serverManager: null };

  IPCHandlers.prototype.setupHandlers.call(fakeThis);

  const handler = registered.get(handlerName);
  if (!handler) throw new Error(`Handler "${handlerName}" was not registered`);

  // Wrap so callers get the mock torn down again once the handler settles,
  // without needing to manage Module._load themselves.
  return async (...args) => {
    Module._load = loadWithMocks;
    try {
      return await handler(...args);
    } finally {
      Module._load = originalLoad;
    }
  };
}

test.beforeEach(() => {
  // set-gpu-device-index only restarts when the new UUID differs from
  // process.env's currently-persisted one — clear it between tests so one
  // test's write doesn't make the next test's "change" a no-op.
  delete process.env.INTELLIGENCE_GPU_UUID;
  delete process.env.TRANSCRIPTION_GPU_UUID;
});

test("GPU-change restart preserves the previously-active (tracked, possibly doubled) context size, not the raw registry contextLength", async () => {
  const startCalls = [];
  const modelManager = {
    currentServerModelId: "nemotron-3-nano-4b-q4_k_m",
    currentContextSizeByModel: new Map([["nemotron-3-nano-4b-q4_k_m", 16384]]),
    serverManager: {
      process: { pid: 123 },
      modelPath: "/models/nemotron-3-nano-4b-q4_k_m.gguf",
      stop: async () => {},
      start: async (modelPath, options) => {
        startCalls.push({ modelPath, options });
      },
    },
    findModelById: (modelId) => {
      assert.equal(modelId, "nemotron-3-nano-4b-q4_k_m");
      return { model: { id: modelId, contextLength: 262144 } };
    },
  };

  const handler = loadHandler("set-gpu-device-index", { modelManager });

  const result = await handler({}, "intelligence", "GPU-abc123");

  assert.deepEqual(result, { success: true });
  assert.equal(startCalls.length, 1);
  assert.equal(startCalls[0].modelPath, "/models/nemotron-3-nano-4b-q4_k_m.gguf");
  assert.deepEqual(startCalls[0].options, {
    contextSize: 16384,
    threads: 4,
    gpuLayers: 99,
  });
});

test("GPU-change restart falls back to the clamped DEFAULT_CONTEXT_CAP when no context size was tracked yet", async () => {
  const startCalls = [];
  const modelManager = {
    currentServerModelId: "nemotron-3-nano-4b-q4_k_m",
    currentContextSizeByModel: new Map(),
    serverManager: {
      process: { pid: 123 },
      modelPath: "/models/nemotron-3-nano-4b-q4_k_m.gguf",
      stop: async () => {},
      start: async (modelPath, options) => {
        startCalls.push({ modelPath, options });
      },
    },
    findModelById: (modelId) => {
      assert.equal(modelId, "nemotron-3-nano-4b-q4_k_m");
      return { model: { id: modelId, contextLength: 262144 } };
    },
  };

  const handler = loadHandler("set-gpu-device-index", { modelManager });

  const result = await handler({}, "intelligence", "GPU-abc123");

  assert.deepEqual(result, { success: true });
  assert.equal(startCalls.length, 1);
  assert.deepEqual(startCalls[0].options, {
    contextSize: 2048,
    threads: 4,
    gpuLayers: 99,
  });
});

test("GPU-change restart falls back to a bare start(modelPath) when the previous model can no longer be found", async () => {
  const startCalls = [];
  const modelManager = {
    currentServerModelId: "some-deleted-model",
    serverManager: {
      process: { pid: 123 },
      modelPath: "/models/some-deleted-model.gguf",
      stop: async () => {},
      start: async (modelPath, options) => {
        startCalls.push({ modelPath, options });
      },
    },
    findModelById: () => null,
  };

  const handler = loadHandler("set-gpu-device-index", { modelManager });

  const result = await handler({}, "intelligence", "GPU-abc123");

  assert.deepEqual(result, { success: true });
  assert.equal(startCalls.length, 1);
  assert.equal(startCalls[0].modelPath, "/models/some-deleted-model.gguf");
  assert.equal(startCalls[0].options, undefined);
});

test("GPU-change restart does nothing for the intelligence purpose when no llama-server process is running", async () => {
  const startCalls = [];
  const modelManager = {
    currentServerModelId: "some-model",
    serverManager: {
      process: null,
      modelPath: null,
      stop: async () => {},
      start: async (modelPath, options) => {
        startCalls.push({ modelPath, options });
      },
    },
    findModelById: () => ({ model: { contextLength: 262144 } }),
  };

  const handler = loadHandler("set-gpu-device-index", { modelManager });

  const result = await handler({}, "intelligence", "GPU-abc123");

  assert.deepEqual(result, { success: true });
  assert.equal(startCalls.length, 0);
});
