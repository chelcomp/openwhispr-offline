const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const os = require("node:os");

const modulePath = require.resolve("../../src/helpers/activeWindowOcr");
const originalLoad = Module._load;

// Escapes all regex metacharacters (not just `.`) before interpolating an
// arbitrary string into a `new RegExp(...)` constructor.
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Installs the mock Module._load and returns the freshly-required module
// PLUS a `restore()` callback. `runTesseractOcr`/`runNativeOcr` call
// `require("tesseract.js")`/spawn asynchronously — after `require()` itself
// returns — so the mock must stay installed for the whole async operation,
// not just for the synchronous `require()` call.
function loadWithMocks({ execFileImpl, tesseractImpl } = {}) {
  delete require.cache[modulePath];
  delete require.cache[require.resolve("../../src/helpers/activeWindowCapture")];

  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "child_process") {
      return {
        ...originalLoad.call(this, request, parent, isMain),
        execFile: execFileImpl || (() => {}),
      };
    }
    if (request === "electron") {
      return { app: { getPath: () => os.tmpdir() } };
    }
    if (request === "tesseract.js") {
      if (!tesseractImpl) throw new Error("tesseract.js should not be required in this test");
      return tesseractImpl;
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  const activeWindowOcr = require("../../src/helpers/activeWindowOcr");
  return { activeWindowOcr, restore: () => (Module._load = originalLoad) };
}

async function runOcrWithMocks(mocks, pngBuffer, options) {
  const { activeWindowOcr, restore } = loadWithMocks(mocks);
  try {
    return await activeWindowOcr.runOcr(pngBuffer, options);
  } finally {
    restore();
  }
}

function fakeTesseractManager({ downloaded }) {
  return {
    isDownloaded: () => downloaded,
    getAssetPaths: () => ["/fake/tesseract-core-simd.wasm.js", "/fake/eng.traineddata"],
    assetDir: "/fake",
  };
}

const FAKE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

test("auto: falls back to Tesseract when native OCR spawn errors/rejects", async () => {
  const text = await runOcrWithMocks(
    {
      execFileImpl: (bin, args, opts, cb) => cb(new Error("native OCR unavailable")),
      tesseractImpl: { recognize: async () => ({ data: { text: "tesseract result" } }) },
    },
    FAKE_PNG,
    {
      engine: "auto",
      tesseractOcrManager: fakeTesseractManager({ downloaded: true }),
    }
  );

  assert.equal(text, "tesseract result");
});

test("auto: resolves to null/empty (not throwing) when both strategies fail", async () => {
  const text = await runOcrWithMocks(
    {
      execFileImpl: (bin, args, opts, cb) => cb(new Error("native OCR unavailable")),
    },
    FAKE_PNG,
    {
      engine: "auto",
      tesseractOcrManager: fakeTesseractManager({ downloaded: false }),
    }
  );

  assert.equal(text, null);
});

test('engine "native": never invokes Tesseract, even on native failure (no silent fallback)', async () => {
  let tesseractCalls = 0;
  const text = await runOcrWithMocks(
    {
      execFileImpl: (bin, args, opts, cb) => cb(new Error("native OCR unavailable")),
      tesseractImpl: {
        recognize: async () => {
          tesseractCalls++;
          return { data: { text: "should never be reached" } };
        },
      },
    },
    FAKE_PNG,
    {
      engine: "native",
      tesseractOcrManager: fakeTesseractManager({ downloaded: true }),
    }
  );

  assert.equal(text, null);
  assert.equal(tesseractCalls, 0, "Tesseract must never be invoked in forced-native mode");
});

test('engine "tesseract": never invokes the native PowerShell bridge, even with native available', async () => {
  let nativeCalls = 0;
  const text = await runOcrWithMocks(
    {
      execFileImpl: (bin, args, opts, cb) => {
        nativeCalls++;
        cb(null, JSON.stringify({ text: "native result" }));
      },
      tesseractImpl: { recognize: async () => ({ data: { text: "tesseract only result" } }) },
    },
    FAKE_PNG,
    {
      engine: "tesseract",
      tesseractOcrManager: fakeTesseractManager({ downloaded: true }),
    }
  );

  assert.equal(text, "tesseract only result");
  assert.equal(
    nativeCalls,
    0,
    "native PowerShell bridge must never be spawned in forced-tesseract mode"
  );
});

test("an unrecognized/corrupt engine value falls back to auto behavior", async () => {
  const text = await runOcrWithMocks(
    {
      execFileImpl: (bin, args, opts, cb) => cb(null, JSON.stringify({ text: "native result" })),
    },
    FAKE_PNG,
    {
      engine: "bogus",
      tesseractOcrManager: fakeTesseractManager({ downloaded: false }),
    }
  );

  assert.equal(text, "native result", "falls back to auto's native-first behavior");
});

test("tesseract strategy is treated as unavailable (skipped, no throw) when assets aren't downloaded", async () => {
  const text = await runOcrWithMocks(
    {
      execFileImpl: (bin, args, opts, cb) => cb(new Error("native unavailable")),
    },
    FAKE_PNG,
    {
      engine: "tesseract",
      tesseractOcrManager: fakeTesseractManager({ downloaded: false }),
    }
  );

  assert.equal(text, null);
});

test("runOcr resolves null for an empty/missing PNG buffer without throwing", async () => {
  const { activeWindowOcr, restore } = loadWithMocks({});
  try {
    assert.equal(await activeWindowOcr.runOcr(null), null);
    assert.equal(await activeWindowOcr.runOcr(Buffer.alloc(0)), null);
  } finally {
    restore();
  }
});

test("native OCR PowerShell script uses the WinRT-await workaround, not a bare .GetAwaiter().GetResult() (regression guard — the previous form silently returned null/empty on every real invocation despite all mocked tests passing)", async () => {
  let capturedScript = null;
  await runOcrWithMocks(
    {
      execFileImpl: (bin, args, opts, cb) => {
        // execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], ...)
        capturedScript = args[args.length - 1];
        cb(null, JSON.stringify({ text: "captured" }));
      },
    },
    FAKE_PNG,
    { engine: "native" }
  );

  assert.ok(capturedScript, "the generated PowerShell script must have been captured");

  // The WinRT-await workaround: reflectively invoke
  // System.WindowsRuntimeSystemExtensions.AsTask<T> to project the WinRT
  // IAsyncOperation<T> to a real .NET Task, then block on that.
  assert.match(capturedScript, /AsTask/, "must reflectively resolve AsTask");
  assert.match(
    capturedScript,
    /MakeGenericMethod/,
    "must construct the generic AsTask<T> via MakeGenericMethod"
  );

  // Each WinRT type used must be force-loaded via the
  // [Type,Contract,ContentType=WindowsRuntime] accelerator syntax before
  // PowerShell's type resolver can see it.
  for (const winrtType of [
    "Windows.Media.Ocr.OcrEngine",
    "Windows.Storage.StorageFile",
    "Windows.Graphics.Imaging.BitmapDecoder",
  ]) {
    assert.match(
      capturedScript,
      new RegExp(`\\[${escapeRegExp(winrtType)},[^\\]]*ContentType=WindowsRuntime\\]`),
      `must force-load the WinRT type accelerator for ${winrtType}`
    );
  }

  // The bug this regresses against: calling .GetAwaiter().GetResult() directly
  // on a WinRT IAsyncOperation<T> — PowerShell cannot invoke this (WinRT
  // operations have no .GetAwaiter() PowerShell can see). Any bare occurrence
  // outside of the Await helper function itself is the broken form.
  assert.doesNotMatch(
    capturedScript,
    /\)\.GetAwaiter\(\)\.GetResult\(\)/,
    "must not call .GetAwaiter().GetResult() directly on a WinRT operation " +
      "(must go through the Await helper's AsTask projection instead)"
  );
});
