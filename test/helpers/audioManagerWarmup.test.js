// Regression test for docs/specs/on-demand-model-lifecycle.md's
// `warmupTranscriptionEngine()` (src/helpers/audioManager.js) and its call-site
// ordering relative to `warmupReasoningServer()` in
// `useAudioRecording.js`'s `performStartRecording`.
//
// `audioManager.js`/`useAudioRecording.js` are renderer-side ESM files with a
// large, TypeScript-heavy import graph (ReasoningService, SyncService, auth,
// settingsStore, etc.) that isn't meant to run outside a bundler. This file
// installs a narrow, self-contained CommonJS require hook (esbuild transform
// for `.js`/`.ts`/`.tsx`/`.jsx` under `src/`, with Vite-style ".js request
// resolves to a sibling .ts file" fallback resolution) plus happy-dom globals,
// mirroring the existing `test/setup/tsxRegister.js` harness used for
// component tests. Only the handful of genuinely heavy/side-effectful modules
// (ReasoningService, SyncService's singleton, the auth lib, react-i18next)
// are stubbed — everything else (including `warmupTranscriptionEngine()`
// itself and `performStartRecording`) is the real, unmodified source.

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
    // `src/i18n.ts` (transitively pulled in via settingsStore.ts, which
    // useAudioRecording.js's real `getSettings` import needs) calls
    // `i18n.use(initReactI18next)` — i18next's `.use()` only requires a
    // `type` field to accept the plugin, so a minimal stand-in satisfies it
    // without pulling in a real i18next/react-i18next runtime.
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
  // irrelevant to warmupTranscriptionEngine) via Object.create, matching the
  // "minimally-stubbed instance" pattern already used in
  // pasteTextMonitorInvariant.test.js.
  return Object.create(AudioManager.prototype);
}

test.afterEach(() => {
  delete global.window.electronAPI;
});

test("warms the Whisper server when configured for local Whisper", () => {
  const manager = makeManager();
  const calls = [];
  global.window.electronAPI = {
    whisperServerStart: (model, language) => {
      calls.push(["whisper", model, language]);
      return Promise.resolve();
    },
    parakeetServerStart: () => {
      calls.push(["parakeet"]);
      return Promise.resolve();
    },
  };

  manager.warmupTranscriptionEngine({
    useLocalWhisper: true,
    localTranscriptionProvider: "whisper",
    whisperModel: "base",
    parakeetModel: null,
  });

  assert.deepEqual(calls, [["whisper", "base", undefined]]);
});

test("warms the Whisper server with the resolved effective language when preferredLanguage is set", () => {
  const manager = makeManager();
  const calls = [];
  global.window.electronAPI = {
    whisperServerStart: (model, language) => {
      calls.push(["whisper", model, language]);
      return Promise.resolve();
    },
    parakeetServerStart: () => {
      calls.push(["parakeet"]);
      return Promise.resolve();
    },
  };

  manager.warmupTranscriptionEngine({
    useLocalWhisper: true,
    localTranscriptionProvider: "whisper",
    whisperModel: "base",
    parakeetModel: null,
    preferredLanguage: "pt",
  });

  assert.deepEqual(calls, [["whisper", "base", "pt"]]);
});

test("warms the Parakeet server when configured for the nvidia provider", () => {
  const manager = makeManager();
  const calls = [];
  global.window.electronAPI = {
    whisperServerStart: (model) => {
      calls.push(["whisper", model]);
      return Promise.resolve();
    },
    parakeetServerStart: (model) => {
      calls.push(["parakeet", model]);
      return Promise.resolve();
    },
  };

  manager.warmupTranscriptionEngine({
    useLocalWhisper: true,
    localTranscriptionProvider: "nvidia",
    whisperModel: null,
    parakeetModel: "parakeet-tdt-0.6b-v3",
  });

  assert.deepEqual(calls, [["parakeet", "parakeet-tdt-0.6b-v3"]]);
});

test("is a no-op for cloud/BYOK providers (useLocalWhisper false)", () => {
  const manager = makeManager();
  const calls = [];
  global.window.electronAPI = {
    whisperServerStart: (...args) => {
      calls.push(["whisper", ...args]);
      return Promise.resolve();
    },
    parakeetServerStart: (...args) => {
      calls.push(["parakeet", ...args]);
      return Promise.resolve();
    },
  };

  manager.warmupTranscriptionEngine({
    useLocalWhisper: false,
    localTranscriptionProvider: "whisper",
    whisperModel: "base",
    parakeetModel: "parakeet-tdt-0.6b-v3",
  });

  assert.deepEqual(calls, []);
});

test("is a no-op when no model is configured for the selected local provider", () => {
  const manager = makeManager();
  const calls = [];
  global.window.electronAPI = {
    whisperServerStart: (...args) => calls.push(["whisper", ...args]),
    parakeetServerStart: (...args) => calls.push(["parakeet", ...args]),
  };

  manager.warmupTranscriptionEngine({
    useLocalWhisper: true,
    localTranscriptionProvider: "whisper",
    whisperModel: null,
    parakeetModel: null,
  });

  assert.deepEqual(calls, []);
});

test("never throws/rejects even if the underlying IPC call rejects (fire-and-forget)", async () => {
  const manager = makeManager();
  global.window.electronAPI = {
    whisperServerStart: () => Promise.reject(new Error("sidecar failed to spawn")),
  };

  // warmupTranscriptionEngine() itself returns synchronously (undefined), so
  // assert.doesNotThrow alone can't prove the underlying rejection was
  // actually swallowed via `.catch(() => {})` rather than left to surface as
  // an unhandled rejection later. Listen for that instead — this fails if
  // the `.catch` is ever removed from the real implementation.
  let sawUnhandledRejection = false;
  const onUnhandledRejection = () => {
    sawUnhandledRejection = true;
  };
  process.once("unhandledRejection", onUnhandledRejection);

  assert.doesNotThrow(() => {
    manager.warmupTranscriptionEngine({
      useLocalWhisper: true,
      localTranscriptionProvider: "whisper",
      whisperModel: "base",
      parakeetModel: null,
    });
  });

  // Let the rejected promise's microtask queue (and any unhandledRejection
  // dispatch) settle before asserting.
  await new Promise((resolve) => setImmediate(resolve));
  process.removeListener("unhandledRejection", onUnhandledRejection);
  assert.equal(sawUnhandledRejection, false);
});

test("never throws when window.electronAPI itself is unavailable", () => {
  const manager = makeManager();
  global.window.electronAPI = undefined;

  assert.doesNotThrow(() => {
    manager.warmupTranscriptionEngine({
      useLocalWhisper: true,
      localTranscriptionProvider: "whisper",
      whisperModel: "base",
      parakeetModel: null,
    });
  });
});

// --- Call-site ordering in useAudioRecording.js's performStartRecording ----
//
// Asserts warmupTranscriptionEngine() is issued before warmupReasoningServer()
// on recording start, and that neither call is awaited before the other is
// issued (both remain fire-and-forget, back-to-back).

test("performStartRecording issues warmupTranscriptionEngine before warmupReasoningServer, without awaiting either", async () => {
  const { renderHook, act } = require("@testing-library/react");

  const callOrder = [];
  let resolveWhisperWarmup;
  const whisperWarmupPromise = new Promise((resolve) => {
    resolveWhisperWarmup = resolve;
  });

  global.window.electronAPI = {
    whisperServerStart: () => {
      callOrder.push("transcription");
      // Deliberately never resolves synchronously — proves the call site
      // doesn't await this before moving on to warmupReasoningServer.
      return whisperWarmupPromise;
    },
    llamaServerStart: () => {
      callOrder.push("reasoning");
      return Promise.resolve();
    },
    getSttConfig: () => Promise.resolve({ success: false }),
    onToggleDictation: () => () => {},
    onToggleVoiceAgent: () => () => {},
    onStartDictation: () => () => {},
    onStopDictation: () => () => {},
    onNoAudioDetected: () => () => {},
  };

  const { useAudioRecording } = require("../../src/hooks/useAudioRecording.js");
  // `getSettings()` reads from the real zustand settingsStore, whose default
  // state is computed once at module-import time from localStorage — setting
  // localStorage keys *after* that first import (which already happened
  // transitively via the earlier `audioManager.js` require at the top of
  // this file) has no effect. Use the store's own setters instead, which is
  // also how the app itself updates settings at runtime.
  const { useSettingsStore } = require("../../src/stores/settingsStore.ts");
  const store = useSettingsStore.getState();
  store.setUseLocalWhisper(true);
  store.setWhisperModel("base");
  store.setLocalTranscriptionProvider("whisper");
  // Also make warmupReasoningServer() resolve to a local reasoning model, so
  // its call is actually observable in callOrder (cleanup-mode local model).
  store.setLocalModel("qwen2.5-3b-instruct-q4");
  store.setUseCleanupModel(true);
  store.setCleanupMode("local");

  const { result } = renderHook(() => useAudioRecording(() => {}));

  await act(async () => {
    await result.current.startRecording();
  });

  // Resolve the deliberately-pending whisper warmup after the fact — proves
  // it was never awaited (the reasoning warmup already fired before this).
  resolveWhisperWarmup();

  assert.deepEqual(callOrder, ["transcription", "reasoning"]);
});
