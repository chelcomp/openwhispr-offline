// Map a reasoning cloud routing to the InferenceMode its Settings tab selects on.
export function deriveReasoningMode(cloudMode, provider) {
  if (cloudMode === "byok") {
    return provider === "custom" ? "self-hosted" : "providers";
  }
  return "providers";
}

// Fan a cleanup config out to all four LLM scopes.
export function buildReasoningScopePatches(settings, mode) {
  const dictationCleanup = { ...settings, cleanupMode: mode };
  const routing = {
    ...(settings.cleanupProvider !== undefined ? { provider: settings.cleanupProvider } : {}),
    ...(settings.cleanupModel !== undefined ? { model: settings.cleanupModel } : {}),
    ...(settings.cleanupCloudMode !== undefined ? { cloudMode: settings.cleanupCloudMode } : {}),
  };
  return {
    dictationCleanup,
    noteFormatting: { mode, ...routing },
    dictationAgent: { mode, ...routing },
    chatIntelligence: { mode, ...routing },
  };
}
