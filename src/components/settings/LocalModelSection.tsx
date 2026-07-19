import { useState, useEffect, useCallback, useMemo } from "react";
import { Cpu, RotateCcw, SlidersHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../stores/settingsStore";
import LocalModelPicker, { type LocalProvider } from "../LocalModelPicker";
import { GpuModeSelector } from "../ui/GpuModeSelector";
import { Input } from "../ui/input";
import { modelRegistry } from "../../models/ModelRegistry";
import logger from "../../utils/logger";

type ParamRowProps = {
  label: string;
  description: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function ParamRow({ label, description, value, min, max, step, onChange }: ParamRowProps) {
  const commit = (raw: number) => {
    if (Number.isFinite(raw)) onChange(clamp(raw, min, max));
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <Input
          type="number"
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(e) => commit(Number(e.target.value))}
          className="h-8 w-24 text-right tabular-nums"
        />
      </div>
      <input
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => commit(Number(e.target.value))}
        className="w-full accent-purple-500 cursor-pointer"
      />
      <p className="text-xs text-muted-foreground/60">{description}</p>
    </div>
  );
}

export default function LocalModelSection() {
  const { t } = useTranslation();
  const localModel = useSettingsStore((s) => s.localModel);
  const localProvider = useSettingsStore((s) => s.localProvider);
  const setLocalModel = useSettingsStore((s) => s.setLocalModel);
  const setLocalProvider = useSettingsStore((s) => s.setLocalProvider);

  const localTemperature = useSettingsStore((s) => s.localTemperature);
  const localTopP = useSettingsStore((s) => s.localTopP);
  const localTopK = useSettingsStore((s) => s.localTopK);
  const localMinP = useSettingsStore((s) => s.localMinP);
  const localRepeatPenalty = useSettingsStore((s) => s.localRepeatPenalty);
  const localMaxTokens = useSettingsStore((s) => s.localMaxTokens);
  const setLocalTemperature = useSettingsStore((s) => s.setLocalTemperature);
  const setLocalTopP = useSettingsStore((s) => s.setLocalTopP);
  const setLocalTopK = useSettingsStore((s) => s.setLocalTopK);
  const setLocalMinP = useSettingsStore((s) => s.setLocalMinP);
  const setLocalRepeatPenalty = useSettingsStore((s) => s.setLocalRepeatPenalty);
  const setLocalMaxTokens = useSettingsStore((s) => s.setLocalMaxTokens);
  const resetLocalGenerationParams = useSettingsStore((s) => s.resetLocalGenerationParams);

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

  const handleProviderChange = (providerId: string) => {
    setLocalProvider(providerId);
    // Do NOT auto-select a model — only the user clicking on a model changes the active model.
  };

  const activeModelInfo = useMemo(() => {
    if (!localModel) return null;
    for (const provider of localProviders) {
      const model = provider.models.find((m) => m.id === localModel);
      if (model) return { providerName: provider.name, modelName: model.name, modelSize: model.size };
    }
    return null;
  }, [localModel, localProviders]);

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <GpuModeSelector type="llama" />
        {activeModelInfo ? (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-green-500/10 border border-green-500/20 text-sm">
            <span className="w-2 h-2 rounded-full bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.7)] animate-[pulse-glow_2s_ease-in-out_infinite] shrink-0" />
            <span className="text-green-600 dark:text-green-400 font-medium">{activeModelInfo.modelName}</span>
            <span className="text-muted-foreground/60 text-xs">{activeModelInfo.providerName} · {activeModelInfo.modelSize}</span>
          </div>
        ) : (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-muted/40 border border-border/30 text-sm">
            <Cpu className="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" />
            <span className="text-muted-foreground/60 text-xs">No local model selected</span>
          </div>
        )}
      </div>
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

      <div className="space-y-4 rounded-lg border border-border/40 bg-muted/20 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="w-4 h-4 text-purple-500 shrink-0" />
            <div>
              <h4 className="text-sm font-semibold text-foreground">
                {t("settingsPage.llms.localModel.params.title")}
              </h4>
              <p className="text-xs text-muted-foreground/70">
                {t("settingsPage.llms.localModel.params.description")}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={resetLocalGenerationParams}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            {t("settingsPage.llms.localModel.params.reset")}
          </button>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <ParamRow
            label={t("settingsPage.llms.localModel.params.temperature.label")}
            description={t("settingsPage.llms.localModel.params.temperature.description")}
            value={localTemperature}
            min={0}
            max={2}
            step={0.05}
            onChange={setLocalTemperature}
          />
          <ParamRow
            label={t("settingsPage.llms.localModel.params.topP.label")}
            description={t("settingsPage.llms.localModel.params.topP.description")}
            value={localTopP}
            min={0}
            max={1}
            step={0.05}
            onChange={setLocalTopP}
          />
          <ParamRow
            label={t("settingsPage.llms.localModel.params.topK.label")}
            description={t("settingsPage.llms.localModel.params.topK.description")}
            value={localTopK}
            min={0}
            max={200}
            step={1}
            onChange={setLocalTopK}
          />
          <ParamRow
            label={t("settingsPage.llms.localModel.params.minP.label")}
            description={t("settingsPage.llms.localModel.params.minP.description")}
            value={localMinP}
            min={0}
            max={1}
            step={0.01}
            onChange={setLocalMinP}
          />
          <ParamRow
            label={t("settingsPage.llms.localModel.params.repeatPenalty.label")}
            description={t("settingsPage.llms.localModel.params.repeatPenalty.description")}
            value={localRepeatPenalty}
            min={1}
            max={2}
            step={0.05}
            onChange={setLocalRepeatPenalty}
          />
          <ParamRow
            label={t("settingsPage.llms.localModel.params.maxTokens.label")}
            description={t("settingsPage.llms.localModel.params.maxTokens.description")}
            value={localMaxTokens}
            min={128}
            max={8192}
            step={128}
            onChange={setLocalMaxTokens}
          />
        </div>
      </div>
    </div>
  );
}
