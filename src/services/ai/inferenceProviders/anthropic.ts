import type { InferenceProvider } from "./types";
import { wrapCleanupTranscript } from "../../../config/prompts";
import logger from "../../../utils/logger";

export const anthropicProvider: InferenceProvider = {
  id: "anthropic",
  async call({ text, model, agentName, config, ctx }) {
    if (typeof window === "undefined" || !window.electronAPI) {
      throw new Error("Anthropic reasoning is not available in this environment");
    }

    logger.logReasoning("ANTHROPIC_START", { model, agentName, environment: "browser" });
    const startTime = Date.now();

    const systemPrompt = config.systemPrompt || ctx.getSystemPrompt(agentName);
    const userContent = config.systemPrompt ? text : wrapCleanupTranscript(text);

    logger.logReasoning("ANTHROPIC_REQUEST", {
      model,
      temperature: config.temperature,
      max_tokens: config.maxTokens,
      systemPrompt,
      userContent,
    });

    const result = await window.electronAPI.processAnthropicReasoning(
      userContent,
      model,
      agentName,
      {
        ...config,
        systemPrompt,
      }
    );

    const processingTimeMs = Date.now() - startTime;

    if (!result.success) {
      logger.logReasoning("ANTHROPIC_ERROR", { model, processingTimeMs, error: result.error });
      throw new Error(result.error);
    }

    logger.logReasoning("ANTHROPIC_SUCCESS", {
      model,
      processingTimeMs,
      resultLength: result.text.length,
      responseText: result.text,
    });
    return result.text;
  },
};
