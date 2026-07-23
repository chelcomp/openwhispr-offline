// Regression test for docs/specs/renderer-debug-log-level.md: a failed/racy
// `getLogLevel()` resolution in src/utils/logger.ts must not permanently
// latch the renderer's log level at "info" — the *next* distinct call must
// retry instead of silently dropping debug logs forever.
//
// Run via: node --test --import ./test/setup/tsxRegister.js test/components/*.test.js
// (see test/setup/tsxRegister.js — the `.ts` require hook lets this file
// `require()` src/utils/logger.ts directly, same pattern as
// test/components/prompts.screenContext.test.js for a plain TS helper.)

const test = require("node:test");
const assert = require("node:assert/strict");

const loggerModulePath = require.resolve("../../src/utils/logger.ts");

// logger.ts holds module-level `cachedLevel`/`levelPromise` state, so each
// test case needs a fresh module instance rather than leaking state between
// cases — clear the require cache before every require.
function freshLogger() {
  delete require.cache[loggerModulePath];
  return require("../../src/utils/logger.ts").default;
}

test.afterEach(() => {
  delete global.window.electronAPI;
});

test("Case A: retries after an async fallback (getLogLevel rejects), then forwards debug logs once resolved", async () => {
  const logCalls = [];
  let getLogLevelCalls = 0;

  global.window.electronAPI = {
    getLogLevel: async () => {
      getLogLevelCalls += 1;
      if (getLogLevelCalls === 1) {
        throw new Error("simulated IPC race failure");
      }
      return "debug";
    },
    log: async (entry) => {
      logCalls.push(entry);
    },
  };

  const logger = freshLogger();

  // First call: getLogLevel() rejects -> falls back to "info" for *this*
  // call only. "debug" < "info" so it must not be forwarded.
  await logger.debug("first");
  assert.equal(getLogLevelCalls, 1, "getLogLevel should have been invoked once");
  assert.equal(logCalls.length, 0, "fallback level is info; debug log must not be forwarded");

  // Second, distinct call: this is the regression check. Against today's
  // code, cachedLevel would already be permanently latched to "info" from
  // the first call, so getLogLevel would never be re-invoked and this debug
  // log would be swallowed forever.
  await logger.debug("second");
  assert.equal(getLogLevelCalls, 2, "getLogLevel must be re-invoked on the next distinct call");
  assert.equal(logCalls.length, 1, "once the real level resolves to debug, the log must forward");
  assert.equal(logCalls[0].level, "debug");
  assert.equal(logCalls[0].message, "second");
});

test("Case A2: retries after a synchronous/no-await fallback (getLogLevel unavailable), then forwards debug logs once resolved", async () => {
  const logCalls = [];

  // No `getLogLevel` property at all, so `window.electronAPI?.getLogLevel`
  // is falsy and the inner IIFE's body never reaches an `await` before its
  // fallback return — this is the path that only an outer-scope reset (not
  // a reset written inside the IIFE) can recover from. See the spec's
  // Design section for why an inside-the-IIFE reset is silently clobbered
  // by the outer `levelPromise = (async () => {...})()` assignment for
  // this exact path.
  global.window.electronAPI = {
    log: async (entry) => {
      logCalls.push(entry);
    },
  };

  const logger = freshLogger();

  await logger.debug("first");
  assert.equal(logCalls.length, 0, "fallback level is info; debug log must not be forwarded");

  let getLogLevelCalls = 0;
  global.window.electronAPI.getLogLevel = async () => {
    getLogLevelCalls += 1;
    return "debug";
  };

  await logger.debug("second");
  assert.equal(
    getLogLevelCalls,
    1,
    "getLogLevel must be invoked on the next distinct call after a synchronous fallback"
  );
  assert.equal(logCalls.length, 1, "once the real level resolves to debug, the log must forward");
  assert.equal(logCalls[0].level, "debug");
  assert.equal(logCalls[0].message, "second");
});

test("Case A2b: retries after a synchronous fallback (getLogLevel throws synchronously), then forwards debug logs once resolved", async () => {
  const logCalls = [];
  let getLogLevelCalls = 0;

  // A plain (non-async) function that throws synchronously — never reaches
  // an `await` before the fallback path is taken, same as the "unavailable"
  // variant above but exercising the "throws synchronously" branch
  // explicitly called out in the spec's Validation Plan.
  global.window.electronAPI = {
    getLogLevel: () => {
      getLogLevelCalls += 1;
      throw new Error("simulated synchronous failure");
    },
    log: async (entry) => {
      logCalls.push(entry);
    },
  };

  const logger = freshLogger();

  await logger.debug("first");
  assert.equal(getLogLevelCalls, 1);
  assert.equal(logCalls.length, 0, "fallback level is info; debug log must not be forwarded");

  global.window.electronAPI.getLogLevel = async () => {
    getLogLevelCalls += 1;
    return "debug";
  };

  await logger.debug("second");
  assert.equal(getLogLevelCalls, 2, "getLogLevel must be re-invoked on the next distinct call");
  assert.equal(logCalls.length, 1, "once the real level resolves to debug, the log must forward");
  assert.equal(logCalls[0].level, "debug");
  assert.equal(logCalls[0].message, "second");
});

test("Case B: a successful resolution still memoizes (no behavior regression on the happy path)", async () => {
  const logCalls = [];
  let getLogLevelCalls = 0;

  global.window.electronAPI = {
    getLogLevel: async () => {
      getLogLevelCalls += 1;
      return "debug";
    },
    log: async (entry) => {
      logCalls.push(entry);
    },
  };

  const logger = freshLogger();

  await logger.debug("first");
  await logger.debug("second");

  assert.equal(getLogLevelCalls, 1, "a successful resolution must still be cached/memoized");
  assert.equal(logCalls.length, 2, "both debug calls should be forwarded once level is debug");
  assert.equal(logCalls[0].message, "first");
  assert.equal(logCalls[1].message, "second");
});
