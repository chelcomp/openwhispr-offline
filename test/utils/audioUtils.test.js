const test = require("node:test");
const assert = require("node:assert/strict");

const { downsample24kTo16k, pcm16ToWav, pcm16ToFloat32 } = require("../../src/utils/audioUtils.js");

// downsample24kTo16k

test("downsample24kTo16k output length is 2/3 of input samples", () => {
  // 6 input samples (12 bytes) → 4 output samples (8 bytes)
  const input = Buffer.from(new Int16Array([100, 200, 300, 400, 500, 600]).buffer);
  const output = downsample24kTo16k(input);
  const outSamples = new Int16Array(output.buffer, output.byteOffset, output.length / 2);
  assert.equal(outSamples.length, 4);
});

test("downsample24kTo16k applies the anti-aliasing FIR at the boundary", () => {
  const samples = new Int16Array([1000, 2000, 3000, 4000, 5000, 6000]);
  const input = Buffer.from(samples.buffer);
  const output = downsample24kTo16k(input);
  const outSamples = new Int16Array(output.buffer, output.byteOffset, output.length / 2);
  // output[0] centres the 5-tap FIR at input idx 0; the two taps left of the
  // boundary read as 0, so:
  //   0.375*1000 + 0.25*2000 + 0.0625*3000 = 1062.5 → round → 1063
  assert.equal(outSamples[0], 1063);
});

test("downsample24kTo16k returns a Buffer", () => {
  const input = Buffer.from(new Int16Array([0, 0, 0, 0, 0, 0]).buffer);
  const output = downsample24kTo16k(input);
  assert.ok(Buffer.isBuffer(output));
});

// pcm16ToWav

test("pcm16ToWav produces a valid WAV header", () => {
  const pcm = Buffer.from(new Int16Array([100, 200, 300]).buffer);
  const wav = pcm16ToWav(pcm, 16000, 1);
  assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(wav.subarray(8, 12).toString("ascii"), "WAVE");
  assert.equal(wav.subarray(12, 16).toString("ascii"), "fmt ");
  assert.equal(wav.subarray(36, 40).toString("ascii"), "data");
});

test("pcm16ToWav total size equals 44 + pcm data length", () => {
  const pcm = Buffer.from(new Int16Array([1, 2, 3, 4]).buffer); // 8 bytes
  const wav = pcm16ToWav(pcm, 16000, 1);
  assert.equal(wav.length, 44 + 8);
});

test("pcm16ToWav writes sample rate at offset 24", () => {
  const pcm = Buffer.from(new Int16Array([0]).buffer);
  const wav = pcm16ToWav(pcm, 44100, 1);
  assert.equal(wav.readUInt32LE(24), 44100);
});

test("pcm16ToWav writes data size at offset 40", () => {
  const pcm = Buffer.from(new Int16Array([1, 2, 3]).buffer); // 6 bytes
  const wav = pcm16ToWav(pcm, 16000, 1);
  assert.equal(wav.readUInt32LE(40), 6);
});

// pcm16ToFloat32

test("pcm16ToFloat32 converts 0 to 0.0", () => {
  const input = Buffer.from(new Int16Array([0]).buffer);
  const output = pcm16ToFloat32(input);
  assert.equal(output[0], 0);
});

test("pcm16ToFloat32 converts max positive to ~1.0", () => {
  const input = Buffer.from(new Int16Array([32767]).buffer);
  const output = pcm16ToFloat32(input);
  assert.ok(Math.abs(output[0] - 1.0) < 0.0001, `expected ~1.0, got ${output[0]}`);
});

test("pcm16ToFloat32 converts min negative to ~-1.0", () => {
  const input = Buffer.from(new Int16Array([-32768]).buffer);
  const output = pcm16ToFloat32(input);
  assert.ok(Math.abs(output[0] + 1.0) < 0.0001, `expected ~-1.0, got ${output[0]}`);
});

test("pcm16ToFloat32 output length matches input sample count", () => {
  const input = Buffer.from(new Int16Array([1, 2, 3, 4, 5]).buffer);
  const output = pcm16ToFloat32(input);
  assert.equal(output.length, 5);
});

test("pcm16ToFloat32 returns Float32Array", () => {
  const input = Buffer.from(new Int16Array([100]).buffer);
  const output = pcm16ToFloat32(input);
  assert.ok(output instanceof Float32Array);
});
