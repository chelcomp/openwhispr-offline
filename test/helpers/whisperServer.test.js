const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const whisperServerPath = require.resolve("../../src/helpers/whisperServer");
const originalLoad = Module._load;

function loadWhisperServerManager({ userDataDir, spawn } = {}) {
  delete require.cache[whisperServerPath];

  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "electron") {
      return { app: { getPath: () => userDataDir || os.tmpdir() } };
    }
    if (request === "child_process" && spawn) {
      return { ...require("node:child_process"), spawn };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const WhisperServerManager = require("../../src/helpers/whisperServer");
    return new WhisperServerManager();
  } finally {
    Module._load = originalLoad;
  }
}

// This dev checkout may have real whisper-server binaries already downloaded
// into resources/bin/ (`npm run download:whisper-cpp`), which would otherwise
// make these "no binary anywhere"/"only in userData/bin" tests environment-
// dependent. Stub fs.existsSync so only the paths each test cares about
// resolve as present, regardless of what's actually on disk in resources/bin.
function withStubbedExistsSync(shouldExist, fn) {
  const original = fs.existsSync;
  fs.existsSync = (candidatePath) => shouldExist(candidatePath.toString());
  try {
    return fn();
  } finally {
    fs.existsSync = original;
  }
}

test("_doStart() throws an error with .code === WHISPER_SERVER_BINARY_MISSING when no binary is found in any candidate location", async () => {
  const emptyUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ektoswhispr-test-userdata-"));
  const manager = loadWhisperServerManager({ userDataDir: emptyUserDataDir });

  await withStubbedExistsSync(
    () => false,
    async () => {
      assert.equal(manager.getServerBinaryPath(), null);

      await assert.rejects(
        () => manager._doStart("/nonexistent/model.bin", {}),
        (err) => {
          assert.equal(err.code, "WHISPER_SERVER_BINARY_MISSING");
          return true;
        }
      );
    }
  );

  fs.rmSync(emptyUserDataDir, { recursive: true, force: true });
});

// --- idle timeout (transcriptionIdleTimeoutMs) / drain-before-stop / crash logging ---

test("resetIdleTimer fires stop() once the configured idle timeout elapses, and resets on every use", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const manager = loadWhisperServerManager();
  manager.stop = t.mock.fn(async () => {});

  manager.setIdleTimeoutMs(45000);
  manager.resetIdleTimer();

  t.mock.timers.tick(44999);
  assert.equal(manager.stop.mock.callCount(), 0);
  t.mock.timers.tick(1);
  assert.equal(manager.stop.mock.callCount(), 1);

  // Reset-on-every-use: calling resetIdleTimer again schedules a fresh window.
  manager.resetIdleTimer();
  t.mock.timers.tick(44999);
  assert.equal(manager.stop.mock.callCount(), 1, "must not fire again before the fresh window elapses");
  t.mock.timers.tick(1);
  assert.equal(manager.stop.mock.callCount(), 2);
});

test("setIdleTimeoutMs changes the scheduled delay independently of any other manager's setting", (t) => {
  const WhisperServerManager = require("../../src/helpers/whisperServer");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const manager = loadWhisperServerManager();
  manager.stop = t.mock.fn(async () => {});

  assert.equal(manager.idleTimeoutMs, WhisperServerManager.DEFAULT_IDLE_TIMEOUT_MS);
  manager.setIdleTimeoutMs(10000);
  manager.resetIdleTimer();

  t.mock.timers.tick(9999);
  assert.equal(manager.stop.mock.callCount(), 0);
  t.mock.timers.tick(1);
  assert.equal(manager.stop.mock.callCount(), 1);

  // Simulating a differently-configured llama-server idle timeout elsewhere
  // in the same process must never change this manager's own setting.
  const unrelatedLlmIdleTimeoutMs = 600000;
  assert.notEqual(manager.idleTimeoutMs, unrelatedLlmIdleTimeoutMs);
});

test("stop() drains an in-flight request before proceeding, and the DRAIN_TIMEOUT_MS ceiling still forces the stop if it never settles", async () => {
  const manager = loadWhisperServerManager();
  manager.activeRequestCount = 1;
  manager.process = { killed: false };
  manager.ready = true;

  const drainPromise = manager._drainActiveRequests();
  // Settle the "in-flight request" shortly after — drain should resolve
  // promptly once activeRequestCount drops to 0, not wait for the ceiling.
  setTimeout(() => {
    manager.activeRequestCount = 0;
  }, 30);

  const start = Date.now();
  await drainPromise;
  assert.ok(Date.now() - start < 15000, "should resolve once the request settles, not at the ceiling");
});

test("an unexpected whisper-server exit logs distinctly (error level) and schedules no respawn; a subsequent start() still recovers normally", async () => {
  const { EventEmitter } = require("node:events");
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ektoswhispr-test-userdata-"));
  const binDir = path.join(userDataDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const binaryName =
    process.platform === "win32"
      ? `whisper-server-${process.platform}-${process.arch}.exe`
      : `whisper-server-${process.platform}-${process.arch}`;
  const binaryPath = path.join(binDir, binaryName);
  fs.writeFileSync(binaryPath, "");
  const modelPath = path.join(userDataDir, "model.bin");
  fs.writeFileSync(modelPath, "");

  let spawnCount = 0;
  const fakeSpawn = () => {
    spawnCount++;
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.killed = false;
    proc.pid = 20000 + spawnCount;
    proc.kill = () => {
      proc.killed = true;
      process.nextTick(() => proc.emit("close", 0));
    };
    return proc;
  };

  const manager = loadWhisperServerManager({ userDataDir, spawn: fakeSpawn });
  manager.checkHealth = async () => true;

  await withStubbedExistsSync(
    (candidatePath) => candidatePath === binaryPath || candidatePath === modelPath,
    () => manager.start(modelPath)
  );

  assert.equal(manager.ready, true);
  assert.equal(manager._intentionalStop, false);

  const debugLogger = require("../../src/helpers/debugLogger");
  const originalError = debugLogger.error;
  const errorCalls = [];
  debugLogger.error = (...args) => errorCalls.push(args);

  const proc = manager.process;
  proc.emit("close", 1);

  debugLogger.error = originalError;

  assert.equal(manager.process, null);
  assert.equal(manager.ready, false);
  assert.ok(
    errorCalls.some((call) => /unexpectedly/i.test(call[0])),
    "should log a distinct unexpected-exit message at error level"
  );

  // No automatic respawn: process stays null absent an explicit start() call.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(manager.process, null);

  // The next on-demand start() still recovers normally.
  await withStubbedExistsSync(
    (candidatePath) => candidatePath === binaryPath || candidatePath === modelPath,
    () => manager.start(modelPath)
  );
  assert.equal(manager.ready, true);

  manager.stopHealthCheck();
  manager.clearIdleTimer();
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

// --- language plumbing (docs/specs/dictation-language-detection-fix.md) ---

test("start() still no-ops (no restart) when nothing changed, including language", async () => {
  const { EventEmitter } = require("node:events");
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ektoswhispr-test-userdata-"));
  const binDir = path.join(userDataDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const binaryName =
    process.platform === "win32"
      ? `whisper-server-${process.platform}-${process.arch}.exe`
      : `whisper-server-${process.platform}-${process.arch}`;
  const binaryPath = path.join(binDir, binaryName);
  fs.writeFileSync(binaryPath, "");
  const modelPath = path.join(userDataDir, "model.bin");
  fs.writeFileSync(modelPath, "");

  let spawnCount = 0;
  const fakeSpawn = () => {
    spawnCount++;
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.killed = false;
    proc.pid = 30000 + spawnCount;
    proc.kill = () => {
      proc.killed = true;
      process.nextTick(() => proc.emit("close", 0));
    };
    return proc;
  };

  const manager = loadWhisperServerManager({ userDataDir, spawn: fakeSpawn });
  manager.checkHealth = async () => true;

  await withStubbedExistsSync(
    (candidatePath) => candidatePath === binaryPath || candidatePath === modelPath,
    async () => {
      await manager.start(modelPath, { language: "en" });
      await manager.start(modelPath, { language: "en" });
    }
  );

  assert.equal(spawnCount, 1);
  manager.stopHealthCheck();
  manager.clearIdleTimer();
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

test("start() does not restart merely because language differs from a previous call, when the server is still ready", async () => {
  const { EventEmitter } = require("node:events");
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ektoswhispr-test-userdata-"));
  const binDir = path.join(userDataDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const binaryName =
    process.platform === "win32"
      ? `whisper-server-${process.platform}-${process.arch}.exe`
      : `whisper-server-${process.platform}-${process.arch}`;
  const binaryPath = path.join(binDir, binaryName);
  fs.writeFileSync(binaryPath, "");
  const modelPath = path.join(userDataDir, "model.bin");
  fs.writeFileSync(modelPath, "");

  let spawnCount = 0;
  const fakeSpawn = () => {
    spawnCount++;
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.killed = false;
    proc.pid = 40000 + spawnCount;
    proc.kill = () => {
      proc.killed = true;
      process.nextTick(() => proc.emit("close", 0));
    };
    return proc;
  };

  const manager = loadWhisperServerManager({ userDataDir, spawn: fakeSpawn });
  manager.checkHealth = async () => true;

  await withStubbedExistsSync(
    (candidatePath) => candidatePath === binaryPath || candidatePath === modelPath,
    async () => {
      await manager.start(modelPath, { language: "en" });
      assert.equal(spawnCount, 1);
      await manager.start(modelPath, { language: "pt" });
    }
  );

  assert.equal(spawnCount, 1, "language alone must never trigger a restart (R1)");
  manager.stopHealthCheck();
  manager.clearIdleTimer();
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

test("transcribe()'s multipart body includes carry_initial_prompt=true whenever initialPrompt is supplied, and omits the field entirely when it isn't", async () => {
  const manager = loadWhisperServerManager();
  manager.ready = true;
  manager.canConvert = true;
  manager.process = { killed: false };

  // Minimal valid 44-byte WAV header (16kHz mono PCM), enough for
  // isWhisperReadyWav() to treat it as already-ready and skip FFmpeg.
  const wav = Buffer.alloc(44);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(16000, 24); // sample rate
  wav.writeUInt32LE(32000, 28); // byte rate
  wav.writeUInt16LE(2, 32); // block align
  wav.writeUInt16LE(16, 34); // bits per sample
  wav.write("data", 36);
  wav.writeUInt32LE(0, 40);

  let capturedBody = null;
  manager._doTranscribeRequest = async (_boundary, body) => {
    capturedBody = body;
    return { text: "hello" };
  };

  await manager.transcribe(wav, { language: "en", initialPrompt: "test" });
  assert.ok(capturedBody.toString().includes('name="carry_initial_prompt"'));
  assert.ok(capturedBody.toString().includes("true"));

  capturedBody = null;
  await manager.transcribe(wav, { language: "en" });
  assert.equal(capturedBody.toString().includes('name="carry_initial_prompt"'), false);

  manager.clearIdleTimer();
});

test("transcribe()'s multipart request body never includes a translate field regardless of options", async () => {
  const manager = loadWhisperServerManager();
  manager.ready = true;
  manager.canConvert = true;
  manager.process = { killed: false };

  const wav = Buffer.alloc(44);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(0, 40);

  let capturedBody = null;
  manager._doTranscribeRequest = async (_boundary, body) => {
    capturedBody = body;
    return { text: "hello" };
  };

  await manager.transcribe(wav, { language: "en", initialPrompt: "dictionary words" });
  assert.equal(capturedBody.toString().toLowerCase().includes("translate"), false);

  manager.clearIdleTimer();
});

test("getServerBinaryPath() finds a binary present only at the userData/bin candidate (not resources/bin)", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ektoswhispr-test-userdata-"));
  const binDir = path.join(userDataDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });

  const binaryName =
    process.platform === "win32"
      ? `whisper-server-${process.platform}-${process.arch}.exe`
      : `whisper-server-${process.platform}-${process.arch}`;
  const binaryPath = path.join(binDir, binaryName);
  fs.writeFileSync(binaryPath, "");

  const manager = loadWhisperServerManager({ userDataDir });

  withStubbedExistsSync(
    (candidatePath) => candidatePath === binaryPath,
    () => {
      assert.equal(manager.getServerBinaryPath(), binaryPath);
    }
  );

  fs.rmSync(userDataDir, { recursive: true, force: true });
});
