import i18n, { normalizeUiLanguage } from "../../i18n";
import { useSettingsStore } from "../../stores/settingsStore";
import { en as enPrompts } from "../../locales/prompts";
import { getLanguageInstruction } from "../../utils/languageSupport";
import { PROMPT_KINDS, type PromptKind } from "./registry";

export { PROMPT_KINDS, PROMPT_KIND_LIST, type PromptKind } from "./registry";

export interface ResolvePromptOptions {
  agentName: string | null;
  uiLanguage?: string;
  language?: string;
  customDictionary?: string[];
}

export function resolvePrompt(kind: PromptKind, opts: ResolvePromptOptions): string {
  const custom = useSettingsStore.getState().customPrompts[kind];
  const template = custom || getDefaultPromptText(kind, opts.uiLanguage);
  return applySubstitutions(template, opts);
}

export function getDefaultPromptText(kind: PromptKind, uiLanguage?: string): string {
  const def = PROMPT_KINDS[kind];
  if (!def.i18nKey) return def.fallback;
  const locale = normalizeUiLanguage(uiLanguage || "en");
  const t = i18n.getFixedT(locale, "prompts");
  return t(def.i18nKey, { defaultValue: def.fallback });
}

// The cleanup prompt tells the model its input arrives between <transcript>
// tags; the trailing line re-anchors the output contract right after the
// transcript, where models weight instructions most. Mirrors api/reason.ts
// in ektoswhispr-api.
export function wrapCleanupTranscript(text: string): string {
  return `<transcript>\n${text}\n</transcript>\n\nOutput only the cleaned transcript.`;
}

export function appendDictionarySuffix(
  prompt: string,
  customDictionary?: string[],
  uiLanguage?: string
): string {
  if (!customDictionary?.length) return prompt;
  const locale = normalizeUiLanguage(uiLanguage || "en");
  const suffix = i18n.getFixedT(locale, "prompts")("dictionarySuffix", {
    defaultValue: enPrompts.dictionarySuffix,
  });
  return prompt + suffix + customDictionary.join(", ");
}

// Mirrors appendDictionarySuffix() — appended after the dictionary suffix so
// the LLM sees dictionary hints, then screen context, in a stable order. A
// no-op when there's no screen text (feature off/gated-off/capture-or-OCR
// failed). See docs/specs/active-window-screen-context.md's "Threading OCR
// text into the LLM context" Design section.
export function appendScreenContextSuffix(
  prompt: string,
  screenText?: string | null,
  uiLanguage?: string
): string {
  if (!screenText?.trim()) return prompt;
  const locale = normalizeUiLanguage(uiLanguage || "en");
  const leadIn = i18n.getFixedT(locale, "prompts")("screenContextLeadIn", {
    defaultValue: enPrompts.screenContextLeadIn,
  });
  return `${prompt}${leadIn}\n<screen_context>\n${screenText}\n</screen_context>`;
}

function applySubstitutions(template: string, opts: ResolvePromptOptions): string {
  const name = opts.agentName?.trim() || "Assistant";
  let prompt = template.replace(/\{\{agentName\}\}/g, name);

  const langInstruction = getLanguageInstruction(opts.language);
  if (langInstruction) prompt += "\n\n" + langInstruction;

  return appendDictionarySuffix(prompt, opts.customDictionary, opts.uiLanguage);
}
