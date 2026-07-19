const test = require("node:test");
const assert = require("node:assert/strict");

const modelRegistryData = require("../../src/models/modelRegistryData.json");

const FIVE_GB = 5 * 1024 ** 3;

function allLocalModels() {
  const results = [];
  for (const provider of modelRegistryData.localProviders) {
    for (const model of provider.models) {
      results.push({ providerId: provider.id, ...model });
    }
  }
  return results;
}

test("every localProviders[].models[] entry has a well-formed schema", () => {
  for (const model of allLocalModels()) {
    assert.equal(typeof model.id, "string", `${model.providerId}: id must be a string`);
    assert.ok(model.id.length > 0, `${model.providerId}: id must be non-empty`);

    assert.equal(typeof model.name, "string", `${model.id}: name must be a string`);
    assert.ok(model.name.length > 0, `${model.id}: name must be non-empty`);

    assert.equal(typeof model.fileName, "string", `${model.id}: fileName must be a string`);
    assert.ok(model.fileName.length > 0, `${model.id}: fileName must be non-empty`);

    assert.equal(typeof model.hfRepo, "string", `${model.id}: hfRepo must be a string`);
    assert.ok(model.hfRepo.length > 0, `${model.id}: hfRepo must be non-empty`);

    assert.equal(typeof model.sizeBytes, "number", `${model.id}: sizeBytes must be a number`);
    assert.ok(
      Number.isInteger(model.sizeBytes) && model.sizeBytes > 0,
      `${model.id}: sizeBytes must be a positive integer`
    );

    assert.equal(
      typeof model.contextLength,
      "number",
      `${model.id}: contextLength must be a number`
    );
    assert.ok(
      Number.isInteger(model.contextLength) && model.contextLength > 0,
      `${model.id}: contextLength must be a positive integer`
    );
  }
});

test("Nemotron 3 Nano 4B is registered under the nvidia provider and fits the <5GB size band", () => {
  const model = allLocalModels().find((m) => m.id === "nemotron-3-nano-4b-q4_k_m");
  assert.ok(model, "nemotron-3-nano-4b-q4_k_m must exist in the registry");
  assert.equal(model.providerId, "nvidia");
  assert.ok(model.sizeBytes < FIVE_GB, "sizeBytes must be under the 5GB ceiling");
});

test("Llama 3.1 Nemotron Nano 8B is registered under the existing llama provider and fits the <5GB size band", () => {
  const model = allLocalModels().find((m) => m.id === "llama-3.1-nemotron-nano-8b-v1-q4_k_m");
  assert.ok(model, "llama-3.1-nemotron-nano-8b-v1-q4_k_m must exist in the registry");
  assert.equal(model.providerId, "llama");
  assert.ok(model.sizeBytes < FIVE_GB, "sizeBytes must be under the 5GB ceiling");
});
