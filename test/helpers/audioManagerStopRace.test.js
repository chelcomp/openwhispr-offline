// Regression test for docs/specs/pcm-collector-stop-race-fix.md.
//
// `stopRecording()` (src/helpers/audioManager.js) installs a temporary
// `onmessage` handler on the PCM collector's port to catch the AudioWorklet's
// async "done" sentinel. Before the fix, that closure re-read
// `this._pcmCollector`/`this._pcmChunks` at message-arrival time, which races
// with other paths (cleanup(), teardownSpeechGate(), a failed
// startRecording() retry) nulling/reassigning those fields first — causing a
// `TypeError: Cannot read properties of null (reading 'port')` thrown
// *before* `resolve()`, permanently hanging `_pcmFlushPromise`.
//
// Same esbuild-transform + happy-dom harness pattern as
// audioManagerWarmup.test.js — real, unmodified src/helpers/audioManager.js
// loaded via a CommonJS require hook, `Object.create(AudioManager.prototype)`
// to bypass the constructor, minimal manual stubbing of only the fields each
// test touches.

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const fs = require("node:fs");
const esbuild = require("esbuild");
const { GlobalRegistrator } = require("@happy-dom/global-registrator");

GlobalRegistrator.register();

const srcRoot = path.resolve(__dirname, "..", "..", "src");

function transformLoader(loaderKind) {
  return function (module, filename) {
    const source = fs.readFileSync(filename, "utf8");
    const { code } = esbuild.transformSync(source, {
      loader: loaderKind,
      jsx: "automatic",
      format: "cjs",
      target: "node26",
      sourcefile: path.basename(filename),
    });
    module._compile(code, filename);
  };
}
const jsLoader = transformLoader("js");
const tsLoader = transformLoader("ts");
const tsxLoader = transformLoader("tsx");

const origJsExt = Module._extensions[".js"];
Module._extensions[".js"] = function (module, filename) {
  if (filename.startsWith(srcRoot)) return jsLoader(module, filename);
  return origJsExt(module, filename);
};
Module._extensions[".ts"] = tsLoader;
Module._extensions[".tsx"] = tsxLoader;
Module._extensions[".jsx"] = tsxLoader;

// Vite's TS-aware resolver lets source files `import "./Foo.js"` when the
// actual file on disk is `Foo.ts`/`Foo.tsx`. Plain Node `require()` has no
// such fallback, so redirect explicit `.js` requests that don't exist to a
// sibling `.ts`/`.tsx` file, same as `tsxRegister.js`'s sibling resolution
// need (but for require-time resolution rather than extension transform).
const origResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  try {
    return origResolveFilename.call(this, request, parent, isMain, options);
  } catch (err) {
    if (request.endsWith(".js")) {
      const base = request.slice(0, -3);
      for (const ext of [".ts", ".tsx"]) {
        try {
          return origResolveFilename.call(this, base + ext, parent, isMain, options);
        } catch {
          // try next extension
        }
      }
    }
    throw err;
  }
};

// Stub only the modules that are either heavyweight (network-capable
// services), stateful singletons unsafe to construct in a test process, or
// require a full i18next runtime we don't need for this test's assertions.
const STUBS = {
  "../services/ReasoningService": () => ({
    __esModule: true,
    default: class ReasoningService {},
  }),
  "../services/SyncService.js": () => ({ syncService: {} }),
  "../lib/auth": () => ({ withSessionRefresh: async (fn) => fn() }),
  "react-i18next": () => ({
    useTranslation: () => ({ t: (key) => key }),
    initReactI18next: { type: "3rdParty", init: () => {} },
  }),
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (STUBS[request]) return STUBS[request]();
  return origLoad.call(this, request, parent, isMain);
};

test.after(async () => {
  Module._extensions[".js"] = origJsExt;
  Module._resolveFilename = origResolveFilename;
  Module._load = origLoad;
  await GlobalRegistrator.unregister();
});

const AudioManager = require("../../src/helpers/audioManager.js").default;

function makeManager() {
  // Bypass the constructor (which wires up window/navigator listeners
  // irrelevant to stopRecording) via Object.create, matching the
  // "minimally-stubbed instance" pattern already used elsewhere.
  return Object.create(AudioManager.prototype);
}

function makeMockPort() {
  return {
    onmessage: null,
    postMessage: () => {},
  };
}

test("stopRecording()'s temporary handler does not throw and still resolves the flush promise when _pcmCollector is nulled before the 'done' sentinel arrives", async () => {
  const manager = makeManager();
  manager.screenContextCache = { recordRecordingStopped: () => {} };
  manager.mediaRecorder = { state: "recording", stop: () => {} };
  const mockPort = makeMockPort();
  manager._pcmCollector = { port: mockPort };
  manager._pcmChunks = [];

  const started = manager.stopRecording();
  assert.equal(started, true);

  const capturedHandler = mockPort.onmessage;
  assert.equal(typeof capturedHandler, "function");

  // Simulate the race: some other path (cleanup()/teardownSpeechGate()) nulls
  // _pcmCollector before the worklet's async "done" message arrives.
  manager._pcmCollector = null;

  // Requirement 1: invoking the captured handler must not throw, regardless
  // of what this._pcmCollector currently holds. This assertion must run and
  // be evaluated before anything awaits manager._pcmFlushPromise — before the
  // fix, this throws synchronously ("Cannot read properties of null"), so a
  // pre-fix run fails cleanly here rather than hanging on a bare await.
  assert.doesNotThrow(() => {
    capturedHandler({ data: null });
  });

  // Requirement 2: the flush promise must still eventually resolve — this
  // is the more severe half of the bug (a silent, permanent hang) that the
  // no-throw assertion alone would not catch.
  await manager._pcmFlushPromise;
});

test("stopRecording()'s temporary handler appends partial chunks to the array captured at stop-time, not to a reassigned this._pcmChunks", async () => {
  const manager = makeManager();
  manager.screenContextCache = { recordRecordingStopped: () => {} };
  manager.mediaRecorder = { state: "recording", stop: () => {} };
  const mockPort = makeMockPort();
  manager._pcmCollector = { port: mockPort };
  const originalChunks = [];
  manager._pcmChunks = originalChunks;

  manager.stopRecording();
  const capturedHandler = mockPort.onmessage;
  assert.equal(typeof capturedHandler, "function");

  // Simulate an overlapping startRecording() reassigning _pcmChunks to a
  // brand-new array before the old flush's messages arrive.
  const newChunks = [];
  manager._pcmChunks = newChunks;

  const partialChunkData = new Int16Array([1, 2, 3]).buffer;
  capturedHandler({ data: partialChunkData });
  capturedHandler({ data: null });

  await manager._pcmFlushPromise;

  assert.equal(originalChunks.length, 1);
  assert.ok(originalChunks[0] instanceof Int16Array);
  assert.deepEqual(Array.from(originalChunks[0]), [1, 2, 3]);
  assert.equal(newChunks.length, 0);
});
