const { test } = require("node:test");
const assert = require("node:assert");
const {
  createOnlineAccumulator,
  parseOnlineMessages,
  parseOfflineMessage,
} = require("../../src/helpers/parakeetWsResult");

const j = (obj) => JSON.stringify(obj);

test("parseOfflineMessage extracts .text from JSON, falls back to raw", () => {
  assert.strictEqual(parseOfflineMessage(j({ text: "  hello  " })), "hello");
  assert.strictEqual(parseOfflineMessage("plain text"), "plain text");
});

test("a non-final message shows as the live partial hypothesis", () => {
  const acc = createOnlineAccumulator();
  acc.push(j({ text: "hello wor", segment: 0, is_final: false }));
  assert.strictEqual(acc.text(), "hello wor");
});

test("an is_final message replaces the partial with the finalized segment", () => {
  const acc = createOnlineAccumulator();
  acc.push(j({ text: "hello wor", segment: 0, is_final: false }));
  acc.push(j({ text: "hello world", segment: 0, is_final: true }));
  assert.strictEqual(acc.text(), "hello world");
});

test("a partial after a finalized segment appends to the running text", () => {
  const acc = createOnlineAccumulator();
  acc.push(j({ text: "first.", segment: 0, is_final: true }));
  acc.push(j({ text: "second", segment: 1, is_final: false }));
  assert.strictEqual(acc.text(), "first. second");
});

test("a release-terminated tail that never gets is_final is still kept in text", () => {
  // Mirrors a hotkey release: the last segment stays a partial hypothesis (no
  // trailing silence to trigger an endpoint), but its text is the model's final
  // word and must survive into the pasted result.
  const acc = createOnlineAccumulator();
  acc.push(j({ text: "primeira frase.", segment: 0, is_final: true }));
  acc.push(j({ text: "segunda frase incompleta", segment: 1, is_final: false }));
  assert.strictEqual(acc.text(), "primeira frase. segunda frase incompleta");
});

test("finalized segments accumulate and dedupe by segment id", () => {
  assert.strictEqual(
    parseOnlineMessages([
      j({ text: "one", segment: 0, is_final: true }),
      j({ text: "one", segment: 0, is_final: true }), // duplicate resend
      j({ text: "two", segment: 1, is_final: true }),
    ]),
    "one two"
  );
});

test("empty-text messages are ignored", () => {
  const acc = createOnlineAccumulator();
  acc.push(j({ text: "done.", segment: 0, is_final: true }));
  acc.push(j({ text: "   ", segment: 1, is_final: false }));
  assert.strictEqual(acc.text(), "done.");
});
