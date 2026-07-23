import { getCleanupSystemPrompt, appendScreenContextSuffix } from "../config/prompts";
import { getSettings } from "../stores/settingsStore";
import { getDictionaryHintWords } from "../utils/snippets";

export interface ReasoningConfig {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  repeatPenalty?: number;
  contextSize?: number;
  systemPrompt?: string;
  // Threaded through from resolveReasoningRoute()'s "cleanup" branch (see
  // docs/specs/active-window-screen-context.md's "Threading OCR text into
  // the LLM context" Design section) — the agent route already appends this
  // to its own systemPrompt directly; the cleanup route has no systemPrompt
  // override slot, so getSystemPrompt() appends it here instead.
  screenContextText?: string | null;
  lanUrl?: string;
  baseUrl?: string;
  customApiKey?: string;
  provider?: string;
  disableThinking?: boolean;
}

export abstract class BaseReasoningService {
  protected isProcessing = false;

  protected getCustomDictionary(): string[] {
    return getDictionaryHintWords(getSettings());
  }

  protected getPreferredLanguage(): string {
    return getSettings().preferredLanguage || "auto";
  }

  protected getUiLanguage(): string {
    return getSettings().uiLanguage || "en";
  }

  protected getSystemPrompt(agentName: string | null, screenContextText?: string | null): string {
    const base = getCleanupSystemPrompt(
      agentName,
      this.getCustomDictionary(),
      this.getPreferredLanguage(),
      this.getUiLanguage()
    );
    return appendScreenContextSuffix(base, screenContextText, this.getUiLanguage());
  }

  protected calculateMaxTokens(
    textLength: number,
    minTokens = 100,
    maxTokens = 2048,
    multiplier = 2
  ): number {
    return Math.max(minTokens, Math.min(textLength * multiplier, maxTokens));
  }

  abstract isAvailable(): Promise<boolean>;

  abstract processText(
    text: string,
    modelId: string,
    agentName?: string | null,
    config?: ReasoningConfig
  ): Promise<string>;
}
