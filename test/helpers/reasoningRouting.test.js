const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/reasoningRouting.js");

test("byok cloud provider maps to the providers mode", async () => {
  const { deriveReasoningMode } = await load();
  assert.equal(deriveReasoningMode("byok", "corti"), "providers");
});

test("byok custom provider maps to the self-hosted mode", async () => {
  const { deriveReasoningMode } = await load();
  assert.equal(deriveReasoningMode("byok", "custom"), "self-hosted");
});

test("unknown cloud mode falls back to providers", async () => {
  const { deriveReasoningMode } = await load();
  assert.equal(deriveReasoningMode("unknown", "corti"), "providers");
});

test("fan-out routes provider, model and mode to all four scopes", async () => {
  const { buildReasoningScopePatches } = await load();
  const { dictationCleanup, noteFormatting, dictationAgent, chatIntelligence } =
    buildReasoningScopePatches(
      {
        useCleanupModel: true,
        cleanupProvider: "corti",
        cleanupModel: "corti-s1-instant",
        cleanupCloudMode: "byok",
      },
      "providers"
    );

  assert.equal(dictationCleanup.cleanupProvider, "corti");
  assert.equal(dictationCleanup.cleanupModel, "corti-s1-instant");
  assert.equal(dictationCleanup.cleanupMode, "providers");

  for (const scope of [noteFormatting, dictationAgent, chatIntelligence]) {
    assert.equal(scope.provider, "corti");
    assert.equal(scope.model, "corti-s1-instant");
    assert.equal(scope.cloudMode, "byok");
    assert.equal(scope.mode, "providers");
  }
});

test("fan-out with partial settings only mirrors the provided routing fields", async () => {
  const { buildReasoningScopePatches } = await load();
  const { dictationCleanup, noteFormatting, dictationAgent, chatIntelligence } =
    buildReasoningScopePatches({ useCleanupModel: true }, "providers");

  assert.equal(dictationCleanup.useCleanupModel, true);
  assert.equal(dictationCleanup.cleanupMode, "providers");
  assert.equal("cleanupProvider" in dictationCleanup, false);

  for (const scope of [noteFormatting, dictationAgent, chatIntelligence]) {
    assert.equal(scope.mode, "providers");
    assert.equal("provider" in scope, false);
    assert.equal("model" in scope, false);
    assert.equal("cloudMode" in scope, false);
  }
});
