import registry from "../config/languageRegistry.json";

function buildLanguageSet(key: "whisper" | "assemblyai"): Set<string> {
  const set = new Set<string>();
  for (const lang of registry.languages) {
    if (lang[key]) {
      set.add(lang.code);
      const base = lang.code.split("-")[0];
      if (base !== lang.code) set.add(base);
    }
  }
  return set;
}

const WHISPER_LANGUAGES = buildLanguageSet("whisper");
const ASSEMBLYAI_UNIVERSAL3_PRO_LANGUAGES = buildLanguageSet("assemblyai");

const LANGUAGE_INSTRUCTIONS: Record<string, string> = Object.fromEntries(
  registry.languages
    .filter(
      (l): l is typeof l & { instruction: string } =>
        "instruction" in l && typeof l.instruction === "string"
    )
    .map((l) => [l.code, l.instruction])
);

export function getBaseLanguageCode(language: string | null | undefined): string | undefined {
  if (!language || language === "auto") return undefined;
  // Multi-language: comma-separated → auto-detect
  if (language.includes(",")) return undefined;
  return language.split("-")[0];
}

/**
 * When multiple languages are selected, returns a prompt hint like
 * "The audio may be in: English or Portuguese."
 * Returns empty string for single/auto selection.
 */
export function getMultiLanguagePromptHint(language: string | null | undefined): string {
  if (!language || language === "auto") return "";
  const codes = language.split(",").filter((c) => c && c !== "auto");
  if (codes.length <= 1) return "";
  const labels = codes
    .map((code) => {
      const entry = registry.languages.find((l) => l.code === code.split("-")[0]);
      return entry ? entry.label : code;
    })
    .filter(Boolean);
  return `The audio may be in: ${labels.join(" or ")}.`;
}

// whisper.cpp's real prompt-context ceiling is small:
// max_prompt_ctx = min(n_max_text_ctx, n_text_ctx/2) (src/whisper.cpp:6927).
// This app's bundled models all use the standard n_text_ctx = 448, giving
// max_prompt_ctx = 224. With carry_initial_prompt enabled (R13 of
// docs/specs/dictation-language-detection-fix.md), max_tokens =
// max_prompt_ctx - 1 = 223 tokens are actually available for the prompt. At a
// conservative ~3 chars/token (below the ~4 chars/token typical for English,
// to leave headroom for non-Latin scripts and dictionary jargon, which often
// tokenize less efficiently), that's ≈669 characters; rounded down for
// margin to 650. This is an explicitly acknowledged char-based approximation
// of a token-based limit — erring toward truncating a little early rather
// than risking overflow — not an exact conversion.
export const LOCAL_INITIAL_PROMPT_MAX_CHARS = 650;

export interface CombinedTranscriptionPrompt {
  prompt: string;
  truncated: boolean;
  originalLength: number;
  truncatedLength: number;
}

/**
 * Combines the dynamic-vocabulary prompt (docs/specs/dynamic-prompt-vocabulary.md),
 * the custom-dictionary prompt, and the multi-language hint for local
 * (whisper.cpp) transcription, in vocab-then-dictionary-then-hint order (hint
 * last). whisper.cpp's own prompt handling drops content from the front as
 * the prompt overflows its token window, so the hint — short and
 * specifically relevant to the language-detection bug this exists to fix —
 * must sit at the end, where it's safest, and the lower-confidence dynamic
 * vocabulary segment is dropped first. `dynamicVocabPrompt` is optional —
 * omitting it (undefined/null/empty) preserves prior behavior exactly. If
 * the combined string exceeds `maxChars`, keeps the last `maxChars`
 * characters, then trims forward to the next word boundary so the retained
 * text doesn't begin mid-word.
 */
export function combineLocalTranscriptionPrompt(
  dynamicVocabPrompt: string | null | undefined,
  dictionaryPrompt: string | null | undefined,
  langHint: string | null | undefined,
  maxChars: number = LOCAL_INITIAL_PROMPT_MAX_CHARS
): CombinedTranscriptionPrompt {
  const combined = [dynamicVocabPrompt, dictionaryPrompt, langHint].filter(Boolean).join(" ");
  const originalLength = combined.length;

  if (originalLength <= maxChars) {
    return { prompt: combined, truncated: false, originalLength, truncatedLength: originalLength };
  }

  let kept = combined.slice(-maxChars);
  // Trim forward to the next word boundary so the retained text doesn't
  // begin mid-word.
  const firstSpace = kept.indexOf(" ");
  if (firstSpace >= 0 && firstSpace < kept.length - 1) {
    kept = kept.slice(firstSpace + 1);
  }

  return { prompt: kept, truncated: true, originalLength, truncatedLength: kept.length };
}

/**
 * Combines the dynamic-vocabulary prompt, the custom-dictionary prompt, and
 * the multi-language hint for cloud (OpenAI/Groq/self-hosted "custom")
 * transcription. `dynamicVocabPrompt` is optional — omitting it preserves
 * prior behavior exactly. Shares combineLocalTranscriptionPrompt()'s order
 * (vocab, dictionary, then hint) and keep-tail truncation direction — both OpenAI's and Groq's documented
 * behavior keep the final ~224 tokens of an over-length prompt and drop the
 * front, the same direction and ceiling already source-verified for the
 * bundled whisper.cpp fork. See docs/specs/dictation-language-detection-fix.md
 * R12 for the full rationale. If the combined string exceeds `maxChars`,
 * keeps the last `maxChars` characters, then finds the first comma inside
 * that kept tail and drops everything up to and including it (plus a
 * leading-space trim) so the retained text starts at a clean
 * dictionary-entry boundary rather than mid-entry. Falls back to trimming at
 * the first whitespace character if the kept tail contains no comma at all.
 */
export function combineCloudTranscriptionPrompt(
  dynamicVocabPrompt: string | null | undefined,
  dictionaryPrompt: string | null | undefined,
  langHint: string | null | undefined,
  maxChars: number
): CombinedTranscriptionPrompt {
  const combined = [dynamicVocabPrompt, dictionaryPrompt, langHint].filter(Boolean).join(" ");
  const originalLength = combined.length;

  if (originalLength <= maxChars) {
    return { prompt: combined, truncated: false, originalLength, truncatedLength: originalLength };
  }

  const kept = combined.slice(-maxChars);
  const firstComma = kept.indexOf(",");
  let trimmed: string;
  if (firstComma >= 0 && firstComma < kept.length - 1) {
    trimmed = kept.slice(firstComma + 1).replace(/^\s+/, "");
  } else {
    const firstSpace = kept.indexOf(" ");
    trimmed = firstSpace >= 0 && firstSpace < kept.length - 1 ? kept.slice(firstSpace + 1) : kept;
  }

  return { prompt: trimmed, truncated: true, originalLength, truncatedLength: trimmed.length };
}

/**
 * Parses `preferredLanguage`'s comma-separated multi-select into an
 * accepted-code array, for the language-mismatch retry check (see
 * docs/specs/dictation-language-mismatch-retry.md R3). Returns `[]` for the
 * "auto" case — no accepted-set constraint, matching
 * getBaseLanguageCode()'s/getMultiLanguagePromptHint()'s existing "auto"
 * short-circuit.
 */
export function getAcceptedLanguageCodes(language: string | null | undefined): string[] {
  if (!language || language === "auto") return [];
  return language
    .split(",")
    .map((code) => code.trim())
    .filter((code) => code && code !== "auto")
    .map((code) => code.split("-")[0]);
}

export function getLanguageInstruction(language: string | undefined): string {
  if (!language) return "";
  return LANGUAGE_INSTRUCTIONS[language] || buildGenericInstruction(language);
}

function buildGenericInstruction(langCode: string): string {
  const template = registry._genericTemplate || "";
  return template.replace("{{code}}", langCode);
}

export { WHISPER_LANGUAGES, ASSEMBLYAI_UNIVERSAL3_PRO_LANGUAGES };
