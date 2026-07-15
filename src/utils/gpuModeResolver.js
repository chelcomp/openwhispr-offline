/**
 * Resolves the effective GPU backend based on the user's mode preference
 * and available hardware/binaries.
 *
 * Whisper: auto | cpu | gpu-nvidia
 * LLM:     auto | cpu | gpu-intel | gpu-nvidia
 *
 * Auto priority: NVIDIA CUDA > Intel/AMD Vulkan > CPU
 */

function resolveWhisperGpuMode({ mode = "auto", hasNvidia = false, cudaReady = false }) {
  if (mode === "gpu-nvidia") return "gpu-nvidia";
  if (mode === "cpu") return "cpu";
  if (hasNvidia && cudaReady) return "gpu-nvidia";
  return "cpu";
}

function resolveLlamaGpuMode({ mode = "auto", hasNvidia = false, hasIntel = false, vulkanReady = false }) {
  if (mode === "gpu-nvidia") return "gpu-nvidia";
  if (mode === "gpu-intel") return "gpu-intel";
  if (mode === "cpu") return "cpu";
  if (vulkanReady) {
    if (hasNvidia) return "gpu-nvidia";
    if (hasIntel) return "gpu-intel";
  }
  return "cpu";
}

const RESOLVED_LABELS = {
  "gpu-nvidia": "NVIDIA GPU",
  "gpu-intel": "Intel GPU",
  "cpu": "CPU",
};

function getResolvedLabel(resolvedMode) {
  return RESOLVED_LABELS[resolvedMode] || "CPU";
}

module.exports = { resolveWhisperGpuMode, resolveLlamaGpuMode, getResolvedLabel };
