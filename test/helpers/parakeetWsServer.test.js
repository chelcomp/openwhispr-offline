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
