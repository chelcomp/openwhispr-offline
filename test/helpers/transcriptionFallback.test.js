const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/transcriptionFallback.js");

test("BYOK mode falls back to the user's own provider", async () => {
  const { resolveStreamingFallbackTarget } = await load();
  assert.equal(
    resolveStreamingFallbackTarget({
      useLocalWhisper: false,
      cloudTranscriptionMode: "byok",
      isSignedIn: false,
    }),
    "byok"
  );
});
