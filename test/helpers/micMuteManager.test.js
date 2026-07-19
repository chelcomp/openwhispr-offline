const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const childProcess = require("node:child_process");

const micMuteManagerPath = require.resolve("../../src/helpers/micMuteManager");

const originalLoad = Module._load;
const originalPlatform = process.platform;

function setPlatform(platform) {
  Object.defineProperty(process, "platform", { value: platform });
}

function loadMicMuteManager({ spawn } = {}) {
  delete require.cache[micMuteManagerPath];

  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "child_process" && spawn) {
      return { ...childProcess, spawn };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require("../../src/helpers/micMuteManager");
  } finally {
    Module._load = originalLoad;
  }
}

// Simulates the persistent PowerShell helper (GET_MUTE/SET_MUTE line protocol)
// for spawn calls whose command looks like powershell, and a plain
// close-code-based process (like nircmd.exe) for everything else.
function createFakeSpawn({
  getMuteValue = "False",
  helperSpawnErrors = false,
  nircmdCloseCode = 0,
  respondToHelper = true,
} = {}) {
  const calls = [];

  function fakeSpawn(command, args, opts) {
    calls.push({ command, args, opts });
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.killed = false;
    proc.kill = () => {
      proc.killed = true;
    };

    const isHelper = command === "powershell.exe";

    if (isHelper) {
      const writes = [];
      proc.stdin = {
        write(data, cb) {
          writes.push(data);
          cb?.();
          if (respondToHelper) {
            const line = String(data).trim();
            process.nextTick(() => {
              if (line === "GET_MUTE") {
                proc.stdout.emit("data", Buffer.from(`RESULT GET_MUTE ${getMuteValue}\n`));
              } else if (line.startsWith("SET_MUTE")) {
                proc.stdout.emit("data", Buffer.from(`RESULT ${line}\n`));
              }
            });
          }
        },
        end() {},
      };
      proc.writes = writes;

      if (helperSpawnErrors) {
        process.nextTick(() => proc.emit("error", new Error("spawn ENOENT")));
      } else {
        process.nextTick(() => proc.emit("spawn"));
      }
    } else {
      // nircmd-style: no stdin protocol, resolves via "close".
      proc.stdin = { write() {}, end() {} };
      process.nextTick(() => proc.emit("close", nircmdCloseCode));
    }

    return proc;
  }

  return { fakeSpawn, calls };
}

test.afterEach(() => {
  setPlatform(originalPlatform);
});

// --- platform gate -----------------------------------------------------

test("getMuted/setMuted no-op on non-Windows platforms", async () => {
  setPlatform("linux");
  const { fakeSpawn, calls } = createFakeSpawn();
  const manager = loadMicMuteManager({ spawn: fakeSpawn });

  const getResult = await manager.getMuted();
  const setResult = await manager.setMuted(true);

  assert.deepEqual(getResult, { success: false, error: "Unsupported platform" });
  assert.deepEqual(setResult, { success: false, error: "Unsupported platform" });
  assert.equal(calls.length, 0);
});

// --- performance: single persistent process reused across calls --------

test("helper process is spawned once and reused across getMuted/setMuted calls", async () => {
  setPlatform("win32");
  const { fakeSpawn, calls } = createFakeSpawn({ getMuteValue: "True" });
  const manager = loadMicMuteManager({ spawn: fakeSpawn });
  manager.getNircmdPath = () => null;

  const get1 = await manager.getMuted();
  const set1 = await manager.setMuted(false);
  const get2 = await manager.getMuted();

  assert.equal(calls.length, 1, "expected exactly one powershell process spawn");
  assert.deepEqual(get1, { success: true, muted: true });
  assert.deepEqual(set1, { success: true });
  assert.deepEqual(get2, { success: true, muted: true });
});

test("warmUp() pre-spawns the helper so the first real call is instant", async () => {
  setPlatform("win32");
  const { fakeSpawn, calls } = createFakeSpawn({ getMuteValue: "False" });
  const manager = loadMicMuteManager({ spawn: fakeSpawn });
  manager.getNircmdPath = () => null;

  await manager.warmUp();
  assert.equal(calls.length, 1);

  const result = await manager.getMuted();
  assert.equal(calls.length, 1, "getMuted after warmUp should not spawn again");
  assert.deepEqual(result, { success: true, muted: false });
});

// --- GET_MUTE / SET_MUTE parsing ----------------------------------------

test("getMuted parses True/False case-insensitively", async () => {
  setPlatform("win32");
  for (const value of ["True", "true", "False", "false"]) {
    const { fakeSpawn } = createFakeSpawn({ getMuteValue: value });
    const manager = loadMicMuteManager({ spawn: fakeSpawn });
    manager.getNircmdPath = () => null;

    const result = await manager.getMuted();
    assert.deepEqual(result, { success: true, muted: value.toLowerCase() === "true" });
  }
});

test("getMuted returns failure when helper responds with an unexpected line", async () => {
  setPlatform("win32");
  const { fakeSpawn } = createFakeSpawn({ respondToHelper: false });
  const manager = loadMicMuteManager({ spawn: fakeSpawn });
  manager.getNircmdPath = () => null;
  manager._sendHelperCommand = async () => "ERROR something_weird";

  const result = await manager.getMuted();
  assert.equal(result.success, false);
  assert.equal(result.error, "ERROR something_weird");
});

test("setMuted via helper succeeds when result echoes the request", async () => {
  setPlatform("win32");
  const { fakeSpawn } = createFakeSpawn();
  const manager = loadMicMuteManager({ spawn: fakeSpawn });
  manager.getNircmdPath = () => null;

  const result = await manager.setMuted(true);
  assert.deepEqual(result, { success: true });
});

test("setMuted via helper fails when the echoed result does not match the request", async () => {
  setPlatform("win32");
  const manager = loadMicMuteManager({ spawn: createFakeSpawn().fakeSpawn });
  manager.getNircmdPath = () => null;
  manager._sendHelperCommand = async () => "SET_MUTE false";

  const result = await manager.setMuted(true);
  assert.equal(result.success, false);
  assert.equal(result.error, "SET_MUTE false");
});

// --- stdout buffering (partial lines / multiple lines per chunk) -------

test("helper responses split across multiple stdout chunks still resolve", async () => {
  setPlatform("win32");
  const { fakeSpawn } = createFakeSpawn({ respondToHelper: false });
  const manager = loadMicMuteManager({ spawn: fakeSpawn });
  manager.getNircmdPath = () => null;

  const pending = manager.getMuted();
  const proc = await manager._getHelperProcess();
  proc.stdout.emit("data", Buffer.from("RESULT GET_MUTE Tr"));
  proc.stdout.emit("data", Buffer.from("ue\n"));

  const result = await pending;
  assert.deepEqual(result, { success: true, muted: true });
});

test("concurrent requests resolve in FIFO order matching send order", async () => {
  setPlatform("win32");
  const { fakeSpawn } = createFakeSpawn({ respondToHelper: false });
  const manager = loadMicMuteManager({ spawn: fakeSpawn });
  manager.getNircmdPath = () => null;

  const first = manager._sendHelperCommand("SET_MUTE true");
  const second = manager._sendHelperCommand("GET_MUTE");
  const proc = await manager._getHelperProcess();

  // Both RESULT lines arrive in one chunk, in send order.
  proc.stdout.emit("data", Buffer.from("RESULT SET_MUTE true\nRESULT GET_MUTE False\n"));

  assert.equal(await first, "SET_MUTE true");
  assert.equal(await second, "GET_MUTE False");
});

// --- failure handling -----------------------------------------------------

test("pending requests reject when the helper process exits unexpectedly", async () => {
  setPlatform("win32");
  const { fakeSpawn } = createFakeSpawn({ respondToHelper: false });
  const manager = loadMicMuteManager({ spawn: fakeSpawn });
  manager.getNircmdPath = () => null;

  const pending = manager.getMuted();
  const proc = await manager._getHelperProcess();
  proc.emit("exit", 1);

  const result = await pending;
  assert.equal(result.success, false);
  assert.match(result.error, /MicMute helper exited \(code 1\)/);
});

test("a failed spawn resolves to a graceful error and a later call retries spawning", async () => {
  setPlatform("win32");
  const { fakeSpawn, calls } = createFakeSpawn({ helperSpawnErrors: true });
  const manager = loadMicMuteManager({ spawn: fakeSpawn });
  manager.getNircmdPath = () => null;

  const firstResult = await manager.getMuted();
  assert.equal(firstResult.success, false);
  assert.match(firstResult.error, /spawn ENOENT/);
  assert.equal(calls.length, 1);
  assert.equal(manager.helperProcess, null);
  assert.equal(manager.helperStartupPromise, null);

  // The dead process/promise must not be reused — a second call should spawn again.
  const secondResult = await manager.getMuted();
  assert.equal(secondResult.success, false);
  assert.equal(calls.length, 2, "expected a brand new spawn attempt after the prior failure");
});

test("stop() kills the helper process so the next call spawns a fresh one", async () => {
  setPlatform("win32");
  const { fakeSpawn, calls } = createFakeSpawn({ getMuteValue: "False" });
  const manager = loadMicMuteManager({ spawn: fakeSpawn });
  manager.getNircmdPath = () => null;

  await manager.getMuted();
  assert.equal(calls.length, 1);

  manager.stop();
  assert.equal(manager.helperProcess, null);

  await manager.getMuted();
  assert.equal(calls.length, 2, "stop() should force a fresh spawn on the next call");
});

// --- nircmd fallback --------------------------------------------------

test("setMuted prefers nircmd when available and does not touch the helper", async () => {
  setPlatform("win32");
  const { fakeSpawn, calls } = createFakeSpawn({ nircmdCloseCode: 0 });
  const manager = loadMicMuteManager({ spawn: fakeSpawn });
  manager.getNircmdPath = () => "C:\\resources\\bin\\nircmd.exe";

  const result = await manager.setMuted(true);

  assert.deepEqual(result, { success: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "C:\\resources\\bin\\nircmd.exe");
  assert.deepEqual(calls[0].args, ["mutesysvolume", "1", "microphone"]);
});

test("setMuted falls back to the helper when nircmd exits with a failure code", async () => {
  setPlatform("win32");
  const { fakeSpawn, calls } = createFakeSpawn({ nircmdCloseCode: 1, getMuteValue: "False" });
  const manager = loadMicMuteManager({ spawn: fakeSpawn });
  manager.getNircmdPath = () => "C:\\resources\\bin\\nircmd.exe";

  const result = await manager.setMuted(false);

  assert.deepEqual(result, { success: true });
  assert.equal(calls.length, 2, "expected nircmd attempt + helper fallback spawn");
  assert.equal(calls[0].command, "C:\\resources\\bin\\nircmd.exe");
  assert.equal(calls[1].command, "powershell.exe");
});

test("setMuted falls back to the helper when nircmd itself errors", async () => {
  setPlatform("win32");
  const calls = [];
  const fakeSpawn = (command, args, opts) => {
    calls.push({ command, args, opts });
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    if (command.includes("nircmd")) {
      proc.stdin = { write() {}, end() {} };
      process.nextTick(() => proc.emit("error", new Error("ENOENT")));
    } else {
      proc.stdin = {
        write(data, cb) {
          cb?.();
          const line = String(data).trim();
          process.nextTick(() => {
            if (line.startsWith("SET_MUTE")) {
              proc.stdout.emit("data", Buffer.from(`RESULT ${line}\n`));
            }
          });
        },
        end() {},
      };
      process.nextTick(() => proc.emit("spawn"));
    }
    return proc;
  };
  const manager = loadMicMuteManager({ spawn: fakeSpawn });
  manager.getNircmdPath = () => "C:\\resources\\bin\\nircmd.exe";

  const result = await manager.setMuted(true);

  assert.deepEqual(result, { success: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].command, "powershell.exe");
});
