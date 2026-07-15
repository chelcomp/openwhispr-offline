const test = require("node:test");
const assert = require("node:assert/strict");

// wavBuilder.ts uses Blob (available in Node 18+) and DataView — no imports.
const load = () => import("../../src/utils/wavBuilder.ts");

test("buildWav produces a Blob of type audio/wav", async () => {
  const { buildWav } = await load();
  const samples = new Int16Array([0, 100, 200, -100]);
  const blob = buildWav(samples, 16000);
  assert.equal(blob.type, "audio/wav");
});

test("buildWav output size is 44 + (samples * 2) bytes", async () => {
  const { buildWav } = await load();
  const samples = new Int16Array([1, 2, 3, 4, 5]);
  const blob = buildWav(samples, 16000);
  assert.equal(blob.size, 44 + 5 * 2);
});

test("buildWav header starts with RIFF and WAVE markers", async () => {
  const { buildWav } = await load();
  const samples = new Int16Array([0]);
  const blob = buildWav(samples, 16000);
  const buffer = await blob.arrayBuffer();
  const view = new DataView(buffer);

  const riff = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3)
  );
  const wave = String.fromCharCode(
    view.getUint8(8),
    view.getUint8(9),
    view.getUint8(10),
    view.getUint8(11)
  );
  assert.equal(riff, "RIFF");
  assert.equal(wave, "WAVE");
});

test("buildWav writes sample rate at offset 24", async () => {
  const { buildWav } = await load();
  const samples = new Int16Array([0]);
  const blob = buildWav(samples, 44100);
  const buffer = await blob.arrayBuffer();
  const view = new DataView(buffer);
  assert.equal(view.getUint32(24, true), 44100);
});

test("buildWav PCM samples preserved in data section", async () => {
  const { buildWav } = await load();
  const samples = new Int16Array([1000, -1000, 32767]);
  const blob = buildWav(samples, 16000);
  const buffer = await blob.arrayBuffer();
  const outputSamples = new Int16Array(buffer, 44);
  assert.equal(outputSamples[0], 1000);
  assert.equal(outputSamples[1], -1000);
  assert.equal(outputSamples[2], 32767);
});

test("buildWav total data chunk size is 2 * samples.length", async () => {
  const { buildWav } = await load();
  const samples = new Int16Array([1, 2, 3]);
  const blob = buildWav(samples, 16000);
  const buffer = await blob.arrayBuffer();
  const view = new DataView(buffer);
  // data size at offset 40
  assert.equal(view.getUint32(40, true), 6);
});

test("buildWav empty samples array produces minimal valid WAV", async () => {
  const { buildWav } = await load();
  const samples = new Int16Array([]);
  const blob = buildWav(samples, 16000);
  assert.equal(blob.size, 44);
  assert.equal(blob.type, "audio/wav");
});
