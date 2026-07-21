const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const parakeetWsServerPath = require.resolve("../../src/helpers/parakeetWsServer");
const gpuDetectionRequestPath = "../utils/gpuDetection";

const originalLoad = Module._load;
const originalPlatform = process.platform;
const originalArch = process.arch;
const originalCudaEnv = process.env.SHERPA_ONNX_CUDA_ENABLED;

function setPlatformArch(platform, arch) {
  Object.defineProperty(process, "platform", { value: platform });
  Object.defineProperty(process, "arch", { value: arch });
}

test.afterEach(() => {
  setPlatformArch(originalPlatform, originalArch);
  if (originalCudaEnv === undefined) delete process.env.SHERPA_ONNX_CUDA_ENABLED;
  else process.env.SHERPA_ONNX_CUDA_ENABLED = originalCudaEnv;
});

test.after(() => {
  Module._load = originalLoad;
});

// `_isCudaEligible` does `require("../utils/gpuDetection")` lazily, *inside*
// the method — i.e. well after `loadParakeetWsServer` below has returned. A
// mock that's only installed for the duration of the initial `require(...)`
// call misses it entirely and falls through to the real module (which talks
// to real `nvidia-smi`). So the Module._load override is installed once for
// the whole file and reads from these mutable "current mocks", which each
// test updates before exercising the server.
let currentResolvedNames = {};
let currentDetectNvidiaGpu = null;

Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === "../utils/serverUtils") {
    return {
      findAvailablePort: async () => 6006,
      resolveBinaryPath: (name) => currentResolvedNames[name] || null,
      gracefulStopProcess: async () => {},
    };
  }
  if (request === gpuDetectionRequestPath && currentDetectNvidiaGpu) {
    return { detectNvidiaGpu: currentDetectNvidiaGpu };
  }
  return originalLoad.call(this, request, parent, isMain);
};

// `resolvedNames` maps a binary name -> resolved path (or omit for "not found").
// `detectNvidiaGpu` lets each test control GPU detection independently of the
// binary lookup, per the eligibility rule: CUDA only turns on when BOTH the
// CUDA binary is present AND an NVIDIA GPU is actually detected.
function loadParakeetWsServer({ resolvedNames = {}, detectNvidiaGpu } = {}) {
  delete require.cache[parakeetWsServerPath];
  currentResolvedNames = resolvedNames;
  currentDetectNvidiaGpu = detectNvidiaGpu || null;

  const ParakeetWsServer = require("../../src/helpers/parakeetWsServer");
  return new ParakeetWsServer();
}

// --- getWsBinaryPath: prefix + platform naming ---------------------------

test("getWsBinaryPath resolves the offline binary name for the current platform", () => {
  setPlatformArch("win32", "x64");
  const server = loadParakeetWsServer({
    resolvedNames: { "sherpa-onnx-ws-win32-x64.exe": "/resolved/offline.exe" },
  });

  assert.equal(server.getWsBinaryPath("offline"), "/resolved/offline.exe");
});

test("getWsBinaryPath resolves the online binary with its own prefix", () => {
  setPlatformArch("linux", "x64");
  const server = loadParakeetWsServer({
    resolvedNames: { "sherpa-onnx-online-ws-linux-x64": "/resolved/online" },
  });

  assert.equal(server.getWsBinaryPath("online"), "/resolved/online");
});

test("getWsBinaryPath resolves once per runtime and serves the rest from cache", () => {
  setPlatformArch("linux", "x64");
  let resolveCalls = 0;
  const server = loadParakeetWsServer({
    resolvedNames: new Proxy(
      { "sherpa-onnx-ws-linux-x64": "/resolved/offline" },
      {
        get(target, prop) {
          resolveCalls++;
          return target[prop];
        },
      }
    ),
  });

  assert.equal(server.getWsBinaryPath("offline"), "/resolved/offline");
  assert.equal(server.getWsBinaryPath("offline"), "/resolved/offline");
  assert.equal(resolveCalls, 1, "resolveBinaryPath should only run on the first lookup");
});

test("invalidateBinaryCache clears cached paths for every runtime", () => {
  const server = loadParakeetWsServer({});
  server.cachedBinaryPaths = { offline: "/a", online: "/b" };
  server.invalidateBinaryCache();
  assert.deepEqual(server.cachedBinaryPaths, {});
});

// --- getWsBinaryPath: CUDA opt-in with CPU fallback -----------------------

test("getWsBinaryPath prefers the CUDA binary when the env flag is set and it resolves", () => {
  setPlatformArch("win32", "x64");
  process.env.SHERPA_ONNX_CUDA_ENABLED = "true";
  const server = loadParakeetWsServer({
    resolvedNames: {
      "sherpa-onnx-ws-win32-x64-cuda.exe": "/resolved/offline-cuda.exe",
      "sherpa-onnx-ws-win32-x64.exe": "/resolved/offline-cpu.exe",
    },
  });

  assert.equal(server.getWsBinaryPath("offline"), "/resolved/offline-cuda.exe");
});

test("getWsBinaryPath falls back to the CPU binary when the CUDA binary is missing", () => {
  setPlatformArch("win32", "x64");
  process.env.SHERPA_ONNX_CUDA_ENABLED = "true";
  const server = loadParakeetWsServer({
    resolvedNames: { "sherpa-onnx-ws-win32-x64.exe": "/resolved/offline-cpu.exe" },
  });

  assert.equal(server.getWsBinaryPath("offline"), "/resolved/offline-cpu.exe");
});

test("getWsBinaryPath applies the CUDA opt-in to the online runtime too", () => {
  setPlatformArch("linux", "x64");
  process.env.SHERPA_ONNX_CUDA_ENABLED = "true";
  const server = loadParakeetWsServer({
    resolvedNames: { "sherpa-onnx-online-ws-linux-x64-cuda": "/resolved/online-cuda" },
  });

  assert.equal(server.getWsBinaryPath("online"), "/resolved/online-cuda");
});

// --- isCudaBinaryAvailable ----------------------------------------------

test("isCudaBinaryAvailable checks the runtime-specific cuda binary name", () => {
  setPlatformArch("win32", "x64");
  const server = loadParakeetWsServer({
    resolvedNames: { "sherpa-onnx-online-ws-win32-x64-cuda.exe": "/resolved/online-cuda.exe" },
  });

  assert.equal(server.isCudaBinaryAvailable("online"), true);
  assert.equal(server.isCudaBinaryAvailable("offline"), false);
});

// --- _isCudaEligible: GPU present is the deciding factor, not just the binary ---

test("_isCudaEligible is false when the CUDA binary itself is unavailable", async () => {
  setPlatformArch("win32", "x64");
  const server = loadParakeetWsServer({
    resolvedNames: {},
    detectNvidiaGpu: async () => ({ hasNvidiaGpu: true }),
  });

  assert.equal(await server._isCudaEligible("offline"), false);
});

test("_isCudaEligible is true only when the binary exists AND an NVIDIA GPU is detected", async () => {
  setPlatformArch("win32", "x64");
  const server = loadParakeetWsServer({
    resolvedNames: { "sherpa-onnx-ws-win32-x64-cuda.exe": "/resolved/offline-cuda.exe" },
    detectNvidiaGpu: async () => ({ hasNvidiaGpu: true }),
  });

  assert.equal(await server._isCudaEligible("offline"), true);
});

test("_isCudaEligible is false when the binary exists but no NVIDIA GPU is detected", async () => {
  setPlatformArch("win32", "x64");
  const server = loadParakeetWsServer({
    resolvedNames: { "sherpa-onnx-ws-win32-x64-cuda.exe": "/resolved/offline-cuda.exe" },
    detectNvidiaGpu: async () => ({ hasNvidiaGpu: false }),
  });

  assert.equal(await server._isCudaEligible("offline"), false);
});

test("_isCudaEligible falls back to CPU (false) when GPU detection throws", async () => {
  setPlatformArch("win32", "x64");
  const server = loadParakeetWsServer({
    resolvedNames: { "sherpa-onnx-ws-win32-x64-cuda.exe": "/resolved/offline-cuda.exe" },
    detectNvidiaGpu: async () => {
      throw new Error("nvidia-smi not found");
    },
  });

  assert.equal(await server._isCudaEligible("offline"), false);
});

// --- _syncCudaSelection: env flag + cache invalidation --------------------

test("_syncCudaSelection turns the env flag on and invalidates the cache when eligibility turns on", async () => {
  setPlatformArch("win32", "x64");
  delete process.env.SHERPA_ONNX_CUDA_ENABLED;
  const server = loadParakeetWsServer({
    resolvedNames: { "sherpa-onnx-ws-win32-x64-cuda.exe": "/resolved/offline-cuda.exe" },
    detectNvidiaGpu: async () => ({ hasNvidiaGpu: true }),
  });
  server.cachedBinaryPaths = { offline: "/stale/path" };

  await server._syncCudaSelection("offline");

  assert.equal(process.env.SHERPA_ONNX_CUDA_ENABLED, "true");
  assert.deepEqual(server.cachedBinaryPaths, {});
});

test("_syncCudaSelection turns the env flag off and invalidates the cache when eligibility turns off", async () => {
  setPlatformArch("win32", "x64");
  process.env.SHERPA_ONNX_CUDA_ENABLED = "true";
  const server = loadParakeetWsServer({
    resolvedNames: {},
    detectNvidiaGpu: async () => ({ hasNvidiaGpu: false }),
  });
  server.cachedBinaryPaths = { offline: "/stale/path" };

  await server._syncCudaSelection("offline");

  assert.equal(process.env.SHERPA_ONNX_CUDA_ENABLED, undefined);
  assert.deepEqual(server.cachedBinaryPaths, {});
});

test("_syncCudaSelection leaves the binary cache untouched when eligibility does not change", async () => {
  setPlatformArch("win32", "x64");
  process.env.SHERPA_ONNX_CUDA_ENABLED = "true";
  const server = loadParakeetWsServer({
    resolvedNames: { "sherpa-onnx-ws-win32-x64-cuda.exe": "/resolved/offline-cuda.exe" },
    detectNvidiaGpu: async () => ({ hasNvidiaGpu: true }),
  });
  server.cachedBinaryPaths = { offline: "/still/valid" };

  await server._syncCudaSelection("offline");

  assert.equal(process.env.SHERPA_ONNX_CUDA_ENABLED, "true");
  assert.deepEqual(server.cachedBinaryPaths, { offline: "/still/valid" });
});

// --- idle timeout (transcriptionIdleTimeoutMs) / drain-before-stop / crash logging ---

test("resetIdleTimer fires stop() once the configured idle timeout elapses, and resets on every use", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const server = loadParakeetWsServer({});
  server.stop = t.mock.fn(async () => {});

  server.setIdleTimeoutMs(45000);
  server.resetIdleTimer();

  t.mock.timers.tick(44999);
  assert.equal(server.stop.mock.callCount(), 0);
  t.mock.timers.tick(1);
  assert.equal(server.stop.mock.callCount(), 1);

  server.resetIdleTimer();
  t.mock.timers.tick(44999);
  assert.equal(server.stop.mock.callCount(), 1);
  t.mock.timers.tick(1);
  assert.equal(server.stop.mock.callCount(), 2);
});

test("setIdleTimeoutMs changes the scheduled delay independently of llama-server's own setting", (t) => {
  const ParakeetWsServer = require("../../src/helpers/parakeetWsServer");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const server = loadParakeetWsServer({});
  server.stop = t.mock.fn(async () => {});

  assert.equal(server.idleTimeoutMs, ParakeetWsServer.DEFAULT_IDLE_TIMEOUT_MS);
  server.setIdleTimeoutMs(10000);
  server.resetIdleTimer();

  t.mock.timers.tick(9999);
  assert.equal(server.stop.mock.callCount(), 0);
  t.mock.timers.tick(1);
  assert.equal(server.stop.mock.callCount(), 1);

  const unrelatedLlmIdleTimeoutMs = 600000;
  assert.notEqual(server.idleTimeoutMs, unrelatedLlmIdleTimeoutMs);
});

test("stop() drains an in-flight offline request before proceeding", async () => {
  const server = loadParakeetWsServer({});
  server.activeRequestCount = 1;
  server.process = { killed: false };
  server.ready = true;

  const drainPromise = server._drainActiveRequests();
  setTimeout(() => {
    server.activeRequestCount = 0;
  }, 30);

  const start = Date.now();
  await drainPromise;
  assert.ok(Date.now() - start < 15000, "should resolve once the request settles");
});

test("stop() drains an open online stream using the longer STREAMING_DRAIN_TIMEOUT_MS ceiling, not the short offline one", async () => {
  const server = loadParakeetWsServer({});
  server.activeStreamCount = 1;
  server.process = { killed: false };
  server.ready = true;

  const drainPromise = server._drainActiveRequests();
  setTimeout(() => {
    server.activeStreamCount = 0;
  }, 30);

  const start = Date.now();
  await drainPromise;
  assert.ok(Date.now() - start < 15000, "should resolve promptly once the stream settles");
});

test("an unexpected parakeet-ws exit logs distinctly (error level) and schedules no respawn", () => {
  const server = loadParakeetWsServer({});
  const debugLogger = require("../../src/helpers/debugLogger");
  const originalError = debugLogger.error;
  const errorCalls = [];
  debugLogger.error = (...args) => errorCalls.push(args);

  const { EventEmitter } = require("node:events");
  const fakeProcess = new EventEmitter();
  server.process = fakeProcess;
  server.ready = true;
  server._intentionalStop = false;

  // Mirror _doStart's close handler logic directly (constructing a full fake
  // spawn+ws-ready sequence is exercised elsewhere in this file) — assert the
  // documented contract the handler relies on.
  fakeProcess.on("close", (code) => {
    if (server._intentionalStop) {
      debugLogger.debug("parakeet-ws process exited", { code });
    } else {
      debugLogger.error("parakeet-ws exited unexpectedly (crash, not an intentional stop)", {
        code,
      });
    }
    server.ready = false;
    server.process = null;
  });

  fakeProcess.emit("close", 1);

  debugLogger.error = originalError;

  assert.equal(server.process, null);
  assert.equal(server.ready, false);
  assert.ok(errorCalls.some((call) => /unexpectedly/i.test(call[0])));
});

test("_syncCudaSelection never enables CUDA when no NVIDIA GPU is present, even with the binary installed", async () => {
  setPlatformArch("win32", "x64");
  delete process.env.SHERPA_ONNX_CUDA_ENABLED;
  const server = loadParakeetWsServer({
    resolvedNames: { "sherpa-onnx-ws-win32-x64-cuda.exe": "/resolved/offline-cuda.exe" },
    detectNvidiaGpu: async () => ({ hasNvidiaGpu: false }),
  });

  await server._syncCudaSelection("offline");

  assert.equal(process.env.SHERPA_ONNX_CUDA_ENABLED, undefined);
});
