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

function loadLlamaServerManager({ spawn, backendChain, allBackends, execFileSync, http } = {}) {
  delete require.cache[llamaServerPath];

  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "child_process" && (spawn || execFileSync)) {
      return {
        ...childProcess,
        ...(spawn ? { spawn } : {}),
        ...(execFileSync ? { execFileSync } : {}),
      };
    }
    if (request === "http" && http) {
      return http;
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

// Fake execFileSync for the --help capability probe. `responses[binaryPath]`
// can be a help-text string, or a function to simulate a throwing probe.
function createFakeExecFileSync(responses) {
  const calls = [];
  function fakeExecFileSync(command, args) {
    calls.push({ command, args });
    const response = responses[command];
    if (typeof response === "function") return response();
    if (response === undefined) throw new Error(`no --help output for ${command}`);
    return response;
  }
  return { fakeExecFileSync, calls };
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

// Fake `http` module for inference()'s POST /v1/chat/completions request.
// Immediately resolves with the given status code and body.
function createFakeHttp(statusCode, body) {
  return {
    request(_options, callback) {
      const req = new EventEmitter();
      req.write = () => {};
      req.end = () => {
        const res = new EventEmitter();
        res.statusCode = statusCode;
        res.resume = () => {};
        process.nextTick(() => {
          callback(res);
          process.nextTick(() => {
            res.emit("data", Buffer.from(body));
            res.emit("end");
          });
        });
      };
      return req;
    },
  };
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

// --- start(): --ctx-size launch argument ---------------------------------

test("start() passes --ctx-size derived from options.contextSize to the spawned backend", async () => {
  const cuda = makeBackend({ name: "cuda", gpuAccelerated: true });
  const { fakeSpawn, calls } = createFakeSpawn({ [cuda.getBinaryPath()]: "succeed" });
  const manager = loadLlamaServerManager({ spawn: fakeSpawn, backendChain: [cuda] });
  withHealthTrackingProcess(manager);

  await manager.start(FAKE_MODEL_PATH, { contextSize: 32768, threads: 8 });

  const idx = calls[0].args.indexOf("--ctx-size");
  assert.ok(idx !== -1, "--ctx-size flag should be present");
  assert.equal(calls[0].args[idx + 1], "32768");

  // Full-args assertion: guard every other launch parameter too, so a
  // regression to any flag (not just --ctx-size) fails this test.
  assert.deepEqual(calls[0].args, [
    "--model",
    FAKE_MODEL_PATH,
    "--host",
    "127.0.0.1",
    "--port",
    String(manager.port),
    "--threads",
    "8",
    "--ctx-size",
    "32768",
    "--jinja",
    "--cuda-flag",
  ]);
});

test("start() falls back to the default --ctx-size when contextSize is not provided", async () => {
  const LlamaServerManager = require("../../src/helpers/llamaServer");
  const cpu = makeBackend({ name: "cpu" });
  const { fakeSpawn, calls } = createFakeSpawn({ [cpu.getBinaryPath()]: "succeed" });
  const manager = loadLlamaServerManager({ spawn: fakeSpawn, backendChain: [cpu] });
  withHealthTrackingProcess(manager);

  await manager.start(FAKE_MODEL_PATH);

  const idx = calls[0].args.indexOf("--ctx-size");
  assert.ok(idx !== -1, "--ctx-size flag should be present");
  assert.equal(calls[0].args[idx + 1], String(LlamaServerManager.DEFAULT_CONTEXT_SIZE));

  assert.deepEqual(calls[0].args, [
    "--model",
    FAKE_MODEL_PATH,
    "--host",
    "127.0.0.1",
    "--port",
    String(manager.port),
    "--threads",
    "4",
    "--ctx-size",
    String(LlamaServerManager.DEFAULT_CONTEXT_SIZE),
    "--jinja",
    "--cpu-flag",
  ]);
});

test("start() falls back to the default --ctx-size when contextSize is invalid (non-positive/NaN)", async () => {
  const LlamaServerManager = require("../../src/helpers/llamaServer");
  const cpu = makeBackend({ name: "cpu" });
  const { fakeSpawn, calls } = createFakeSpawn({ [cpu.getBinaryPath()]: "succeed" });
  const manager = loadLlamaServerManager({ spawn: fakeSpawn, backendChain: [cpu] });
  withHealthTrackingProcess(manager);

  await manager.start(FAKE_MODEL_PATH, { contextSize: -1 });

  const idx = calls[0].args.indexOf("--ctx-size");
  assert.equal(calls[0].args[idx + 1], String(LlamaServerManager.DEFAULT_CONTEXT_SIZE));
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

// --- start(): MAX_CONTEXT_SIZE clamp --------------------------------------

test("start() caps --ctx-size at MAX_CONTEXT_SIZE (65536) when options.contextSize exceeds it", async () => {
  const LlamaServerManager = require("../../src/helpers/llamaServer");
  const cpu = makeBackend({ name: "cpu" });
  const { fakeSpawn, calls } = createFakeSpawn({ [cpu.getBinaryPath()]: "succeed" });
  const manager = loadLlamaServerManager({ spawn: fakeSpawn, backendChain: [cpu] });
  withHealthTrackingProcess(manager);

  await manager.start(FAKE_MODEL_PATH, { contextSize: 262144 });

  const idx = calls[0].args.indexOf("--ctx-size");
  assert.equal(calls[0].args[idx + 1], String(LlamaServerManager.MAX_CONTEXT_SIZE));
  assert.equal(calls[0].args[idx + 1], "65536");
});

test("start() passes through options.contextSize unchanged when at or below MAX_CONTEXT_SIZE", async () => {
  const cpu = makeBackend({ name: "cpu" });
  {
    const { fakeSpawn, calls } = createFakeSpawn({ [cpu.getBinaryPath()]: "succeed" });
    const manager = loadLlamaServerManager({ spawn: fakeSpawn, backendChain: [cpu] });
    withHealthTrackingProcess(manager);
    await manager.start(FAKE_MODEL_PATH, { contextSize: 4096 });
    const idx = calls[0].args.indexOf("--ctx-size");
    assert.equal(calls[0].args[idx + 1], "4096");
  }
  {
    const { fakeSpawn, calls } = createFakeSpawn({ [cpu.getBinaryPath()]: "succeed" });
    const manager = loadLlamaServerManager({ spawn: fakeSpawn, backendChain: [cpu] });
    withHealthTrackingProcess(manager);
    await manager.start(FAKE_MODEL_PATH, { contextSize: 32768 });
    const idx = calls[0].args.indexOf("--ctx-size");
    assert.equal(calls[0].args[idx + 1], "32768");
  }
});

// --- start(): capability-gated KV-cache/flash-attn/--fit flags -----------

const HELP_ALL_CAPS =
  "... --cache-type-k ... --cache-type-v ... --flash-attn ... -fit, --fit [on|off] ...";
const HELP_KV_ONLY = "... --cache-type-k ... --cache-type-v ... --flash-attn ...";
const HELP_NONE = "... --some-other-flag ...";

test("start() adds KV-cache quantization and flash-attn flags when the resolved binary's --help advertises support", async () => {
  const cpu = makeBackend({ name: "cpu" });
  const { fakeSpawn, calls } = createFakeSpawn({ [cpu.getBinaryPath()]: "succeed" });
  const { fakeExecFileSync } = createFakeExecFileSync({ [cpu.getBinaryPath()]: HELP_KV_ONLY });
  const manager = loadLlamaServerManager({
    spawn: fakeSpawn,
    execFileSync: fakeExecFileSync,
    backendChain: [cpu],
  });
  withHealthTrackingProcess(manager);

  await manager.start(FAKE_MODEL_PATH);

  const args = calls[0].args;
  assert.ok(args.includes("--cache-type-k"));
  assert.equal(args[args.indexOf("--cache-type-k") + 1], "q8_0");
  assert.ok(args.includes("--cache-type-v"));
  assert.equal(args[args.indexOf("--cache-type-v") + 1], "q8_0");
  assert.ok(args.includes("--flash-attn"));
  assert.equal(args[args.indexOf("--flash-attn") + 1], "on");
  assert.ok(!args.includes("--fit"));
});

test("start() omits KV-cache quantization and flash-attn flags when the binary's --help does not advertise support", async () => {
  const cpu = makeBackend({ name: "cpu" });
  const { fakeSpawn, calls } = createFakeSpawn({ [cpu.getBinaryPath()]: "succeed" });
  const { fakeExecFileSync } = createFakeExecFileSync({ [cpu.getBinaryPath()]: HELP_NONE });
  const manager = loadLlamaServerManager({
    spawn: fakeSpawn,
    execFileSync: fakeExecFileSync,
    backendChain: [cpu],
  });
  withHealthTrackingProcess(manager);

  await manager.start(FAKE_MODEL_PATH);

  const args = calls[0].args;
  assert.ok(!args.includes("--cache-type-k"));
  assert.ok(!args.includes("--flash-attn"));
  assert.ok(args.includes("--ctx-size"));
});

test("start() adds --fit on alongside --n-gpu-layers 99 when the resolved binary's --help advertises --fit support", async () => {
  const cuda = makeBackend({ name: "cuda", gpuAccelerated: true });
  const { fakeSpawn, calls } = createFakeSpawn({ [cuda.getBinaryPath()]: "succeed" });
  const { fakeExecFileSync } = createFakeExecFileSync({
    [cuda.getBinaryPath()]: "-fit, --fit [on|off] ...",
  });
  // makeBackend's fake buildArgs doesn't add --n-gpu-layers; simulate it here
  // by wrapping buildArgs to append the pair, matching real CudaBackend shape.
  cuda.buildArgs = (base) => [...base, "--cuda-flag", "--n-gpu-layers", "99"];
  const manager = loadLlamaServerManager({
    spawn: fakeSpawn,
    execFileSync: fakeExecFileSync,
    backendChain: [cuda],
  });
  withHealthTrackingProcess(manager);

  await manager.start(FAKE_MODEL_PATH);

  const args = calls[0].args;
  const gpuLayersIdx = args.indexOf("--n-gpu-layers");
  assert.ok(gpuLayersIdx !== -1);
  assert.equal(args[gpuLayersIdx + 1], "99");
  assert.equal(args[gpuLayersIdx + 2], "--fit");
  assert.equal(args[gpuLayersIdx + 3], "on");
});

test("start() omits --fit when the binary's --help does not advertise --fit support", async () => {
  const cuda = makeBackend({ name: "cuda", gpuAccelerated: true });
  cuda.buildArgs = (base) => [...base, "--cuda-flag", "--n-gpu-layers", "99"];
  const { fakeSpawn, calls } = createFakeSpawn({ [cuda.getBinaryPath()]: "succeed" });
  const { fakeExecFileSync } = createFakeExecFileSync({ [cuda.getBinaryPath()]: HELP_NONE });
  const manager = loadLlamaServerManager({
    spawn: fakeSpawn,
    execFileSync: fakeExecFileSync,
    backendChain: [cuda],
  });
  withHealthTrackingProcess(manager);

  await manager.start(FAKE_MODEL_PATH);

  const args = calls[0].args;
  assert.ok(!args.includes("--fit"));
  assert.ok(args.includes("--n-gpu-layers"));
  assert.equal(args[args.indexOf("--n-gpu-layers") + 1], "99");
});

test("start() retries the same backend without KV-cache/flash-attn/--fit flags once if the flagged attempt fails, before falling through to the next backend", async () => {
  const cpu = makeBackend({ name: "cpu" });
  const secondBackend = makeBackend({
    name: "vulkan",
    binaryPath: "/bin/llama-server-vulkan-unused",
  });
  const binaryPath = cpu.getBinaryPath();

  const { fakeExecFileSync } = createFakeExecFileSync({ [binaryPath]: HELP_ALL_CAPS });

  const calls = [];
  function fakeSpawn(command, args, opts) {
    calls.push({ command, args, opts });
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.pid = 10000 + calls.length;
    proc.killed = false;
    proc.kill = () => {
      proc.killed = true;
      process.nextTick(() => proc.emit("close", 0, null));
    };
    // First invocation (with capability flags) fails to spawn; second
    // invocation (flags stripped) succeeds.
    const isFirstAttempt = calls.length === 1;
    proc._healthy = !isFirstAttempt;
    if (isFirstAttempt) {
      process.nextTick(() => proc.emit("error", new Error("spawn failed")));
    }
    return proc;
  }

  const manager = loadLlamaServerManager({
    spawn: fakeSpawn,
    execFileSync: fakeExecFileSync,
    backendChain: [cpu, secondBackend],
  });
  withHealthTrackingProcess(manager);

  await manager.start(FAKE_MODEL_PATH);

  assert.equal(manager.activeBackend, "cpu");
  assert.equal(manager.ready, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, binaryPath);
  assert.equal(calls[1].command, binaryPath);
  assert.ok(!calls[1].args.includes("--cache-type-k"));
  assert.ok(!calls[1].args.includes("--fit"));
});

test("probeBinaryCapabilities() caches its result per binary path and does not re-invoke execFileSync on a second start with the same binary", async () => {
  const cpu = makeBackend({ name: "cpu" });
  const { fakeSpawn, calls } = createFakeSpawn({ [cpu.getBinaryPath()]: "succeed" });
  const { fakeExecFileSync, calls: execCalls } = createFakeExecFileSync({
    [cpu.getBinaryPath()]: HELP_ALL_CAPS,
  });
  const manager = loadLlamaServerManager({
    spawn: fakeSpawn,
    execFileSync: fakeExecFileSync,
    backendChain: [cpu],
  });
  withHealthTrackingProcess(manager);

  await manager.start(FAKE_MODEL_PATH);
  await manager.stop();
  await manager.start(FAKE_MODEL_PATH);

  assert.equal(execCalls.length, 1);
  assert.ok(calls[0].args.includes("--cache-type-k"));
  assert.ok(calls[1].args.includes("--cache-type-k"));
});

// --- inference(): context-overflow detection -----------------------------

test("inference() throws ContextOverflowError when the server's error body matches the context-overflow signature", async () => {
  const body = JSON.stringify({
    error: { message: "the request exceeds the available context size, try increasing it" },
  });
  const manager = loadLlamaServerManager({ http: createFakeHttp(400, body) });
  const LlamaServerManager = require("../../src/helpers/llamaServer");
  manager.ready = true;
  manager.process = { killed: false };
  manager.port = 8221;

  await assert.rejects(
    () => manager.inference([{ role: "user", content: "hi" }]),
    (err) => {
      assert.ok(err instanceof LlamaServerManager.ContextOverflowError);
      assert.equal(err.isContextOverflow, true);
      return true;
    }
  );
});

test("inference() throws a plain Error (not ContextOverflowError) for an unrelated non-200 response", async () => {
  const body = JSON.stringify({ error: { message: "invalid request: missing field" } });
  const manager = loadLlamaServerManager({ http: createFakeHttp(400, body) });
  const LlamaServerManager = require("../../src/helpers/llamaServer");
  manager.ready = true;
  manager.process = { killed: false };
  manager.port = 8221;

  await assert.rejects(
    () => manager.inference([{ role: "user", content: "hi" }]),
    (err) => {
      assert.ok(!(err instanceof LlamaServerManager.ContextOverflowError));
      return true;
    }
  );
});
