const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// Exercises modelManagerBridge.js's runInference() adaptive-context-doubling
// retry logic (docs/specs/llama-server-vram-tuning.md) in isolation. The real
// LlamaServerManager is loaded (for its DEFAULT_CONTEXT_CAP/MAX_CONTEXT_SIZE
// constants and ContextOverflowError class), but the ModelManager instance's
// own `serverManager` is swapped for a fully fake one so no real process is
// ever spawned.

const modelManagerBridgePath = require.resolve("../../src/helpers/modelManagerBridge");
const llamaServerPath = require.resolve("../../src/helpers/llamaServer");
const originalLoad = Module._load;

function loadModelManager() {
  delete require.cache[modelManagerBridgePath];
  delete require.cache[llamaServerPath];

  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "electron") {
      return {
        app: { getPath: () => "/tmp", isReady: () => true },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  let bridge;
  try {
    bridge = require("../../src/helpers/modelManagerBridge");
  } finally {
    Module._load = originalLoad;
  }
  return bridge;
}

// Minimal fake standing in for LlamaServerManager: tracks start() calls and
// lets the test script inference() to reject with ContextOverflowError a
// controllable number of times before succeeding.
function makeFakeServerManager({ inferenceBehavior }) {
  const startCalls = [];
  const fake = {
    ready: true,
    isAvailable: () => true,
    port: 8221,
    start: async (modelPath, options) => {
      startCalls.push({ modelPath, options });
      fake.ready = true;
    },
    inference: async (messages, options) => inferenceBehavior(messages, options),
  };
  return { fake, startCalls };
}

function setupManager({ modelInfo, inferenceBehavior }) {
  const { default: modelManager, ModelError } = loadModelManager();
  const LlamaServerManager = require("../../src/helpers/llamaServer");

  const { fake: fakeServerManager, startCalls } = makeFakeServerManager({ inferenceBehavior });
  modelManager.serverManager = fakeServerManager;
  modelManager.currentServerModelId = null;
  modelManager.currentContextSizeByModel = new Map();
  modelManager.ensureInitialized = () => {};
  modelManager.modelsDir = "/tmp/models";
  modelManager.checkModelValid = async () => true;
  modelManager.findModelById = (modelId) => modelInfo(modelId);

  return { modelManager, startCalls, ModelError, LlamaServerManager };
}

test("runInference() doubles context size once and retries after a single ContextOverflowError, then succeeds", async () => {
  const { modelManager, startCalls, LlamaServerManager } = setupManager({
    modelInfo: (modelId) => ({
      model: { id: modelId, fileName: "model.gguf", contextLength: 262144 },
      provider: { id: "local" },
    }),
    inferenceBehavior: (() => {
      let calls = 0;
      return async () => {
        calls++;
        if (calls === 1) throw new LlamaServerManager.ContextOverflowError("context exceeded");
        return "final result";
      };
    })(),
  });

  const result = await modelManager.runInference("model-a", "hello");

  assert.equal(result, "final result");
  // First call is the fresh (non-retry) start at the 2048 default; the second
  // is the doubling retry to 4096.
  assert.equal(startCalls.length, 2);
  assert.equal(startCalls[0].options.contextSize, 2048);
  assert.equal(startCalls[1].options.contextSize, 4096);
});

test("runInference() keeps doubling on repeated ContextOverflowError up to the 65536 cap, then propagates the error", async () => {
  const { modelManager, startCalls, LlamaServerManager, ModelError } = setupManager({
    modelInfo: (modelId) => ({
      model: { id: modelId, fileName: "model.gguf", contextLength: 1000000 },
      provider: { id: "local" },
    }),
    inferenceBehavior: async () => {
      throw new LlamaServerManager.ContextOverflowError("context exceeded");
    },
  });

  await assert.rejects(
    () => modelManager.runInference("model-a", "hello"),
    (err) => err instanceof ModelError
  );

  // Fresh start (2048) + 5 doubling restarts: 4096, 8192, 16384, 32768, 65536.
  const sizes = startCalls.map((c) => c.options.contextSize);
  assert.deepEqual(sizes, [2048, 4096, 8192, 16384, 32768, 65536]);
});

test("runInference() never requests a context size above the model's own registry contextLength, even if the 65536 cap allows more", async () => {
  const { modelManager, startCalls, LlamaServerManager, ModelError } = setupManager({
    modelInfo: (modelId) => ({
      model: { id: modelId, fileName: "model.gguf", contextLength: 20000 },
      provider: { id: "local" },
    }),
    inferenceBehavior: async () => {
      throw new LlamaServerManager.ContextOverflowError("context exceeded");
    },
  });

  await assert.rejects(
    () => modelManager.runInference("model-a", "hello"),
    (err) => err instanceof ModelError
  );

  const sizes = startCalls.map((c) => c.options.contextSize);
  // Fresh start at 2048 (contextLength 20000 > DEFAULT_CONTEXT_CAP so cap
  // wins), then doubles 4096, 8192, 16384, then clamps to 20000 and stops.
  assert.deepEqual(sizes, [2048, 4096, 8192, 16384, 20000]);
});

test("runInference() reuses the previously-doubled context size for a subsequent request to the same model without re-triggering an overflow", async () => {
  let overflowOnce = true;
  const { modelManager, startCalls } = setupManager({
    modelInfo: (modelId) => ({
      model: { id: modelId, fileName: "model.gguf", contextLength: 262144 },
      provider: { id: "local" },
    }),
    inferenceBehavior: async () => {
      if (overflowOnce) {
        overflowOnce = false;
        const LlamaServerManager = require("../../src/helpers/llamaServer");
        throw new LlamaServerManager.ContextOverflowError("context exceeded");
      }
      return "ok";
    },
  });

  const first = await modelManager.runInference("model-a", "hello");
  assert.equal(first, "ok");
  assert.equal(startCalls.length, 2); // fresh start (2048) + doubling retry (4096)

  const second = await modelManager.runInference("model-a", "hello again");
  assert.equal(second, "ok");
  // No further start() calls: server already ready for the same model.
  assert.equal(startCalls.length, 2);
});

test("runInference() resets the tracked context size back to the 2048 default when the model changes", async () => {
  const modelInfos = {
    a: { model: { id: "a", fileName: "a.gguf", contextLength: 262144 }, provider: { id: "local" } },
    b: { model: { id: "b", fileName: "b.gguf", contextLength: 262144 }, provider: { id: "local" } },
  };

  let overflowOnce = true;
  const { modelManager, startCalls } = setupManager({
    modelInfo: (modelId) => modelInfos[modelId.replace("model-", "")],
    inferenceBehavior: async () => {
      if (overflowOnce) {
        overflowOnce = false;
        const LlamaServerManager = require("../../src/helpers/llamaServer");
        throw new LlamaServerManager.ContextOverflowError("context exceeded");
      }
      return "ok";
    },
  });

  await modelManager.runInference("model-a", "hello");
  assert.equal(startCalls.length, 2);
  assert.equal(startCalls[1].options.contextSize, 4096);

  await modelManager.runInference("model-b", "hello");
  const lastCall = startCalls[startCalls.length - 1];
  assert.equal(lastCall.options.contextSize, 2048);
});
