const test = require("node:test");
const assert = require("node:assert/strict");

// Requiring the module must not perform any build/compile/download work, nor
// exit the process on non-Windows platforms — guarded by
// `if (require.main === module)` in scripts/build-windows-active-window-info.js.
const MODULE_PATH = require.resolve("../../scripts/build-windows-active-window-info");

function freshRequire() {
  delete require.cache[MODULE_PATH];
  return require(MODULE_PATH);
}

const { quotePath } = freshRequire();

test("quotePath: normal Windows path round-trips with doubled backslashes, wrapped in quotes", () => {
  const result = quotePath("C:\\dev\\foo\\bar.exe");

  // Every literal backslash in the input must be doubled exactly once (not
  // left singular, and not doubled again into visual mush).
  assert.equal(result, '"C:\\\\dev\\\\foo\\\\bar.exe"');

  // The whole thing must still be a single, properly closed quoted argument.
  assert.ok(result.startsWith('"'));
  assert.ok(result.endsWith('"'));
});

test("quotePath: a path ending in a backslash before the closing quote is not corrupted", () => {
  const result = quotePath("C:\\dev\\foo\\");

  // The trailing backslash must be doubled so it can never be read as
  // escaping the closing quote by a CRT-style argv parser.
  assert.equal(result, '"C:\\\\dev\\\\foo\\\\"');

  // Must end with an even run of backslashes immediately followed by the
  // closing quote — never a bare `\"` (single backslash + quote), which a
  // CRT parser would read as an escaped literal quote rather than the
  // argument terminator.
  const trailingBackslashMatch = result.match(/(\\+)"$/);
  assert.ok(trailingBackslashMatch, "must end with backslashes then a closing quote");
  assert.equal(
    trailingBackslashMatch[1].length % 2,
    0,
    "the run of backslashes before the closing quote must be even (properly escaped), not odd"
  );
});

test("quotePath: embedded double-quote characters are escaped", () => {
  const result = quotePath('C:\\dev\\weird"name.exe');

  assert.equal(result, '"C:\\\\dev\\\\weird\\"name.exe"');
});
