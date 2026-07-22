const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

/**
 * Regression-locks Design §6/§13 of docs/specs/audio-transcription-batching.md:
 * every remaining Parakeet model is offline-runtime (the three
 * `runtime: "online"` models were removed from the product entirely), so
 * `start-dictation-preview` must *always* create a batching session for
 * `provider === "nvidia"` — there is no longer any model class that's
 * excluded from the mechanism.
 *
 * Follows the same Module._load-mocking / Object.create(IPCHandlers.prototype)
 * convention as test/helpers/pasteTextMonitorInvariant.test.js — setupHandlers()
 * does heavy unrelated app-startup work in the real constructor, so this
 * bypasses the constructor and calls setupHandlers() directly on a
 * minimally-stubbed instance (it only registers handler closures at call time).
 */

const originalLoad = Module._load;
const registeredHandlers = new Map();

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: {
        getPath: () => process.cwd(),
        getAppPath: () => process.cwd(),
        isReady: () => false,
        getVersion: () => "0.0.0",
        on: () => {},
      },
      ipcMain: {
        handle: (name, fn) => {
          registeredHandlers.set(name, fn);
        },
        on: (name, fn) => {
          registeredHandlers.set(name, fn);
        },
      },
      shell: {},
      BrowserWindow: function BrowserWindow() {},
      systemPreferences: { subscribeWorkspaceNotification: () => {} },
      net: {},
    };
  }
  if (request === "./activeAppCapture") {
    return { detectAsync: async () => null, getLastAppName: () => null, setMacOSAppName: () => {} };
  }
  if (request === "./dictationBatchingSession") {
    const real = originalLoad.call(this, request, parent, isMain);
    return {
      ...real,
      createDictationBatchingSession: (options) => {
        capturedVadConfigs.push(options?.vadConfig);
        capturedOptions.push(options);
        return real.createDictationBatchingSession(options);
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

process.env.NODE_ENV = "test";

// Populated by the "./dictationBatchingSession" mock above each time
// start-dictation-preview builds a batching session — lets tests assert on
// exactly what vadConfig was passed, without needing to modify the real
// dictationBatchingSession module.
const capturedVadConfigs = [];
const capturedOptions = [];

const IPCHandlers = require("../../src/helpers/ipcHandlers.js");

test.after(() => {
  Module._load = originalLoad;
});

function createHandlerUnderTest({
  transcribeLocalParakeetCalls,
  parakeetText = "hello",
  resolveWhisperVadOptions,
  resolvePreviewVadOptions,
}) {
  const instance = Object.create(IPCHandlers.prototype);
  instance.parakeetManager = {
    transcribeLocalParakeet: async (audio, opts) => {
      transcribeLocalParakeetCalls.push(opts);
      return { success: true, text: parakeetText };
    },
  };
  instance.whisperManager = {
    transcribeLocalWhisper: async () => ({ success: true, text: "hello" }),
    isHallucinatedText: () => false,
  };
  instance.windowManager = {
    showTranscriptionPreview: () => {},
    hideTranscriptionPreview: () => {},
    holdTranscriptionPreview: () => {},
    completeTranscriptionPreview: () => {},
    updateCleanupPreview: () => {},
    resizeTranscriptionPreview: () => ({ success: true }),
  };
  instance._resolveWhisperVadOptions =
    resolveWhisperVadOptions || (() => ({ vadConfig: {} }));
  if (resolvePreviewVadOptions) {
    instance._resolvePreviewVadOptions = resolvePreviewVadOptions;
  }

  instance.setupHandlers();
  const start = registeredHandlers.get("start-dictation-preview");
  const audio = registeredHandlers.get("dictation-preview-audio");
  const stop = registeredHandlers.get("stop-dictation-preview");
  assert.ok(start, "start-dictation-preview handler must be registered");
  assert.ok(audio, "dictation-preview-audio handler must be registered");
  assert.ok(stop, "stop-dictation-preview handler must be registered");
  return { start, audio, stop };
}

test("start-dictation-preview always creates a batching session for a Parakeet (nvidia) provider", async () => {
  const transcribeLocalParakeetCalls = [];
  const { start, audio, stop } = createHandlerUnderTest({ transcribeLocalParakeetCalls });

  await start({}, {
    provider: "nvidia",
    model: "parakeet-tdt-0.6b-v3",
    language: "en",
    initialPrompt: undefined,
    showOverlay: false,
  });

  // Feed one voiced + silence-closed utterance in so the batching session has
  // something to commit — proves a real VAD session was created (not the old
  // no-op branch that used to apply to runtime:"online" models).
  function pcm(ms, amplitude) {
    const SAMPLE_RATE = 16000;
    const samples = Math.round((SAMPLE_RATE * ms) / 1000);
    const buf = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) {
      const s = (i % 2 === 0 ? amplitude : -amplitude) * 0x7fff;
      buf.writeInt16LE(Math.round(s), i * 2);
    }
    return buf;
  }
  audio({}, pcm(300, 0));
  audio({}, pcm(500, 0.3));
  audio({}, pcm(500, 0));

  const result = await stop({}, {});

  assert.ok(
    transcribeLocalParakeetCalls.length > 0,
    "the batching session must have called transcribeLocalParakeet at least once"
  );
  assert.equal(typeof result.streamingText, "string");
});

test("start-dictation-preview builds its energy-VAD vadConfig from Preview VAD settings, never from Silero", async () => {
  capturedVadConfigs.length = 0;
  capturedOptions.length = 0;
  const transcribeLocalParakeetCalls = [];

  // Deliberately distinctive Silero sentinel values that must NOT reach the
  // energy detector for any of the now-10 preview-VAD fields (Design's "no
  // cross-contamination" property), including `threshold`, which has no
  // energy-detector equivalent at all.
  const sileroSentinel = {
    vadConfig: {
      threshold: 0.5,
      minSpeechDurationMs: 999,
      minSilenceDurationMs: 999,
      maxSpeechDurationS: 999,
      speechPadMs: 999,
      samplesOverlap: 0.999,
    },
  };
  // Distinct Preview VAD sentinel values that SHOULD reach the detector —
  // the full 10-field set (5 `vadConfig`-shaped + 6 top-level constructor
  // options, minus the overlap of `minSpeechDurationMs`/`minSilenceDurationMs`
  // counted once).
  const previewVadSentinel = {
    minSpeechDurationMs: 81,
    minSilenceDurationMs: 501,
    speechPadMs: 101,
    maxSpeechDurationS: 21,
    samplesOverlap: 0.31,
    energyThreshold: 0.007,
    minSegmentRms: 0.004,
    noiseFloorFactor: 4,
    noiseFloorAlpha: 0.06,
    maxMerges: 3,
    maxMergedMs: 21000,
  };

  const { start, stop } = createHandlerUnderTest({
    transcribeLocalParakeetCalls,
    resolveWhisperVadOptions: () => sileroSentinel,
    resolvePreviewVadOptions: () => previewVadSentinel,
  });

  await start({}, {
    provider: "nvidia",
    model: "parakeet-tdt-0.6b-v3",
    language: "en",
    initialPrompt: undefined,
    showOverlay: false,
  });
  await stop({}, {});

  assert.equal(capturedVadConfigs.length, 1, "exactly one batching session must have been created");
  const usedVadConfig = capturedVadConfigs[0];
  const usedOptions = capturedOptions[0];

  assert.deepEqual(
    usedVadConfig,
    {
      minSpeechDurationMs: previewVadSentinel.minSpeechDurationMs,
      minSilenceDurationMs: previewVadSentinel.minSilenceDurationMs,
      speechPadMs: previewVadSentinel.speechPadMs,
      maxSpeechDurationS: previewVadSentinel.maxSpeechDurationS,
      samplesOverlap: previewVadSentinel.samplesOverlap,
    },
    "start-dictation-preview must build its vadConfig entirely from the Preview VAD settings' vad-shaped fields"
  );
  for (const key of Object.keys(sileroSentinel.vadConfig)) {
    assert.notEqual(
      usedVadConfig[key],
      sileroSentinel.vadConfig[key],
      `Silero sentinel value for "${key}" must not have reached the energy detector`
    );
  }
  assert.notEqual(
    usedOptions.threshold,
    sileroSentinel.vadConfig.threshold,
    "Silero's threshold must never reach the energy detector's constructor options at all"
  );

  // The 6 non-vad-shaped fields must be threaded as TOP-LEVEL constructor
  // options (Requirement 7), not nested under vadConfig.
  const topLevelFields = [
    "energyThreshold",
    "minSegmentRms",
    "noiseFloorFactor",
    "noiseFloorAlpha",
    "maxMerges",
    "maxMergedMs",
  ];
  for (const key of topLevelFields) {
    assert.equal(
      usedOptions[key],
      previewVadSentinel[key],
      `"${key}" must be threaded as a top-level createDictationBatchingSession option`
    );
    assert.equal(
      usedVadConfig[key],
      undefined,
      `"${key}" must NOT be nested inside vadConfig`
    );
  }
});

test("stop-dictation-preview falls back to full-audio (empty streamingText) when the session's aggregate quality is poor", async () => {
  const transcribeLocalParakeetCalls = [];
  // A hallucinated-boilerplate result on every chunk keeps every commit
  // "low quality" (via isParakeetSegmentLowQuality's hallucination check),
  // pushing the session's aggregate lowQualityRatio above the
  // MAX_STREAM_LOW_QUALITY_RATIO gate.
  const { start, audio, stop } = createHandlerUnderTest({
    transcribeLocalParakeetCalls,
    parakeetText: "thanks for watching",
  });

  await start({}, {
    provider: "nvidia",
    model: "parakeet-tdt-0.6b-v3",
    language: "en",
    initialPrompt: undefined,
    showOverlay: false,
  });

  function pcm(ms, amplitude) {
    const SAMPLE_RATE = 16000;
    const samples = Math.round((SAMPLE_RATE * ms) / 1000);
    const buf = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) {
      const s = (i % 2 === 0 ? amplitude : -amplitude) * 0x7fff;
      buf.writeInt16LE(Math.round(s), i * 2);
    }
    return buf;
  }
  audio({}, pcm(300, 0));
  audio({}, pcm(500, 0.3));
  audio({}, pcm(400, 0));
  audio({}, pcm(500, 0.3));
  audio({}, pcm(400, 0));

  const result = await stop({}, {});

  assert.equal(
    result.streamingText,
    "",
    "a globally low-confidence session must fall back to full-audio re-transcription, not paste the poor progressive result"
  );
});
