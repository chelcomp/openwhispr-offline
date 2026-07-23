const test = require("node:test");
const assert = require("node:assert/strict");

// Exercises appendScreenContextSuffix() (see docs/specs/active-window-screen-context.md
// "Threading OCR text into the LLM context"). Run via the tsxRegister loader
// (package.json's test script already wires `--import ./test/setup/tsxRegister.js`
// for test/components/*.test.js), since src/config/prompts/index.ts is TS/ESM.
const { appendScreenContextSuffix } = require("../../src/config/prompts/index.ts");

test("appendScreenContextSuffix is a no-op when screen text is null/empty", () => {
  const prompt = "Base prompt.";
  assert.equal(appendScreenContextSuffix(prompt, null), prompt);
  assert.equal(appendScreenContextSuffix(prompt, ""), prompt);
  assert.equal(appendScreenContextSuffix(prompt, "   "), prompt);
  assert.equal(appendScreenContextSuffix(prompt, undefined), prompt);
});

test("appendScreenContextSuffix appends and wraps screen text in a tagged block", () => {
  const prompt = "Base prompt.";
  const result = appendScreenContextSuffix(prompt, "Visible window text here", "en");
  assert.ok(result.startsWith(prompt));
  assert.ok(result.includes("<screen_context>"));
  assert.ok(result.includes("Visible window text here"));
  assert.ok(result.includes("</screen_context>"));
});
