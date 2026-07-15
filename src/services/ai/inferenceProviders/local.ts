import type { InferenceProvider } from "./types";
import { wrapCleanupTranscript } from "../../../config/prompts";
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

    logger.logReasoning("LOCAL_REQUEST", {
      model,
      temperature: config.temperature,
      max_tokens: config.maxTokens,
      systemPrompt,
      userContent,
    });

    const result = await window.electronAPI.processLocalReasoning(userContent, model, agentName, {
      ...config,
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
