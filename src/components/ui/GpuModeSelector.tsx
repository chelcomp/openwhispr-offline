import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./button";
import { DownloadProgressBar } from "./DownloadProgressBar";
import type { GpuModeInfo } from "../../types/electron";
import { getCachedPlatform } from "../../utils/platform";

interface GpuModeSelectorProps {
  type: "whisper" | "llama";
}

type GpuMode = "auto" | "cpu" | "gpu-intel" | "gpu-nvidia";

export function GpuModeSelector({ type }: GpuModeSelectorProps) {
  const { t } = useTranslation();
  const platform = getCachedPlatform();
  const [info, setInfo] = useState<GpuModeInfo | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadPct, setDownloadPct] = useState(0);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const fetchInfo = useCallback(async () => {
    try {
      const result = await window.electronAPI?.getGpuModeInfo?.();
      if (result) setInfo(result);
    } catch {}
  }, []);

  useEffect(() => {
    fetchInfo();
  }, [fetchInfo]);

  // Listen for CUDA download progress
  useEffect(() => {
    if (type !== "whisper") return;
    const cleanup = window.electronAPI?.onCudaDownloadProgress?.((data) => {
      setDownloadPct(data.percentage ?? 0);
    });
    return () => cleanup?.();
  }, [type]);

  // Listen for llama GPU download progress (Vulkan for Intel, CUDA for NVIDIA)
  useEffect(() => {
    if (type !== "llama") return;
    const cleanupVulkan = window.electronAPI?.onLlamaVulkanDownloadProgress?.((data) => {
      setDownloadPct(data.percentage ?? 0);
    });
    const cleanupCuda = window.electronAPI?.onLlamaCudaDownloadProgress?.((data) => {
      setDownloadPct(data.percentage ?? 0);
    });
    return () => {
      cleanupVulkan?.();
      cleanupCuda?.();
    };
  }, [type]);

  if (platform === "darwin") return null;

  const currentMode: GpuMode =
    type === "whisper" ? (info?.whisperMode ?? "auto") : (info?.llamaMode ?? "auto");

  const resolvedLabel =
    type === "whisper" ? info?.resolvedWhisperLabel : info?.resolvedLlamaLabel;

  // Build available options
  const options: Array<{ id: GpuMode; label: string; available: boolean }> = [
    {
      id: "auto",
      label: resolvedLabel
        ? t("gpu.mode.auto", { backend: resolvedLabel })
        : t("gpu.mode.autoDetecting"),
      available: true,
    },
    { id: "cpu", label: "CPU", available: true },
  ];

  if (type === "whisper") {
    options.push({ id: "gpu-nvidia", label: "GPU NVIDIA", available: !!info?.hasNvidia });
  } else {
    options.push({ id: "gpu-intel", label: "GPU Intel", available: !!info?.hasIntel });
    options.push({ id: "gpu-nvidia", label: "GPU NVIDIA", available: !!info?.hasNvidia });
  }

  // Determine if current GPU selection needs a binary download.
  // NVIDIA uses CUDA (whisper + llama); Intel (llama only) uses Vulkan.
  const needsCudaDownload =
    currentMode === "gpu-nvidia" &&
    info !== null &&
    (type === "whisper" ? !info.cudaReady : !info.llamaCudaReady);
  const needsVulkanDownload =
    type === "llama" && currentMode === "gpu-intel" && info !== null && !info.vulkanReady;

  const handleSelect = async (mode: GpuMode) => {
    if (type === "whisper") {
      await window.electronAPI?.setWhisperGpuMode?.(mode);
    } else {
      await window.electronAPI?.setLlamaGpuMode?.(mode);
    }
    await fetchInfo();
  };

  const handleDownloadCuda = async () => {
    setDownloading(true);
    setDownloadError(null);
    setDownloadPct(0);
    try {
      const result =
        type === "whisper"
          ? await window.electronAPI?.downloadCudaWhisperBinary?.()
          : await window.electronAPI?.downloadLlamaCudaBinary?.();
      if (result?.success) {
        await fetchInfo();
      } else {
        setDownloadError(result?.error || t("gpu.downloadFailed"));
      }
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : t("gpu.downloadFailed"));
    } finally {
      setDownloading(false);
    }
  };

  const handleDownloadVulkan = async () => {
    setDownloading(true);
    setDownloadError(null);
    setDownloadPct(0);
    try {
      const result = await window.electronAPI?.downloadLlamaVulkanBinary?.();
      if (result?.success) {
        await fetchInfo();
      } else {
        setDownloadError(result?.error || t("gpu.downloadFailed"));
      }
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : t("gpu.downloadFailed"));
    } finally {
      setDownloading(false);
    }
  };

  const handleCancelDownload = async () => {
    if (type === "whisper") {
      await window.electronAPI?.cancelCudaWhisperDownload?.();
    } else if (currentMode === "gpu-nvidia") {
      await window.electronAPI?.cancelLlamaCudaDownload?.();
    } else {
      await window.electronAPI?.cancelLlamaVulkanDownload?.();
    }
    setDownloading(false);
    setDownloadPct(0);
  };

  return (
    <div className="space-y-1.5">
      {/* Mode pill buttons */}
      <div className="flex gap-1 flex-wrap">
        {options.map((opt) => {
          const isSelected = currentMode === opt.id;
          const isDisabled = !opt.available && opt.id !== "auto" && opt.id !== "cpu";
          return (
            <button
              key={opt.id}
              onClick={() => !isDisabled && handleSelect(opt.id)}
              disabled={isDisabled}
              className={[
                "px-2.5 py-1 text-xs font-medium rounded-md border transition-colors",
                isSelected
                  ? "bg-primary text-primary-foreground border-primary"
                  : isDisabled
                    ? "bg-muted/30 text-muted-foreground/40 border-border/30 cursor-not-allowed"
                    : "bg-transparent text-muted-foreground border-border hover:text-foreground hover:border-border-hover",
              ].join(" ")}
            >
              {opt.label}
            </button>
          );
        })}
      </div>

      {/* Download prompt for CUDA (whisper) */}
      {needsCudaDownload && !downloading && (
        <div className="rounded-md border border-border bg-surface-1 px-2.5 py-2 flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">{t("gpu.cudaRequired")}</span>
          <Button
            size="sm"
            variant="default"
            className="h-6 px-2.5 text-xs shrink-0"
            onClick={handleDownloadCuda}
          >
            {t("gpu.download")}
          </Button>
        </div>
      )}

      {/* Download prompt for Vulkan (llama) */}
      {needsVulkanDownload && !downloading && (
        <div className="rounded-md border border-border bg-surface-1 px-2.5 py-2 flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">{t("gpu.vulkanRequired")}</span>
          <Button
            size="sm"
            variant="default"
            className="h-6 px-2.5 text-xs shrink-0"
            onClick={handleDownloadVulkan}
          >
            {t("gpu.download")}
          </Button>
        </div>
      )}

      {/* Download progress */}
      {downloading && (
        <div className="space-y-1">
          <DownloadProgressBar
            modelName={
              type === "whisper" || currentMode === "gpu-nvidia"
                ? t("gpu.cudaBinaryName")
                : t("gpu.vulkanBinaryName")
            }
            progress={{ downloadedBytes: 0, totalBytes: 0, percentage: downloadPct }}
          />
          <div className="flex justify-end">
            <button
              onClick={handleCancelDownload}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {t("gpu.cancel")}
            </button>
          </div>
        </div>
      )}

      {/* Download error */}
      {downloadError && (
        <p className="text-xs text-destructive px-0.5">{downloadError}</p>
      )}
    </div>
  );
}
