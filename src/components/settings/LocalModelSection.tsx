import { useState, useEffect, useCallback, useMemo } from "react";
import { useSettingsStore } from "../../stores/settingsStore";
import LocalModelPicker, { type LocalProvider } from "../LocalModelPicker";
import { GpuModeSelector } from "../ui/GpuModeSelector";
import { modelRegistry } from "../../models/ModelRegistry";
import logger from "../../utils/logger";

export default function LocalModelSection() {
  const localModel = useSettingsStore((s) => s.localModel);
  const localProvider = useSettingsStore((s) => s.localProvider);
  const setLocalModel = useSettingsStore((s) => s.setLocalModel);
  const setLocalProvider = useSettingsStore((s) => s.setLocalProvider);

  const localProviders = useMemo<LocalProvider[]>(() => {
    return modelRegistry.getAllProviders().map((provider) => ({
      id: provider.id,
      name: provider.name,
      models: provider.models.map((model) => ({
        id: model.id,
        name: model.name,
        size: model.size,
        sizeBytes: model.sizeBytes,
        description: model.description,
        descriptionKey: model.descriptionKey,
        specUrl: model.hfRepo ? `https://huggingface.co/${model.hfRepo}` : undefined,
        recommended: model.recommended,
      })),
    }));
  }, []);

  const [downloadedModels, setDownloadedModels] = useState<Set<string>>(new Set());

  const loadDownloadedModels = useCallback(async () => {
    try {
      const result = await window.electronAPI?.modelGetAll?.();
      if (result && Array.isArray(result)) {
        const downloaded = new Set(
          result
            .filter((m: { isDownloaded?: boolean }) => m.isDownloaded)
            .map((m: { id: string }) => m.id)
        );
        setDownloadedModels(downloaded);
        return downloaded;
      }
    } catch (error) {
      logger.error("Failed to load downloaded models", { error }, "models");
    }
    return new Set<string>();
  }, []);

  useEffect(() => {
    loadDownloadedModels();
  }, [loadDownloadedModels]);

  const handleProviderChange = async (providerId: string) => {
    setLocalProvider(providerId);
    const downloaded = await loadDownloadedModels();
    const provider = localProviders.find((p) => p.id === providerId);
    const models = provider?.models ?? [];
    if (models.length > 0) {
      const firstDownloaded = models.find((m) => downloaded.has(m.id));
      setLocalModel(firstDownloaded?.id ?? "");
    }
  };

  return (
    <div className="space-y-4">
      <GpuModeSelector type="llama" />
      <LocalModelPicker
        providers={localProviders}
        selectedModel={localModel}
        selectedProvider={localProvider || "qwen"}
        onModelSelect={setLocalModel}
        onProviderSelect={handleProviderChange}
        modelType="llm"
        colorScheme="purple"
        onDownloadComplete={loadDownloadedModels}
      />
    </div>
  );
}
