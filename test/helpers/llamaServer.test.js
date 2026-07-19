const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const llamaServerPath = require.resolve("../../src/helpers/llamaServer");

// _doStart requires the model file to exist on disk — use a real temp file
// rather than mocking `fs` (which llamaBackends/serverUtils also rely on).
const FAKE_MODEL_PATH = path.join(os.tmpdir(), "ektoswhispr-test-model.gguf");
fs.writeFileSync(FAKE_MODEL_PATH, "");

const originalLoad = Module._load;

// start() kicks off a health-check interval + idle timer on success; without
// tearing these down the test process never goes idle and node:test hangs.
const createdManagers = [];
test.afterEach(() => {
  for (const manager of createdManagers.splice(0)) {
    manager.stopHealthCheck();
    manager.clearIdleTimer();
  }
});

function loadLlamaServerManager({ spawn, backendChain, allBackends } = {}) {
  delete require.cache[llamaServerPath];

  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "child_process" && spawn) {
      return { ...childProcess, spawn };
    }
    if (request === "../utils/serverUtils") {
      return { isPortAvailable: async () => true };
    }
    if (request === "./llamaBackends") {
      return {
        getBackendChain: () => backendChain || [],
        getAllBackends: () => allBackends || backendChain || [],
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const LlamaServerManager = require("../../src/helpers/llamaServer");
    const manager = new LlamaServerManager();
    createdManagers.push(manager);
    return manager;
  } finally {
    Module._load = originalLoad;
  }
}

// A fake backend that mirrors the llamaBackends.js contract: owns its binary
// path, arg/env building, and startup timeout.
function makeBackend({
  name,
  gpuAccelerated = false,
  available = true,
  binaryPath,
  startupTimeoutMs = 50,
} = {}) {
  const resolvedBinaryPath = binaryPath || `/bin/llama-server-${name}`;
  return {
    name,
    gpuAccelerated,
    startupTimeoutMs,
    isAvailable: () => available,
    getBinaryPath: () => (available ? resolvedBinaryPath : null),
    buildArgs: (base) => [...base, `--${name}-flag`],
    buildEnv: () => ({ FAKE_BACKEND: name }),
  };
}

// Spawns a fake process per binary. `behaviors[binaryPath]` controls whether
// the process reports healthy ("succeed") or dies on spawn ("fail").
function createFakeSpawn(behaviors) {
  const calls = [];
  function fakeSpawn(command, args, opts) {
    calls.push({ command, args, opts });
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.pid = 10000 + calls.length;
    proc.exitCode = null;
    proc.killed = false;
    proc.kill = () => {
      proc.killed = true;
      proc.exitCode = 0;
      process.nextTick(() => proc.emit("close", 0, null));
    };

    const behavior = behaviors[command] || "fail";
    proc._healthy = behavior === "succeed";

    if (behavior === "fail") {
      process.nextTick(() => proc.emit("error", new Error(`${command} failed to spawn`)));
    }

    return proc;
  }
  return { fakeSpawn, calls };
}

function withHealthTrackingProcess(manager) {
  manager.checkHealth = async function () {
    return !!(this.process && this.process._healthy);
  };
}

// --- isAvailable --------------------------------------------------------

test("isAvailable is true when any known backend has a binary", () => {
  const manager = loadLlamaServerManager({
    allBackends: [makeBackend({ name: "cpu", available: false }), makeBackend({ name: "vulkan" })],
  });
  assert.equal(manager.isAvailable(), true);
});

test("isAvailable is false when no backend has a binary", () => {
  const manager = loadLlamaServerManager({
    allBackends: [
      makeBackend({ name: "cpu", available: false }),
      makeBackend({ name: "vulkan", available: false }),
    ],
  });
  assert.equal(manager.isAvailable(), false);
});

// --- start(): happy path -------------------------------------------------

test("start() succeeds on the first backend in the chain", async () => {
  const cuda = makeBackend({ name: "cuda", gpuAccelerated: true });
  const { fakeSpawn, calls } = createFakeSpawn({ [cuda.getBinaryPath()]: "succeed" });
  const manager = loadLlamaServerManager({ spawn: fakeSpawn, backendChain: [cuda] });
  withHealthTrackingProcess(manager);

  await manager.start(FAKE_MODEL_PATH);

  assert.equal(manager.activeBackend, "cuda");
  assert.equal(manager.ready, true);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes("--cuda-flag"));
  assert.equal(calls[0].opts.env.FAKE_BACKEND, "cuda");
});

// --- start(): fallback across the chain ---------------------------------

test("start() falls back to the next backend when the first fails to spawn", async () => {
  const cuda = makeBackend({ name: "cuda", gpuAccelerated: true });
  const vulkan = makeBackend({ name: "vulkan", gpuAccelerated: true });
  const { fakeSpawn, calls } = createFakeSpawn({
    [cuda.getBinaryPath()]: "fail",
    [vulkan.getBinaryPath()]: "succeed",
  });
  const manager = loadLlamaServerManager({
    spawn: fakeSpawn,
    backendChain: [cuda, vulkan, makeBackend({ name: "cpu" })],
  });
  withHealthTrackingProcess(manager);

  await manager.start(FAKE_MODEL_PATH);

  assert.equal(manager.activeBackend, "vulkan");
  assert.equal(manager.ready, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, cuda.getBinaryPath());
  assert.equal(calls[1].command, vulkan.getBinaryPath());
});

test("start() skips backends whose binary is unavailable without spawning them", async () => {
  const cuda = makeBackend({ name: "cuda", available: false });
  const cpu = makeBackend({ name: "cpu" });
  const { fakeSpawn, calls } = createFakeSpawn({ [cpu.getBinaryPath()]: "succeed" });
  const manager = loadLlamaServerManager({ spawn: fakeSpawn, backendChain: [cuda, cpu] });
  withHealthTrackingProcess(manager);

  await manager.start(FAKE_MODEL_PATH);

  assert.equal(manager.activeBackend, "cpu");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, cpu.getBinaryPath());
});

test("start() rejects when every backend in the chain fails to spawn", async () => {
  const cuda = makeBackend({ name: "cuda" });
  const cpu = makeBackend({ name: "cpu" });
  const { fakeSpawn, calls } = createFakeSpawn({
    [cuda.getBinaryPath()]: "fail",
    [cpu.getBinaryPath()]: "fail",
  });
  const manager = loadLlamaServerManager({ spawn: fakeSpawn, backendChain: [cuda, cpu] });
  withHealthTrackingProcess(manager);

  await assert.rejects(() => manager.start(FAKE_MODEL_PATH), /failed to spawn/i);

  assert.equal(calls.length, 2);
  assert.equal(manager.ready, false);
  assert.equal(manager.process, null);
});

test("start() throws immediately when no backend in the chain has a binary", async () => {
  const manager = loadLlamaServerManager({
    backendChain: [makeBackend({ name: "cuda", available: false })],
  });

  await assert.rejects(() => manager.start(FAKE_MODEL_PATH), /llama-server binary not found/);
});

// --- getStatus() gpuAccelerated flag -------------------------------------

test("getStatus reports gpuAccelerated for cuda, vulkan and metal but not cpu", () => {
  const manager = loadLlamaServerManager({});
  manager.ready = true;
  manager.process = {};

  for (const backend of ["cuda", "vulkan", "metal"]) {
    manager.activeBackend = backend;
    assert.equal(manager.getStatus().gpuAccelerated, true, `${backend} should be gpu-accelerated`);
  }

  manager.activeBackend = "cpu";
  assert.equal(manager.getStatus().gpuAccelerated, false);
});
