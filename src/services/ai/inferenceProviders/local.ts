import type { InferenceProvider } from "./types";
import { wrapCleanupTranscript } from "../../../config/prompts";
import { getLocalGenerationParams } from "../../../stores/settingsStore";
import logger from "../../../utils/logger";

export const localProvider: InferenceProvider = {
  id: "local",
  async call({ text, model, agentName, config, ctx }) {
    if (typeof window === "undefined" || !window.electronAPI) {
      throw new Error("Local reasoning is not available in this environment");
    }

    logger.logReasoning("LOCAL_START", { model, agentName, environment: "browser" });
    const startTime = Date.now();

    const systemPrompt = config.systemPrompt || ctx.getSystemPrompt(agentName);
    const userContent = config.systemPrompt ? text : wrapCleanupTranscript(text);

    // Honor the user's manual sampling parameters (Local Model settings) on
    // every local inference, regardless of which local model is selected.
    const lp = getLocalGenerationParams();

    logger.logReasoning("LOCAL_REQUEST", {
      model,
      temperature: lp.temperature,
      max_tokens: lp.maxTokens,
      top_p: lp.topP,
      top_k: lp.topK,
      min_p: lp.minP,
      repeat_penalty: lp.repeatPenalty,
      systemPrompt,
      userContent,
    });

    const result = await window.electronAPI.processLocalReasoning(userContent, model, agentName, {
      ...config,
      temperature: lp.temperature,
      maxTokens: lp.maxTokens,
      topP: lp.topP,
      topK: lp.topK,
      minP: lp.minP,
      repeatPenalty: lp.repeatPenalty,
      systemPrompt,
    });

    const processingTimeMs = Date.now() - startTime;

    if (!result.success) {
      logger.logReasoning("LOCAL_ERROR", { model, processingTimeMs, error: result.error });
      throw new Error(result.error);
    }

    logger.logReasoning("LOCAL_SUCCESS", {
      model,
      processingTimeMs,
      resultLength: result.text.length,
      responseText: result.text,
    });
    return result.text;
  },
};
