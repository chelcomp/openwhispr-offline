import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type {
  InferenceMode,
} from "../types/electron";
import { Cloud, Lock } from "lucide-react";
import { GpuModeSelector } from "./ui/GpuModeSelector";
import ApiKeyInput from "./ui/ApiKeyInput";
import ModelCardList from "./ui/ModelCardList";
import LocalModelPicker, { type LocalProvider } from "./LocalModelPicker";
import { ProviderTabs } from "./ui/ProviderTabs";
import OpenAICompatiblePanel from "./OpenAICompatiblePanel";
import { API_ENDPOINTS } from "../config/constants";
import logger from "../utils/logger";
import { REASONING_PROVIDERS } from "../models/ModelRegistry";
import { modelRegistry } from "../models/ModelRegistry";
import { getRemoteProviderIcon } from "../utils/providerIcons";
import { GetApiKeyLink } from "./ui/GetApiKeyLink";
import { useSettingsStore } from "../stores/settingsStore";

type CloudModelOption = {
  value: string;
  label: string;
  description?: string;
  descriptionKey?: string;
  icon?: string;
  ownedBy?: string;
  invertInDark?: boolean;
};

const OPENROUTER_TAB = "openrouter";
const OPENROUTER_KEYS_URL = "https://openrouter.ai/keys";

const CLOUD_PROVIDER_IDS = [
  "openai",
  "anthropic",
  "gemini",
  "groq",
  OPENROUTER_TAB,
  "custom",
];

interface ReasoningModelSelectorProps {
  reasoningModel: string;
  setReasoningModel: (model: string) => void;
  localReasoningProvider: string;
  setLocalReasoningProvider: (provider: string) => void;
  cloudReasoningBaseUrl: string;
  setCloudReasoningBaseUrl: (value: string) => void;
  customReasoningApiKey?: string;
  setCustomReasoningApiKey?: (key: string) => void;
  setReasoningMode?: (mode: InferenceMode) => void;
  mode?: "cloud" | "local";
}


export default function ReasoningModelSelector({
  reasoningModel,
  setReasoningModel,
  localReasoningProvider,
  setLocalReasoningProvider,
  cloudReasoningBaseUrl,
  setCloudReasoningBaseUrl,
  customReasoningApiKey = "",
  setCustomReasoningApiKey,
  setReasoningMode: setReasoningModeProp,
  mode,
}: ReasoningModelSelectorProps) {
  const { t } = useTranslation();
  const openaiApiKey = useSettingsStore((s) => s.openaiApiKey);
  const setOpenaiApiKey = useSettingsStore((s) => s.setOpenaiApiKey);
  const anthropicApiKey = useSettingsStore((s) => s.anthropicApiKey);
  const setAnthropicApiKey = useSettingsStore((s) => s.setAnthropicApiKey);
  const geminiApiKey = useSettingsStore((s) => s.geminiApiKey);
  const setGeminiApiKey = useSettingsStore((s) => s.setGeminiApiKey);
  const groqApiKey = useSettingsStore((s) => s.groqApiKey);
  const setGroqApiKey = useSettingsStore((s) => s.setGroqApiKey);
  const openrouterApiKey = useSettingsStore((s) => s.openrouterApiKey);
  const setOpenrouterApiKey = useSettingsStore((s) => s.setOpenrouterApiKey);
  const [selectedMode, setSelectedMode] = useState<"cloud" | "local">(mode || "cloud");
  const [selectedCloudProvider, setSelectedCloudProvider] = useState("openai");
  const [selectedLocalProvider, setSelectedLocalProvider] = useState("qwen");

  const effectiveMode = mode || selectedMode;

  const cloudProviders = CLOUD_PROVIDER_IDS.map((id) => ({
    id,
    name:
      id === "custom"
        ? t("reasoning.custom.providerName")
        : id === OPENROUTER_TAB
          ? "OpenRouter"
          : REASONING_PROVIDERS[id as keyof typeof REASONING_PROVIDERS]?.name || id,
  }));

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

  const openaiModelOptions = useMemo<CloudModelOption[]>(() => {
    const { icon, invertInDark } = getRemoteProviderIcon("openai");
    return REASONING_PROVIDERS.openai.models.map((model) => ({
      ...model,
      description: model.descriptionKey
        ? t(model.descriptionKey, { defaultValue: model.description })
        : model.description,
      icon,
      invertInDark,
    }));
  }, [t]);

  const selectedCloudModels = useMemo<CloudModelOption[]>(() => {
    if (selectedCloudProvider === "openai") return openaiModelOptions;
    if (selectedCloudProvider === "custom" || selectedCloudProvider === OPENROUTER_TAB) return [];

    const { icon: iconUrl, invertInDark } = getRemoteProviderIcon(selectedCloudProvider);

    const models =
      REASONING_PROVIDERS[selectedCloudProvider as keyof typeof REASONING_PROVIDERS]?.models;

    if (!models) return [];

    return models.map((model) => ({
      ...model,
      description: model.descriptionKey
        ? t(model.descriptionKey, { defaultValue: model.description })
        : model.description,
      icon: iconUrl,
      invertInDark,
    }));
  }, [selectedCloudProvider, openaiModelOptions, t]);

  useEffect(() => {
    const localProviderIds = localProviders.map((p) => p.id);
    if (localProviderIds.includes(localReasoningProvider)) {
      setSelectedMode("local");
      setSelectedLocalProvider(localReasoningProvider);
    } else if (CLOUD_PROVIDER_IDS.includes(localReasoningProvider)) {
      setSelectedMode("cloud");
      setSelectedCloudProvider(localReasoningProvider);
    }
  }, [localProviders, localReasoningProvider]);

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

  const selectDefaultModelForProvider = (provider: string) => {
    // Custom/OpenRouter fetch their model list dynamically — clear instead of
    // presetting so another provider's model id can't persist under this one.
    if (provider === "custom" || provider === OPENROUTER_TAB) {
      setReasoningModel("");
      return;
    }

    const providerData = REASONING_PROVIDERS[provider as keyof typeof REASONING_PROVIDERS];
    if (providerData?.models?.length > 0) {
      setReasoningModel(providerData.models[0].value);
    }
  };

  const handleModeChange = async (newMode: "cloud" | "local") => {
    setSelectedMode(newMode);
    setReasoningModeProp?.(newMode === "local" ? "local" : "providers");

    if (newMode === "cloud") {
      window.electronAPI?.llamaServerStop?.();
      setLocalReasoningProvider(selectedCloudProvider);
      selectDefaultModelForProvider(selectedCloudProvider);
    } else {
      setLocalReasoningProvider(selectedLocalProvider);
      const downloaded = await loadDownloadedModels();
      const provider = localProviders.find((p) => p.id === selectedLocalProvider);
      const models = provider?.models ?? [];
      if (models.length > 0) {
        const firstDownloaded = models.find((m) => downloaded.has(m.id));
        if (firstDownloaded) {
          setReasoningModel(firstDownloaded.id);
        } else {
          setReasoningModel("");
        }
      }
    }
  };

  const handleCloudProviderChange = (provider: string) => {
    setSelectedCloudProvider(provider);
    setLocalReasoningProvider(provider);
    selectDefaultModelForProvider(provider);
  };

  const handleLocalProviderChange = async (providerId: string) => {
    setSelectedLocalProvider(providerId);
    setLocalReasoningProvider(providerId);
    const downloaded = await loadDownloadedModels();
    const provider = localProviders.find((p) => p.id === providerId);
    const models = provider?.models ?? [];
    if (models.length > 0) {
      const firstDownloaded = models.find((m) => downloaded.has(m.id));
      if (firstDownloaded) {
        setReasoningModel(firstDownloaded.id);
      } else {
        setReasoningModel("");
      }
    }
  };

  const MODE_TABS = [
    { id: "cloud", name: t("reasoning.mode.cloud") },
    { id: "local", name: t("reasoning.mode.local") },
  ];

  const renderModeIcon = (id: string) => {
    if (id === "cloud") return <Cloud className="w-4 h-4" />;
    return <Lock className="w-4 h-4" />;
  };

  return (
    <div className="space-y-4">
      {!mode && (
        <div className="space-y-2">
          <ProviderTabs
            providers={MODE_TABS}
            selectedId={effectiveMode}
            onSelect={(id) => handleModeChange(id as "cloud" | "local")}
            renderIcon={renderModeIcon}
            colorScheme="purple"
          />
          <p className="text-xs text-muted-foreground text-center">
            {effectiveMode === "local"
              ? t("reasoning.mode.localDescription")
              : t("reasoning.mode.cloudDescription")}
          </p>
        </div>
      )}

      {effectiveMode === "cloud" && (
        <div className="space-y-2">
          <ProviderTabs
            providers={cloudProviders}
            selectedId={selectedCloudProvider}
            onSelect={handleCloudProviderChange}
            colorScheme="purple"
            wrap
          />

          <div>
            {selectedCloudProvider === OPENROUTER_TAB ? (
              <OpenAICompatiblePanel
                key={OPENROUTER_TAB}
                baseUrl={API_ENDPOINTS.OPENROUTER_BASE}
                setBaseUrl={() => {}}
                apiKey={openrouterApiKey}
                setApiKey={setOpenrouterApiKey}
                model={reasoningModel}
                setModel={setReasoningModel}
                lockedBaseUrl
                apiKeyRequired
                getKeyUrl={OPENROUTER_KEYS_URL}
              />
            ) : selectedCloudProvider === "custom" ? (
              <OpenAICompatiblePanel
                key="custom"
                baseUrl={cloudReasoningBaseUrl}
                setBaseUrl={setCloudReasoningBaseUrl}
                apiKey={customReasoningApiKey}
                setApiKey={setCustomReasoningApiKey || (() => {})}
                model={reasoningModel}
                setModel={setReasoningModel}
                defaultBaseUrl={API_ENDPOINTS.OPENAI_BASE}
              />
            ) : (
              <>
                {selectedCloudProvider === "openai" && (
                  <div className="space-y-2">
                    <div className="flex items-baseline justify-between">
                      <h4 className="font-medium text-foreground">{t("common.apiKey")}</h4>
                      <GetApiKeyLink url="https://platform.openai.com/api-keys" />
                    </div>
                    <ApiKeyInput
                      apiKey={openaiApiKey}
                      setApiKey={setOpenaiApiKey}
                      label=""
                      helpText=""
                    />
                  </div>
                )}

                {selectedCloudProvider === "anthropic" && (
                  <div className="space-y-2">
                    <div className="flex items-baseline justify-between">
                      <h4 className="font-medium text-foreground">{t("common.apiKey")}</h4>
                      <GetApiKeyLink url="https://console.anthropic.com/settings/keys" />
                    </div>
                    <ApiKeyInput
                      apiKey={anthropicApiKey}
                      setApiKey={setAnthropicApiKey}
                      label=""
                      helpText=""
                    />
                  </div>
                )}

                {selectedCloudProvider === "gemini" && (
                  <div className="space-y-2">
                    <div className="flex items-baseline justify-between">
                      <h4 className="font-medium text-foreground">{t("common.apiKey")}</h4>
                      <GetApiKeyLink url="https://aistudio.google.com/app/api-keys" />
                    </div>
                    <ApiKeyInput
                      apiKey={geminiApiKey}
                      setApiKey={setGeminiApiKey}
                      label=""
                      helpText=""
                    />
                  </div>
                )}

                {selectedCloudProvider === "groq" && (
                  <div className="space-y-2">
                    <div className="flex items-baseline justify-between">
                      <h4 className="font-medium text-foreground">{t("common.apiKey")}</h4>
                      <GetApiKeyLink url="https://console.groq.com/keys" />
                    </div>
                    <ApiKeyInput
                      apiKey={groqApiKey}
                      setApiKey={setGroqApiKey}
                      label=""
                      helpText=""
                    />
                  </div>
                )}

                <div className="pt-3 space-y-2">
                  <h4 className="text-sm font-medium text-foreground">
                    {t("reasoning.selectModel")}
                  </h4>
                  <ModelCardList
                    models={selectedCloudModels}
                    selectedModel={reasoningModel}
                    onModelSelect={setReasoningModel}
                  />
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {effectiveMode === "local" && (
        <>
          <LocalModelPicker
            providers={localProviders}
            selectedModel={reasoningModel}
            selectedProvider={selectedLocalProvider}
            onModelSelect={setReasoningModel}
            onProviderSelect={handleLocalProviderChange}
            modelType="llm"
            colorScheme="purple"
            onDownloadComplete={loadDownloadedModels}
          />
          <GpuModeSelector type="llama" />
        </>
      )}
    </div>
  );
}
