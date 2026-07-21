const { test } = require("node:test");
const assert = require("node:assert");
const { parseOfflineMessage } = require("../../src/helpers/parakeetWsResult");

const j = (obj) => JSON.stringify(obj);

test("parseOfflineMessage extracts .text from JSON, falls back to raw", () => {
  assert.strictEqual(parseOfflineMessage(j({ text: "  hello  " })), "hello");
  assert.strictEqual(parseOfflineMessage("plain text"), "plain text");
});
