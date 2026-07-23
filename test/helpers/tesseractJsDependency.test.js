// Guards against the class of regression found in pr-reviewer's first pass on
// docs/specs/active-window-screen-context.md: `activeWindowOcr.js` calling
// `require("tesseract.js")` while the package was never added to
// package.json/node_modules. `activeWindowOcr.test.js` mocks `require` at the
// `Module._load` boundary, so it passes regardless of whether the real
// package exists — this file requires the REAL, un-mocked `tesseract.js`
// package and asserts it resolves and exposes the API surface
// `activeWindowOcr.js`'s `runTesseractOcr()` actually calls, so a future
// accidental removal of the dependency (e.g. an errant `npm prune`/lockfile
// edit) fails a fast, obvious test instead of silently degrading OCR.

const test = require("node:test");
const assert = require("node:assert/strict");

test("tesseract.js is a real, resolvable dependency (not just mocked in tests)", () => {
  assert.doesNotThrow(() => require.resolve("tesseract.js"));
});

test("tesseract.js exposes the recognize() API activeWindowOcr.js depends on", () => {
  const Tesseract = require("tesseract.js");
  assert.equal(typeof Tesseract.recognize, "function");
});

test("package.json declares tesseract.js as a direct dependency", () => {
  const pkg = require("../../package.json");
  assert.ok(
    pkg.dependencies["tesseract.js"],
    "tesseract.js must be listed in package.json dependencies, not just present in node_modules"
  );
});
