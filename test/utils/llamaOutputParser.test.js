const test = require("node:test");
const assert = require("node:assert/strict");

const { parseLlamaCppOutput } = require("../../src/utils/llamaOutputParser.js");

test("empty string returns empty string", () => {
  assert.equal(parseLlamaCppOutput(""), "");
});

test("null/undefined returns empty string", () => {
  assert.equal(parseLlamaCppOutput(null), "");
  assert.equal(parseLlamaCppOutput(undefined), "");
});

test("pure diagnostic lines are all filtered out", () => {
  const raw = [
    "llama_model_load: loading model",
    "ggml_init: mem required = 100 MB",
    "system_info: n_threads = 4",
    "main: seed = 12345",
  ].join("\n");
  assert.equal(parseLlamaCppOutput(raw), "");
});

test("generated text is preserved", () => {
  const raw = "Hello, this is the generated response.";
  assert.equal(parseLlamaCppOutput(raw), "Hello, this is the generated response.");
});

test("diagnostic lines are stripped but content lines are kept", () => {
  const raw = [
    "llama_model_load: loading model",
    "",
    "The capital of France is Paris.",
    "system_info: done",
  ].join("\n");
  assert.equal(parseLlamaCppOutput(raw), "The capital of France is Paris.");
});

test("timing stats at the end are stripped", () => {
  const raw = [
    "Here is the answer.",
    "",
    " load time =  200 ms",
    " sample time =  50 ms",
    " eval time =  100 ms",
    " total time =  350 ms",
  ].join("\n");
  assert.equal(parseLlamaCppOutput(raw), "Here is the answer.");
});

test("<|im_end|> end token is removed", () => {
  const raw = "The answer is 42.<|im_end|>";
  assert.equal(parseLlamaCppOutput(raw), "The answer is 42.");
});

test("<|end|> end token is removed", () => {
  const raw = "Done here.<|end|>";
  assert.equal(parseLlamaCppOutput(raw), "Done here.");
});

test("</s> end token is removed", () => {
  const raw = "Finished.</s>";
  assert.equal(parseLlamaCppOutput(raw), "Finished.");
});

test("[end of text] end token is removed case-insensitively", () => {
  const raw = "All done.[End of Text]";
  assert.equal(parseLlamaCppOutput(raw), "All done.");
});

test("leading empty lines before content are skipped", () => {
  const raw = "\n\n\nActual content here.";
  assert.equal(parseLlamaCppOutput(raw), "Actual content here.");
});

test("multiline content preserves internal newlines", () => {
  const raw = [
    "llama_model_load: loading",
    "First paragraph.",
    "",
    "Second paragraph.",
  ].join("\n");
  assert.equal(parseLlamaCppOutput(raw), "First paragraph.\n\nSecond paragraph.");
});

test("build info lines are filtered", () => {
  const raw = "build: 1234 (abc1234)\nHere is the output.";
  assert.equal(parseLlamaCppOutput(raw), "Here is the output.");
});
