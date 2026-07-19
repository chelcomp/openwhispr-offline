const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveWhisperGpuMode,
  resolveLlamaGpuMode,
  getResolvedLabel,
} = require("../../src/utils/gpuModeResolver.js");

// resolveWhisperGpuMode

test("whisper: explicit gpu-nvidia mode always returns gpu-nvidia", () => {
  assert.equal(resolveWhisperGpuMode({ mode: "gpu-nvidia" }), "gpu-nvidia");
  assert.equal(
    resolveWhisperGpuMode({ mode: "gpu-nvidia", hasNvidia: false, cudaReady: false }),
    "gpu-nvidia"
  );
});

test("whisper: explicit cpu mode always returns cpu", () => {
  assert.equal(
    resolveWhisperGpuMode({ mode: "cpu", hasNvidia: true, cudaReady: true }),
    "cpu"
  );
});

test("whisper: auto with nvidia + cuda returns gpu-nvidia", () => {
  assert.equal(
    resolveWhisperGpuMode({ mode: "auto", hasNvidia: true, cudaReady: true }),
    "gpu-nvidia"
  );
});

test("whisper: auto with nvidia but no cuda returns cpu", () => {
  assert.equal(
    resolveWhisperGpuMode({ mode: "auto", hasNvidia: true, cudaReady: false }),
    "cpu"
  );
});

test("whisper: auto without nvidia returns cpu", () => {
  assert.equal(
    resolveWhisperGpuMode({ mode: "auto", hasNvidia: false, cudaReady: false }),
    "cpu"
  );
});

test("whisper: default mode is auto (no nvidia → cpu)", () => {
  assert.equal(resolveWhisperGpuMode({}), "cpu");
});

// resolveLlamaGpuMode

test("llama: explicit gpu-nvidia returns gpu-nvidia", () => {
  assert.equal(resolveLlamaGpuMode({ mode: "gpu-nvidia" }), "gpu-nvidia");
});

test("llama: explicit gpu-intel returns gpu-intel", () => {
  assert.equal(resolveLlamaGpuMode({ mode: "gpu-intel" }), "gpu-intel");
});

test("llama: explicit cpu returns cpu", () => {
  assert.equal(
    resolveLlamaGpuMode({ mode: "cpu", hasNvidia: true, vulkanReady: true }),
    "cpu"
  );
});

test("llama: auto with vulkan + nvidia returns gpu-nvidia", () => {
  assert.equal(
    resolveLlamaGpuMode({ mode: "auto", hasNvidia: true, vulkanReady: true }),
    "gpu-nvidia"
  );
});

test("llama: auto with vulkan + intel (no nvidia) returns gpu-intel", () => {
  assert.equal(
    resolveLlamaGpuMode({ mode: "auto", hasNvidia: false, hasIntel: true, vulkanReady: true }),
    "gpu-intel"
  );
});

test("llama: auto with vulkan but no nvidia/intel returns cpu", () => {
  assert.equal(
    resolveLlamaGpuMode({ mode: "auto", hasNvidia: false, hasIntel: false, vulkanReady: true }),
    "cpu"
  );
});

test("llama: auto without vulkan returns cpu", () => {
  assert.equal(
    resolveLlamaGpuMode({ mode: "auto", hasNvidia: true, hasIntel: true, vulkanReady: false }),
    "cpu"
  );
});

test("llama: nvidia takes priority over intel when both present + vulkan", () => {
  assert.equal(
    resolveLlamaGpuMode({ mode: "auto", hasNvidia: true, hasIntel: true, vulkanReady: true }),
    "gpu-nvidia"
  );
});

test("llama: auto with cuda ready + nvidia (no vulkan) returns gpu-nvidia", () => {
  assert.equal(
    resolveLlamaGpuMode({ mode: "auto", hasNvidia: true, vulkanReady: false, cudaReady: true }),
    "gpu-nvidia"
  );
});

test("llama: auto with cuda ready but no nvidia returns cpu", () => {
  assert.equal(
    resolveLlamaGpuMode({ mode: "auto", hasNvidia: false, hasIntel: false, cudaReady: true }),
    "cpu"
  );
});

test("llama: cuda readiness does not enable intel path", () => {
  assert.equal(
    resolveLlamaGpuMode({ mode: "auto", hasIntel: true, vulkanReady: false, cudaReady: true }),
    "cpu"
  );
});

// getResolvedLabel

test("getResolvedLabel for gpu-nvidia", () => {
  assert.equal(getResolvedLabel("gpu-nvidia"), "NVIDIA GPU");
});

test("getResolvedLabel for gpu-intel", () => {
  assert.equal(getResolvedLabel("gpu-intel"), "Intel GPU");
});

test("getResolvedLabel for cpu", () => {
  assert.equal(getResolvedLabel("cpu"), "CPU");
});

test("getResolvedLabel for unknown mode falls back to CPU", () => {
  assert.equal(getResolvedLabel("gpu-amd"), "CPU");
  assert.equal(getResolvedLabel(undefined), "CPU");
});
