const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const fs = require("fs");
const Module = require("module");

// debugLogger resolves its log level once, at module-require time, from
// process.argv / EKTOSWHISPR_LOG_LEVEL / LOG_LEVEL. Set this BEFORE requiring
// the module so the singleton is constructed with debug-level logging (and
// therefore `fileLoggingPending = true`) from the start.
process.env.EKTOSWHISPR_LOG_LEVEL = "debug";

// Mock electron before debugLogger.js loads. debugLogger's
// initializeFileLogging() needs app.isReady() to return true (otherwise it
// no-ops and file logging never turns on) and app.getAppPath() (used in the
// startup "System Info" log line), in addition to getPath("userData") — a
// narrower stub than audioStorage.test.js's (which only needs getPath) would
// silently leave fileLoggingEnabled false and make every case below pass
// without exercising any real code path.
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-debug-logger-test-"));
const fakeElectron = {
  app: {
    getPath: (name) => (name === "userData" ? userDataDir : userDataDir),
    isReady: () => true,
    getAppPath: () => userDataDir,
  },
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") return fakeElectron;
  return origLoad.call(this, request, ...rest);
};

const debugLogger = require("../../src/helpers/debugLogger");

const POLL_INTERVAL_MS = 25;
const POLL_TIMEOUT_MS = 5000;

// Bounded-timeout polling for the async fs.WriteStream flush: debugLogger's
// writes (and, on the recreation path, the extra end()/createWriteStream()
// steps in front of them) are not guaranteed to have landed on disk by the
// time a logging call returns. Polling with a hard timeout means a real
// reentrancy regression (write -> ensureLogStream -> recreate -> accidental
// this.debug(...) -> write -> ...) shows up as a clear, loud test timeout
// failure rather than hanging the whole test runner indefinitely.
function waitFor(predicate, { timeoutMs = POLL_TIMEOUT_MS, intervalMs = POLL_INTERVAL_MS } = {}) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      let result;
      try {
        result = predicate();
      } catch {
        result = false;
      }
      if (result) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`waitFor: condition not met within ${timeoutMs}ms`));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function waitForFileContains(filePath, text, opts) {
  return waitFor(
    () => fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8").includes(text),
    opts
  );
}

test("setup: file logging initializes to a real, existing log file", async () => {
  debugLogger.ensureFileLogging();
  debugLogger.info("setup line");

  await waitFor(() => debugLogger.fileLoggingEnabled === true);
  const logPath = debugLogger.getLogPath();
  assert.ok(logPath, "getLogPath() must return a non-null path once file logging is enabled");
  await waitForFileContains(logPath, "setup line");
});

test("case 1: file deleted mid-session is recreated at the same path with new writes landing", async () => {
  const logPath = debugLogger.getLogPath();
  assert.ok(logPath);

  debugLogger.info("line one");
  await waitForFileContains(logPath, "line one");

  // Simulate external deletion (user, AV tool, "clear logs" script) while
  // debugLogger still holds an open stream/fd to the now-unlinked path.
  fs.unlinkSync(logPath);

  // NOTE (empirically validated on this repo's primary/CI platform,
  // Windows): fs.existsSync() reporting false after fs.unlinkSync() on a
  // file with an open, still-referenced handle is exactly the "delete
  // pending" mechanism ensureLogStream()'s design relies on — unlinkSync
  // marks the file pending deletion until the last handle closes, after
  // which existsSync starts reporting false. This test is load-bearing on
  // that premise, not decorative: if existsSync were ever observed to still
  // report true well past this poll window, the existsSync-triggered design
  // would need to be reconsidered.
  await waitFor(() => fs.existsSync(logPath) === false);

  debugLogger.info("line two");

  await waitForFileContains(logPath, "line two");
  assert.equal(
    debugLogger.getLogPath(),
    logPath,
    "recreation must target the exact same path, never a new filename"
  );
  assert.equal(fs.existsSync(logPath), true, "file must exist again at the same path");
});

test("case 2: entire logs/ directory removed is recreated (dir + file) with new writes landing", async () => {
  const logPath = debugLogger.getLogPath();
  assert.ok(logPath);
  const logsDir = path.dirname(logPath);

  debugLogger.info("before dir removal");
  await waitForFileContains(logPath, "before dir removal");

  fs.rmSync(logsDir, { recursive: true, force: true });
  await waitFor(() => fs.existsSync(logsDir) === false);

  debugLogger.info("after dir removal");

  await waitForFileContains(logPath, "after dir removal");
  assert.equal(fs.existsSync(logsDir), true, "logs/ directory must be recreated");
  assert.equal(
    fs.existsSync(logPath),
    true,
    "log file must be recreated inside the recreated directory"
  );
});

test("case 3: steady-state no-op — writing with the file intact does not trigger recreation", async () => {
  const logPath = debugLogger.getLogPath();
  assert.ok(logPath);
  assert.equal(
    fs.existsSync(logPath),
    true,
    "file must already exist for this to be a steady-state check"
  );

  const before = fs.readFileSync(logPath, "utf8");
  const recreationMarkersBefore = (
    before.match(/Log file recreated after external deletion/g) || []
  ).length;

  debugLogger.info("steady state line A");
  await waitForFileContains(logPath, "steady state line A");
  debugLogger.info("steady state line B");
  await waitForFileContains(logPath, "steady state line B");

  const after = fs.readFileSync(logPath, "utf8");
  const recreationMarkersAfter = (after.match(/Log file recreated after external deletion/g) || [])
    .length;

  assert.equal(
    recreationMarkersAfter,
    recreationMarkersBefore,
    "no new recreation-marker line should appear when nothing was deleted between writes"
  );
  assert.ok(after.includes("steady state line A"));
  assert.ok(after.includes("steady state line B"));
});

test("case 4: no reentrancy/infinite loop — recreation completes and returns normally", async () => {
  // Guards specifically against the
  // write -> ensureLogStream -> recreate -> (accidental) this.debug(...) -> write -> ...
  // recursion described in the bug report. If ensureLogStream() ever called
  // back into debug()/info()/write()/console.* directly or indirectly, this
  // test would hang (blowing the waitFor timeouts below) instead of
  // completing normally.
  const logPath = debugLogger.getLogPath();
  fs.unlinkSync(logPath);
  await waitFor(() => fs.existsSync(logPath) === false);

  const start = Date.now();
  debugLogger.info("reentrancy check line");
  await waitForFileContains(logPath, "reentrancy check line");
  const elapsedMs = Date.now() - start;

  assert.ok(
    elapsedMs < POLL_TIMEOUT_MS,
    "recreation + write must complete well within the bounded poll timeout, not hang"
  );
  assert.equal(
    debugLogger._ensuringStream,
    false,
    "guard flag must be released after recreation completes"
  );
});
