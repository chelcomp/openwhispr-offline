// Regression test for docs/specs/dynamic-prompt-vocabulary.md's
// `warmupDynamicVocabulary()`/`getDynamicVocabularyPrompt()`
// (src/helpers/audioManager.js). Mirrors audioManagerWarmup.test.js's harness
// for running this renderer-side ESM/TS-heavy file under plain `node --test`.

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
const { useSettingsStore } = require("../../src/stores/settingsStore.ts");

function makeManager() {
  return Object.create(AudioManager.prototype);
}

test.afterEach(() => {
  delete global.window.electronAPI;
  const store = useSettingsStore.getState();
  store.setDynamicPromptVocabularyEnabled(true);
  store.setDynamicPromptVocabularyIncludeScreenContext(false);
});

test("warmupDynamicVocabulary is a no-op (never calls the IPC) when the master toggle is off", async () => {
  const manager = makeManager();
  let calls = 0;
  global.window.electronAPI = {
    getDynamicVocabularyPrompt: () => {
      calls += 1;
      return Promise.resolve("some, words");
    },
  };
  useSettingsStore.getState().setDynamicPromptVocabularyEnabled(false);

  await manager.warmupDynamicVocabulary();

  assert.equal(calls, 0);
  assert.equal(manager.getDynamicVocabularyPrompt(), null);
});

test("warmupDynamicVocabulary calls the IPC and caches the result when the master toggle is on", async () => {
  const manager = makeManager();
  const calls = [];
  global.window.electronAPI = {
    getDynamicVocabularyPrompt: (options) => {
      calls.push(options);
      return Promise.resolve("Zephyria, Kubernetes");
    },
  };
  useSettingsStore.getState().setDynamicPromptVocabularyEnabled(true);
  useSettingsStore.getState().setDynamicPromptVocabularyIncludeScreenContext(false);

  await manager.warmupDynamicVocabulary();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].includeScreenContext, false);
  assert.equal(manager.getDynamicVocabularyPrompt(), "Zephyria, Kubernetes");
});

test("warmupDynamicVocabulary threads the includeScreenContext toggle through to the IPC call", async () => {
  const manager = makeManager();
  const calls = [];
  global.window.electronAPI = {
    getDynamicVocabularyPrompt: (options) => {
      calls.push(options);
      return Promise.resolve("");
    },
  };
  useSettingsStore.getState().setDynamicPromptVocabularyEnabled(true);
  useSettingsStore.getState().setDynamicPromptVocabularyIncludeScreenContext(true);

  await manager.warmupDynamicVocabulary();

  assert.equal(calls[0].includeScreenContext, true);
});

test("getDynamicVocabularyPrompt returns null before warmup has been called (not yet cached)", () => {
  const manager = makeManager();
  assert.equal(manager.getDynamicVocabularyPrompt(), null);
});

test("warmupDynamicVocabulary is computed once per call, not re-queried repeatedly", async () => {
  const manager = makeManager();
  let calls = 0;
  global.window.electronAPI = {
    getDynamicVocabularyPrompt: () => {
      calls += 1;
      return Promise.resolve("alpha, beta");
    },
  };
  useSettingsStore.getState().setDynamicPromptVocabularyEnabled(true);

  await manager.warmupDynamicVocabulary();
  assert.equal(calls, 1);

  // Simulate multiple synchronous reads during the same recording (e.g. one
  // per progressive VAD chunk) — the cached value is reused, no re-query.
  assert.equal(manager.getDynamicVocabularyPrompt(), "alpha, beta");
  assert.equal(manager.getDynamicVocabularyPrompt(), "alpha, beta");
  assert.equal(calls, 1);
});

test("waitForDynamicVocabularyPrompt awaits an in-flight warmup call instead of racing it", async () => {
  const manager = makeManager();
  let resolveIpc;
  const ipcPromise = new Promise((resolve) => {
    resolveIpc = resolve;
  });
  global.window.electronAPI = {
    getDynamicVocabularyPrompt: () => ipcPromise,
  };
  useSettingsStore.getState().setDynamicPromptVocabularyEnabled(true);

  // Fire-and-forget, exactly like useAudioRecording.js's call site — deliberately not awaited.
  manager.warmupDynamicVocabulary();

  // Reading the plain synchronous getter immediately would race and see null.
  assert.equal(manager.getDynamicVocabularyPrompt(), null);

  const waitPromise = manager.waitForDynamicVocabularyPrompt();
  resolveIpc("Zephyria, Kubernetes");

  assert.equal(await waitPromise, "Zephyria, Kubernetes");
});

test("waitForDynamicVocabularyPrompt resolves to null (never throws) when the in-flight warmup rejects", async () => {
  const manager = makeManager();
  let rejectIpc;
  const ipcPromise = new Promise((_resolve, reject) => {
    rejectIpc = reject;
  });
  global.window.electronAPI = {
    getDynamicVocabularyPrompt: () => ipcPromise,
  };
  useSettingsStore.getState().setDynamicPromptVocabularyEnabled(true);

  manager.warmupDynamicVocabulary();
  const waitPromise = manager.waitForDynamicVocabularyPrompt();
  rejectIpc(new Error("main process error"));

  assert.equal(await waitPromise, null);
});

test("never throws even if the underlying IPC call rejects", async () => {
  const manager = makeManager();
  global.window.electronAPI = {
    getDynamicVocabularyPrompt: () => Promise.reject(new Error("main process error")),
  };
  useSettingsStore.getState().setDynamicPromptVocabularyEnabled(true);

  await assert.doesNotReject(() => manager.warmupDynamicVocabulary());
  assert.equal(manager.getDynamicVocabularyPrompt(), null);
});

test("never throws when window.electronAPI itself is unavailable", async () => {
  const manager = makeManager();
  global.window.electronAPI = undefined;
  useSettingsStore.getState().setDynamicPromptVocabularyEnabled(true);

  await assert.doesNotReject(() => manager.warmupDynamicVocabulary());
  assert.equal(manager.getDynamicVocabularyPrompt(), null);
});
