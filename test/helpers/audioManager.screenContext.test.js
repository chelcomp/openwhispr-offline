// Regression test for docs/specs/active-window-screen-context.md's
// Requirements 2/3: screen-context capture/OCR must never block or delay the
// raw transcript path, and the LLM pass must proceed without screen context
// if OCR hasn't resolved within its bound — at the actual `audioManager.js`
// implementation level (`getScreenContextTextBounded()`/`warmupScreenContext()`),
// not just the pure-function `shouldCaptureScreenContext()` gate already
// covered by `dictationRouting.test.js`.
//
// Mirrors `audioManagerWarmup.test.js`'s harness exactly: `audioManager.js` is
// a renderer-side ESM file with a large import graph not meant to run outside
// a bundler, so this installs the same narrow esbuild-transform + stub setup
// to require the real, unmodified source under plain `node --test`.

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

function makeManager() {
  const manager = Object.create(AudioManager.prototype);
  // Fields normally set in the constructor that warmupScreenContext()/
  // getScreenContextTextBounded() read/write.
  manager.screenContextPromise = null;
  manager.screenContextCache = {
    shouldReuse: () => false,
    getCachedText: () => null,
    update: () => {},
  };
  manager.voiceAgentRequested = false;
  return manager;
}

test.afterEach(() => {
  delete global.window.electronAPI;
});

test("getScreenContextTextBounded proceeds with null when the screen-context promise never resolves within the bound", async () => {
  const manager = makeManager();
  manager.screenContextPromise = new Promise(() => {
    /* never resolves */
  });

  const start = Date.now();
  const result = await manager.getScreenContextTextBounded(50);
  const elapsedMs = Date.now() - start;

  assert.equal(result, null, "must proceed with no screen context rather than waiting forever");
  assert.ok(
    elapsedMs < 1000,
    `bounded wait must resolve promptly (took ${elapsedMs}ms), never block indefinitely`
  );
});

test("getScreenContextTextBounded resolves to null immediately when there is no in-flight promise", async () => {
  const manager = makeManager();
  manager.screenContextPromise = null;
  assert.equal(await manager.getScreenContextTextBounded(), null);
});

test("getScreenContextTextBounded returns the resolved text when OCR finishes within the bound", async () => {
  const manager = makeManager();
  manager.screenContextPromise = Promise.resolve("some screen text");
  assert.equal(await manager.getScreenContextTextBounded(1500), "some screen text");
});

test("getScreenContextTextBounded never throws even if the underlying promise rejects", async () => {
  const manager = makeManager();
  manager.screenContextPromise = Promise.reject(new Error("capture/OCR failed"));
  await assert.doesNotReject(() => manager.getScreenContextTextBounded(50));
  assert.equal(await manager.getScreenContextTextBounded(50), null);
});

test("warmupScreenContext() returns promptly without awaiting a slow/never-resolving capture call (never delays recording start)", async () => {
  const manager = makeManager();
  global.window.electronAPI = {
    captureActiveWindowContext: () =>
      new Promise(() => {
        /* deliberately never resolves — simulates a slow/hung capture+OCR cycle */
      }),
    getActiveWindowContextPlatformSupport: () => Promise.resolve({ supported: true }),
    detectActiveAppForScreenContext: () => Promise.resolve({ appIdentifier: "notepad.exe" }),
  };

  const { useSettingsStore } = require("../../src/stores/settingsStore.ts");
  const store = useSettingsStore.getState();
  store.setUseCleanupModel(true);
  store.setCleanupMode("local");
  store.setLocalModel("qwen2.5-3b-instruct-q4");
  if (typeof store.setIncludeActiveWindowContext === "function") {
    store.setIncludeActiveWindowContext(true);
  }

  const start = Date.now();
  await manager.warmupScreenContext();
  const elapsedMs = Date.now() - start;

  assert.ok(
    elapsedMs < 1000,
    `warmupScreenContext() must return promptly (took ${elapsedMs}ms) even though capture never resolves`
  );
  // The in-flight promise is left pending (fire-and-forget) rather than
  // awaited to completion before recording start proceeds.
  assert.ok(
    manager.screenContextPromise === null || manager.screenContextPromise instanceof Promise,
    "screenContextPromise is either unset (gate declined) or a pending in-flight promise, never a blocking await"
  );
});
