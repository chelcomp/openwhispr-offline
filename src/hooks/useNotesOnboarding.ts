import { useState, useCallback } from "react";
import {
  useSettingsStore,
  selectIsCloudCleanupMode,
  selectEffectiveCleanupModel,
} from "../stores/settingsStore";
import { useUsage } from "./useUsage";

interface UseNotesOnboardingReturn {
  isComplete: boolean;
  isProUser: boolean;
  isProLoading: boolean;
  isLLMConfigured: boolean;
  complete: () => void;
}

export function useNotesOnboarding(): UseNotesOnboardingReturn {
  const usage = useUsage();
  const isProUser = !!(usage?.isSubscribed || usage?.isTrial);
  const isProLoading = false;
  const useCleanupModel = useSettingsStore((s) => s.useCleanupModel);
  const effectiveModel = useSettingsStore(selectEffectiveCleanupModel);
  const isCloudCleanup = useSettingsStore(selectIsCloudCleanupMode);

  const [isComplete, setIsComplete] = useState(
    () => localStorage.getItem("notesOnboardingComplete") === "true"
  );

  const isLLMConfigured = isCloudCleanup || (useCleanupModel && !!effectiveModel);

  const complete = useCallback(() => {
    localStorage.setItem("notesOnboardingComplete", "true");
    setIsComplete(true);
  }, []);

  return { isComplete, isProUser, isProLoading, isLLMConfigured, complete };
}
