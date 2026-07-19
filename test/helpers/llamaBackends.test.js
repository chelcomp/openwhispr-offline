const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CpuBackend,
  VulkanBackend,
  CudaBackend,
  MetalBackend,
  getBackendChain,
  parseVulkanDeviceList,
  pickVulkanDevice,
} = require("../../src/helpers/llamaBackends.js");

const BASE_ARGS = ["--model", "/tmp/model.gguf", "--port", "8221"];
const DUMMY_BIN = "/opt/ektos/bin/llama-server";

// --- args: only GPU backends offload layers -------------------------------

test("cpu backend does not add --n-gpu-layers", () => {
  const args = new CpuBackend().buildArgs(BASE_ARGS);
  assert.equal(args.includes("--n-gpu-layers"), false);
});

test("cuda/vulkan/metal backends offload all layers", () => {
  for (const Backend of [CudaBackend, VulkanBackend, MetalBackend]) {
    const args = new Backend().buildArgs(BASE_ARGS);
    const idx = args.indexOf("--n-gpu-layers");
    assert.ok(idx >= 0, `${Backend.name} should offload layers`);
    assert.equal(args[idx + 1], "99");
  }
});

test("buildArgs does not mutate the base args", () => {
  const base = [...BASE_ARGS];
  new CudaBackend().buildArgs(base);
  assert.deepEqual(base, BASE_ARGS);
});

// --- env: CUDA vars live only on the CUDA backend -------------------------

test("cuda backend sets CUDA env vars", () => {
  const prev = process.env.INTELLIGENCE_GPU_UUID;
  process.env.INTELLIGENCE_GPU_UUID = "GPU-1234";
  try {
    const env = new CudaBackend().buildEnv(DUMMY_BIN);
    assert.equal(env.CUDA_DEVICE_ORDER, "PCI_BUS_ID");
    assert.equal(env.CUDA_VISIBLE_DEVICES, "GPU-1234");
  } finally {
    if (prev === undefined) delete process.env.INTELLIGENCE_GPU_UUID;
    else process.env.INTELLIGENCE_GPU_UUID = prev;
  }
});

test("vulkan and cpu backends never set CUDA env vars", () => {
  const prev = process.env.INTELLIGENCE_GPU_UUID;
  process.env.INTELLIGENCE_GPU_UUID = "GPU-1234";
  try {
    for (const Backend of [VulkanBackend, CpuBackend]) {
      const env = new Backend().buildEnv(DUMMY_BIN);
      assert.equal(env.CUDA_DEVICE_ORDER, undefined);
      assert.equal(env.CUDA_VISIBLE_DEVICES, undefined);
    }
  } finally {
    if (prev === undefined) delete process.env.INTELLIGENCE_GPU_UUID;
    else process.env.INTELLIGENCE_GPU_UUID = prev;
  }
});

test("every backend disables llama.cpp auto-fit probing", () => {
  for (const Backend of [CpuBackend, VulkanBackend, CudaBackend, MetalBackend]) {
    const env = new Backend().buildEnv(DUMMY_BIN);
    assert.equal(env.LLAMA_ARG_FIT, "off");
  }
});

// --- Vulkan device selection (mixed-vendor GPU pinning) --------------------

test("parseVulkanDeviceList parses --list-devices output despite parens in device names", () => {
  const output = [
    "Available devices:",
    "  Vulkan0: Intel(R) Arc(TM) Pro 140T GPU (32GB) (37039 MiB, 36270 MiB free)",
    "  Vulkan1: NVIDIA RTX PRO 1000 Blackwell Generation Laptop GPU (7822 MiB, 7054 MiB free)",
    "",
  ].join("\n");

  assert.deepEqual(parseVulkanDeviceList(output), [
    { id: "Vulkan0", name: "Intel(R) Arc(TM) Pro 140T GPU (32GB)" },
    { id: "Vulkan1", name: "NVIDIA RTX PRO 1000 Blackwell Generation Laptop GPU" },
  ]);
});

test("parseVulkanDeviceList returns nothing for a device-less (CPU-only) build", () => {
  assert.deepEqual(parseVulkanDeviceList("Available devices:\n"), []);
});

const MIXED_DEVICES = [
  { id: "Vulkan0", name: "Intel(R) Arc(TM) Pro 140T GPU (32GB)" },
  { id: "Vulkan1", name: "NVIDIA RTX PRO 1000 Blackwell Generation Laptop GPU" },
];

test("pickVulkanDevice pins the NVIDIA device for gpu-nvidia and auto modes", () => {
  assert.equal(pickVulkanDevice(MIXED_DEVICES, "gpu-nvidia"), "Vulkan1");
  assert.equal(pickVulkanDevice(MIXED_DEVICES, "auto"), "Vulkan1");
});

test("pickVulkanDevice pins the Intel device for gpu-intel mode", () => {
  assert.equal(pickVulkanDevice(MIXED_DEVICES, "gpu-intel"), "Vulkan0");
});

test("pickVulkanDevice does not pin when only one device is visible", () => {
  assert.equal(pickVulkanDevice([MIXED_DEVICES[1]], "gpu-nvidia"), null);
});

test("pickVulkanDevice does not pin when no device matches the requested vendor", () => {
  const amdOnly = [
    { id: "Vulkan0", name: "AMD Radeon RX 7900" },
    { id: "Vulkan1", name: "AMD Radeon RX 6600" },
  ];
  assert.equal(pickVulkanDevice(amdOnly, "gpu-nvidia"), null);
});

// --- chain ordering (non-darwin) ------------------------------------------

test("backend chain orders by GPU mode", { skip: process.platform === "darwin" }, () => {
  const names = (mode) => getBackendChain(mode).map((b) => b.name);
  assert.deepEqual(names("cpu"), ["cpu"]);
  assert.deepEqual(names("gpu-intel"), ["vulkan", "cpu"]);
  assert.deepEqual(names("gpu-nvidia"), ["cuda", "vulkan", "cpu"]);
  assert.deepEqual(names("auto"), ["cuda", "vulkan", "cpu"]);
});
