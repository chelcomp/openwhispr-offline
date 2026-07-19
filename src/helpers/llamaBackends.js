const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { app } = require("electron");

// Number of model layers to offload to the GPU. "99" = "all layers" in
// llama.cpp terms; CPU backend deliberately omits this flag.
const GPU_LAYERS = "99";
const DEFAULT_STARTUP_TIMEOUT_MS = 120000;

function binExt() {
  return process.platform === "win32" ? ".exe" : "";
}

// Bundled binaries live under resources/bin (packaged app) or the repo's
// resources/bin (dev). Used by the CPU and Metal backends.
function resolveResourceBinary(name) {
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, "bin", name));
  candidates.push(path.join(__dirname, "..", "..", "resources", "bin", name));

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        fs.statSync(candidate);
        return candidate;
      }
    } catch {
      // Can't access binary
    }
  }
  return null;
}

// GPU binaries are downloaded on demand into userData/bin (see
// llamaVulkanManager / llamaCudaManager). Used by the Vulkan and CUDA backends.
function resolveUserBinary(name) {
  try {
    const p = path.join(app.getPath("userData"), "bin", name);
    if (fs.existsSync(p)) return p;
  } catch {
    // userData unavailable (e.g. outside Electron)
  }
  return null;
}

// Prepend the binary's own directory to the platform library search path so the
// bundled shared libs (.dll/.so/.dylib) load. Shared by every backend.
function baseEnv(binDir) {
  const env = { ...process.env };

  if (process.platform === "darwin") {
    env.DYLD_LIBRARY_PATH = binDir + (env.DYLD_LIBRARY_PATH ? `:${env.DYLD_LIBRARY_PATH}` : "");
  } else if (process.platform === "linux") {
    env.LD_LIBRARY_PATH = binDir + (env.LD_LIBRARY_PATH ? `:${env.LD_LIBRARY_PATH}` : "");
  } else if (process.platform === "win32") {
    env.PATH = binDir + (env.PATH ? `;${env.PATH}` : "");
  }

  // Disable llama.cpp auto-fit memory probing (adds ~70s to startup). Set via env
  // so builds without --fit ignore it instead of erroring. See LLAMA_ARG_FIT.
  env.LLAMA_ARG_FIT = process.env.LLAMA_ARG_FIT || "off";

  return env;
}

/**
 * A llama-server backend. Each concrete backend owns exactly one execution
 * flavour (CPU, Vulkan, CUDA, Metal) and its own binary location, launch args
 * and environment. Backends never reach into each other's configuration — the
 * manager just walks a chain of them.
 */
class LlamaBackend {
  constructor() {
    this.name = "base";
    this.gpuAccelerated = false;
    this.startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS;
  }

  getBinaryPath() {
    return null;
  }

  isAvailable() {
    return this.getBinaryPath() !== null;
  }

  // Args common to every backend; subclasses add their own (e.g. GPU offload).
  buildArgs(baseArgs) {
    return [...baseArgs];
  }

  buildEnv(binaryPath) {
    return baseEnv(path.dirname(binaryPath));
  }
}

// CPU: bundled binary, no GPU offload, no GPU-specific env at all.
class CpuBackend extends LlamaBackend {
  constructor() {
    super();
    this.name = "cpu";
  }

  getBinaryPath() {
    const ext = binExt();
    const platformArch = `${process.platform}-${process.arch}`;
    return (
      resolveResourceBinary(`llama-server-${platformArch}-cpu${ext}`) ||
      resolveResourceBinary(`llama-server-${platformArch}${ext}`) ||
      resolveResourceBinary(`llama-server${ext}`)
    );
  }
}

// Parses `llama-server --list-devices` output, e.g.:
//   Vulkan0: Intel(R) Arc(TM) Pro 140T GPU (32GB) (37039 MiB, 36270 MiB free)
//   Vulkan1: NVIDIA RTX PRO 1000 Blackwell Generation Laptop GPU (7822 MiB, 7054 MiB free)
// The trailing "(<n> MiB...)" memory report is what delimits the device name,
// since device names themselves can contain parens (e.g. "Intel(R)").
const VULKAN_DEVICE_LINE = /^\s*(\S+):\s*(.+?)\s*\(\d[\d,]*\s*MiB/;

function parseVulkanDeviceList(output) {
  const devices = [];
  for (const line of output.split("\n")) {
    const m = VULKAN_DEVICE_LINE.exec(line);
    if (m) devices.push({ id: m[1], name: m[2].trim() });
  }
  return devices;
}

const vulkanDeviceCache = new Map();

// Asks the Vulkan binary itself which devices it sees (`--list-devices` exits
// immediately without loading a model) so device pinning always matches
// llama.cpp's own enumeration order, rather than a separate GPU probe (e.g.
// nvidia-smi or Electron's GPU info) that could disagree with it.
function listVulkanDevices(binaryPath) {
  if (!binaryPath) return [];
  if (vulkanDeviceCache.has(binaryPath)) return vulkanDeviceCache.get(binaryPath);

  let devices = [];
  try {
    const output = execFileSync(binaryPath, ["--list-devices"], {
      timeout: 5000,
      windowsHide: true,
    }).toString();
    devices = parseVulkanDeviceList(output);
  } catch {
    devices = [];
  }

  vulkanDeviceCache.set(binaryPath, devices);
  return devices;
}

// Vulkan: on-demand binary, offloads to GPU. Vulkan device selection is
// independent of CUDA, so it never touches CUDA_* env vars.
class VulkanBackend extends LlamaBackend {
  constructor() {
    super();
    this.name = "vulkan";
    this.gpuAccelerated = true;
  }

  getBinaryPath() {
    return resolveUserBinary(`llama-server-vulkan${binExt()}`);
  }

  // On mixed-vendor machines (e.g. an Intel iGPU/Arc alongside a discrete
  // NVIDIA GPU), llama.cpp's default split-mode offloads layers across every
  // visible Vulkan device — silently mixing vendors, or landing entirely on
  // the wrong one, if we don't pin. Pin explicitly whenever more than one
  // device is visible; single-GPU machines have nothing to disambiguate.
  buildArgs(baseArgs, gpuMode) {
    const args = [...baseArgs, "--n-gpu-layers", GPU_LAYERS];
    const deviceId = pickVulkanDevice(listVulkanDevices(this.getBinaryPath()), gpuMode);
    if (deviceId) args.push("--device", deviceId);
    return args;
  }
}

function pickVulkanDevice(devices, gpuMode) {
  if (devices.length <= 1) return null;
  const vendorPattern = gpuMode === "gpu-intel" ? /intel/i : /nvidia/i;
  const target = devices.find((d) => vendorPattern.test(d.name));
  return target ? target.id : null;
}

// CUDA: on-demand binary, offloads to GPU, and pins the NVIDIA device via CUDA
// env vars. These env vars are CUDA-only and live nowhere else.
class CudaBackend extends LlamaBackend {
  constructor() {
    super();
    this.name = "cuda";
    this.gpuAccelerated = true;
  }

  getBinaryPath() {
    return resolveUserBinary(`llama-server-cuda${binExt()}`);
  }

  buildArgs(baseArgs) {
    return [...baseArgs, "--n-gpu-layers", GPU_LAYERS];
  }

  buildEnv(binaryPath) {
    const env = super.buildEnv(binaryPath);
    // Select GPU by UUID + PCI_BUS_ID order so the device is unambiguous. See #531.
    env.CUDA_DEVICE_ORDER = "PCI_BUS_ID";
    if (process.env.INTELLIGENCE_GPU_UUID) {
      env.CUDA_VISIBLE_DEVICES = process.env.INTELLIGENCE_GPU_UUID;
    }
    return env;
  }
}

// Metal: bundled macOS binary, offloads to the Apple GPU.
class MetalBackend extends LlamaBackend {
  constructor() {
    super();
    this.name = "metal";
    this.gpuAccelerated = true;
  }

  getBinaryPath() {
    const ext = binExt();
    const platformArch = `${process.platform}-${process.arch}`;
    return (
      resolveResourceBinary(`llama-server-${platformArch}`) ||
      resolveResourceBinary(`llama-server${ext}`)
    );
  }

  buildArgs(baseArgs) {
    return [...baseArgs, "--n-gpu-layers", GPU_LAYERS];
  }
}

/**
 * Ordered list of backends to try for the given GPU mode, most-preferred first.
 * The manager starts the first one whose binary is present and that boots
 * successfully, falling back to the next on failure.
 *
 *   darwin      → Metal only
 *   cpu         → CPU only
 *   gpu-nvidia  → CUDA → Vulkan → CPU   (force CUDA, degrade gracefully)
 *   gpu-intel   → Vulkan → CPU          (CUDA is NVIDIA-only)
 *   auto        → CUDA → Vulkan → CPU
 */
function getBackendChain(gpuMode) {
  if (process.platform === "darwin") return [new MetalBackend()];

  if (gpuMode === "cpu") return [new CpuBackend()];
  if (gpuMode === "gpu-intel") return [new VulkanBackend(), new CpuBackend()];

  // gpu-nvidia and auto both prefer CUDA, then Vulkan, then CPU.
  return [new CudaBackend(), new VulkanBackend(), new CpuBackend()];
}

// Every backend type this platform could use, regardless of mode — for
// availability checks.
function getAllBackends() {
  if (process.platform === "darwin") return [new MetalBackend()];
  return [new CpuBackend(), new VulkanBackend(), new CudaBackend()];
}

module.exports = {
  LlamaBackend,
  CpuBackend,
  VulkanBackend,
  CudaBackend,
  MetalBackend,
  getBackendChain,
  getAllBackends,
  listVulkanDevices,
  parseVulkanDeviceList,
  pickVulkanDevice,
  DEFAULT_STARTUP_TIMEOUT_MS,
};
