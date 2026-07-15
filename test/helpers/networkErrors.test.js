const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

// Patch debugLogger before requiring networkErrors so the warn call in
// classifyAndLog doesn't blow up in a test context.
const _origLoad = Module._load.bind(Module);
const warnCalls = [];
Module._load = function (id, parent, isMain) {
  if (id === "./debugLogger") {
    return {
      warn: (...args) => warnCalls.push(args),
      debug: () => {},
      error: () => {},
      info: () => {},
    };
  }
  return _origLoad(id, parent, isMain);
};

const { classifyNetworkError, classifyAndLog } = require("../../src/helpers/networkErrors.js");

// classifyNetworkError

test("null error is not a network error", () => {
  assert.deepEqual(classifyNetworkError(null), { isNetworkError: false });
});

test("undefined error is not a network error", () => {
  assert.deepEqual(classifyNetworkError(undefined), { isNetworkError: false });
});

test("ENOTFOUND → dnsBlocked", () => {
  const result = classifyNetworkError({ code: "ENOTFOUND" });
  assert.equal(result.isNetworkError, true);
  assert.equal(result.messageKey, "streaming.errors.cloudUnreachable.dnsBlocked");
  assert.equal(result.code, "ENOTFOUND");
});

test("ECONNREFUSED → refused", () => {
  const result = classifyNetworkError({ code: "ECONNREFUSED" });
  assert.equal(result.isNetworkError, true);
  assert.equal(result.messageKey, "streaming.errors.cloudUnreachable.refused");
});

test("ECONNRESET → refused", () => {
  const result = classifyNetworkError({ code: "ECONNRESET" });
  assert.equal(result.isNetworkError, true);
  assert.equal(result.messageKey, "streaming.errors.cloudUnreachable.refused");
});

test("UND_ERR_SOCKET → refused", () => {
  const result = classifyNetworkError({ code: "UND_ERR_SOCKET" });
  assert.equal(result.isNetworkError, true);
  assert.equal(result.messageKey, "streaming.errors.cloudUnreachable.refused");
});

test("ETIMEDOUT → timeout", () => {
  const result = classifyNetworkError({ code: "ETIMEDOUT" });
  assert.equal(result.isNetworkError, true);
  assert.equal(result.messageKey, "streaming.errors.cloudUnreachable.timeout");
});

test("UND_ERR_CONNECT_TIMEOUT → timeout", () => {
  const result = classifyNetworkError({ code: "UND_ERR_CONNECT_TIMEOUT" });
  assert.equal(result.isNetworkError, true);
  assert.equal(result.messageKey, "streaming.errors.cloudUnreachable.timeout");
});

test("TLS errors → tls", () => {
  for (const code of [
    "CERT_HAS_EXPIRED",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
  ]) {
    const result = classifyNetworkError({ code });
    assert.equal(result.isNetworkError, true, `${code} should be a network error`);
    assert.equal(result.messageKey, "streaming.errors.cloudUnreachable.tls");
  }
});

test("code via cause → recognized", () => {
  const result = classifyNetworkError({ cause: { code: "ECONNREFUSED" } });
  assert.equal(result.isNetworkError, true);
  assert.equal(result.messageKey, "streaming.errors.cloudUnreachable.refused");
});

test("TimeoutError by name → timeout", () => {
  const result = classifyNetworkError({ name: "TimeoutError" });
  assert.equal(result.isNetworkError, true);
  assert.equal(result.messageKey, "streaming.errors.cloudUnreachable.timeout");
});

test("AbortError by name → timeout", () => {
  const result = classifyNetworkError({ name: "AbortError" });
  assert.equal(result.isNetworkError, true);
  assert.equal(result.messageKey, "streaming.errors.cloudUnreachable.timeout");
});

test("generic Error is not a network error", () => {
  const result = classifyNetworkError(new Error("something went wrong"));
  assert.equal(result.isNetworkError, false);
});

test("error with unknown code is not a network error", () => {
  const result = classifyNetworkError({ code: "EACCES" });
  assert.equal(result.isNetworkError, false);
});

// classifyAndLog

test("classifyAndLog returns isNetworkError false for non-network error", () => {
  const result = classifyAndLog(new Error("not a network error"), "https://example.com");
  assert.equal(result.isNetworkError, false);
});

test("classifyAndLog returns network error result for ECONNREFUSED", () => {
  warnCalls.length = 0;
  const result = classifyAndLog(
    { code: "ECONNREFUSED" },
    "https://api.ektoswhispr.com/v1/transcribe"
  );
  assert.equal(result.isNetworkError, true);
  assert.equal(result.messageKey, "streaming.errors.cloudUnreachable.refused");
  assert.ok(warnCalls.length > 0, "expected warn to be called");
});

test("classifyAndLog handles invalid URL without throwing", () => {
  assert.doesNotThrow(() => {
    classifyAndLog({ code: "ENOTFOUND" }, "not-a-valid-url");
  });
});
