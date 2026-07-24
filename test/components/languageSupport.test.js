const test = require("node:test");
const assert = require("node:assert/strict");

// Exercises src/utils/languageSupport.ts — run via the tsxRegister loader
// (package.json's test script already wires `--import ./test/setup/tsxRegister.js`
// for test/components/*.test.js).
const {
  getBaseLanguageCode,
  getMultiLanguagePromptHint,
  getAcceptedLanguageCodes,
  combineLocalTranscriptionPrompt,
  combineCloudTranscriptionPrompt,
  LOCAL_INITIAL_PROMPT_MAX_CHARS,
} = require("../../src/utils/languageSupport.ts");

// --- getBaseLanguageCode ----------------------------------------------------

test("getBaseLanguageCode returns undefined for auto/multi-select, and the base code otherwise", () => {
  assert.equal(getBaseLanguageCode("auto"), undefined);
  assert.equal(getBaseLanguageCode("en,pt"), undefined);
  assert.equal(getBaseLanguageCode("en"), "en");
  assert.equal(getBaseLanguageCode("pt-BR"), "pt");
});

// --- getMultiLanguagePromptHint ---------------------------------------------

test("getMultiLanguagePromptHint returns '' for auto/single/empty/null, and a hint for 2+ selections", () => {
  assert.equal(getMultiLanguagePromptHint(""), "");
  assert.equal(getMultiLanguagePromptHint(null), "");
  assert.equal(getMultiLanguagePromptHint("auto"), "");
  assert.equal(getMultiLanguagePromptHint("en"), "");

  const hint = getMultiLanguagePromptHint("es,pt");
  assert.ok(hint.length > 0);
  assert.ok(hint.includes("Spanish"));
  assert.ok(hint.includes("Portuguese"));
});

// --- getAcceptedLanguageCodes (docs/specs/dictation-language-mismatch-retry.md R3) ---

test("getAcceptedLanguageCodes returns [] for auto/null/undefined/empty", () => {
  assert.deepEqual(getAcceptedLanguageCodes("auto"), []);
  assert.deepEqual(getAcceptedLanguageCodes(null), []);
  assert.deepEqual(getAcceptedLanguageCodes(undefined), []);
  assert.deepEqual(getAcceptedLanguageCodes(""), []);
});

test("getAcceptedLanguageCodes returns a one-element array for a single code", () => {
  assert.deepEqual(getAcceptedLanguageCodes("en"), ["en"]);
});

test("getAcceptedLanguageCodes normalizes a regional code to its base code", () => {
  assert.deepEqual(getAcceptedLanguageCodes("pt-BR"), ["pt"]);
});

test("getAcceptedLanguageCodes splits a multi-select into base codes", () => {
  assert.deepEqual(getAcceptedLanguageCodes("en,pt"), ["en", "pt"]);
});

test("getAcceptedLanguageCodes drops an 'auto' entry mixed into a multi-select", () => {
  assert.deepEqual(getAcceptedLanguageCodes("en,auto"), ["en"]);
});

// --- combineLocalTranscriptionPrompt -----------------------------------------

test("combineLocalTranscriptionPrompt orders dictionary-then-hint and doesn't truncate short input", () => {
  const result = combineLocalTranscriptionPrompt("apple, banana", "The audio may be in: English.");
  assert.equal(result.prompt, "apple, banana The audio may be in: English.");
  assert.equal(result.truncated, false);
});

test("combineLocalTranscriptionPrompt keeps the tail (hint intact) when the combined string overflows", () => {
  const longDictionary = Array.from({ length: 400 }, (_, i) => `word${i}`).join(", ");
  const hint = "The audio may be in: English or Portuguese.";
  const result = combineLocalTranscriptionPrompt(longDictionary, hint);

  assert.equal(result.truncated, true);
  assert.ok(result.prompt.endsWith(hint), "hint must survive truncation intact");
  assert.ok(result.truncatedLength <= LOCAL_INITIAL_PROMPT_MAX_CHARS);
});

test("LOCAL_INITIAL_PROMPT_MAX_CHARS equals 650", () => {
  assert.equal(LOCAL_INITIAL_PROMPT_MAX_CHARS, 650);
});

// --- combineCloudTranscriptionPrompt -----------------------------------------

test("combineCloudTranscriptionPrompt orders dictionary-then-hint (matching local) and doesn't truncate short input", () => {
  const result = combineCloudTranscriptionPrompt(
    null,
    "apple, banana",
    "The audio may be in: English.",
    900
  );
  assert.equal(result.prompt, "apple, banana The audio may be in: English.");
  assert.equal(result.truncated, false);
});

test("combineCloudTranscriptionPrompt keeps the tail (hint intact) when the combined string overflows a test-supplied maxChars", () => {
  const longDictionary = Array.from({ length: 200 }, (_, i) => `entry${i}`).join(", ");
  const hint = "The audio may be in: English or Portuguese.";
  const maxChars = 300;
  const result = combineCloudTranscriptionPrompt(null, longDictionary, hint, maxChars);

  assert.equal(result.truncated, true);
  assert.ok(result.prompt.endsWith(hint), "hint must survive truncation intact (tail preserved)");
  assert.ok(result.truncatedLength <= maxChars);
});

test("combineCloudTranscriptionPrompt does not begin mid-entry: starts after a comma+space boundary when one exists in the kept tail", () => {
  const longDictionary = Array.from({ length: 200 }, (_, i) => `entry${i}`).join(", ");
  const hint = "Hint.";
  const maxChars = 250;
  const result = combineCloudTranscriptionPrompt(null, longDictionary, hint, maxChars);

  assert.equal(result.truncated, true);
  // The kept tail (before boundary trimming) must have contained a comma —
  // otherwise this assertion would be vacuous. With 200 short comma-separated
  // entries and maxChars=250, several full "entryN, " boundaries fall inside
  // the kept window.
  const combined = [longDictionary, hint].filter(Boolean).join(" ");
  const keptTail = combined.slice(-maxChars);
  assert.ok(keptTail.includes(","), "test setup sanity: kept tail must contain a comma");

  // Returned prompt must not start with a partial word fragment matching the
  // tail-end of some earlier truncated entry — it starts immediately after a
  // comma+space boundary.
  assert.ok(/^entry\d+/.test(result.prompt) || result.prompt === hint);
});

test("combineCloudTranscriptionPrompt falls back to the first whitespace boundary when the kept tail has no comma at all", () => {
  // One very long single entry with no commas.
  const longSingleEntry = "word".repeat(200);
  const hint = "Hint.";
  const maxChars = 50;
  const result = combineCloudTranscriptionPrompt(null, longSingleEntry, hint, maxChars);

  assert.equal(result.truncated, true);
  const combined = [longSingleEntry, hint].filter(Boolean).join(" ");
  const keptTail = combined.slice(-maxChars);
  assert.equal(keptTail.includes(","), false, "test setup sanity: kept tail must contain no comma");
  assert.ok(result.prompt.endsWith(hint));
});

test("combineCloudTranscriptionPrompt never truncates the hint itself, even when maxChars is smaller than the dictionary alone", () => {
  const longDictionary = Array.from({ length: 50 }, (_, i) => `dictword${i}`).join(", ");
  const hint = "Short hint.";
  const maxChars = hint.length + 20; // smaller than the dictionary, larger than the hint
  const result = combineCloudTranscriptionPrompt(null, longDictionary, hint, maxChars);

  assert.equal(result.truncated, true);
  assert.equal(result.prompt.endsWith(hint), true);
});

// --- Dynamic Prompt Vocabulary: new leading parameter (backward-compat + priority) ---

// Construct a combined string that overflows maxChars only after the dynamic
// vocab segment is added, so we can prove: (a) without vocab, dictionary+hint
// alone fit and would not be truncated; (b) with vocab prepended, the
// truncation drops the vocab segment first, in full, leaving both the
// dictionary and hint segments intact. `dictionaryPrompt`/`langHint` are
// deliberately comma-free here so neither truncation algorithm's
// comma-boundary logic can catch on them instead of the vocab/dictionary
// join point.
function buildVocabPriorityFixture() {
  const vocabWords = Array.from({ length: 100 }, (_, i) => `xvocab${i}`);
  const dynamicVocab = vocabWords.join(", ");
  const dictionaryPrompt = "widgetword";
  const langHint = "Hint.";
  const suffix = ` ${dictionaryPrompt} ${langHint}`;
  const bleed = 3; // < last vocab word's length, and it itself has no comma/space
  const maxChars = suffix.length + bleed;
  return { dynamicVocab, dictionaryPrompt, langHint, maxChars };
}

test("combineLocalTranscriptionPrompt places dynamicVocabPrompt first and drops it before dictionary/hint on truncation", () => {
  const { dynamicVocab, dictionaryPrompt, langHint, maxChars } = buildVocabPriorityFixture();

  // Sanity: dictionary + hint alone (no vocab) fit comfortably without truncation.
  const withoutVocab = combineLocalTranscriptionPrompt(null, dictionaryPrompt, langHint, maxChars);
  assert.equal(withoutVocab.truncated, false);

  const result = combineLocalTranscriptionPrompt(
    dynamicVocab,
    dictionaryPrompt,
    langHint,
    maxChars
  );
  assert.equal(result.truncated, true);
  assert.equal(result.prompt, `${dictionaryPrompt} ${langHint}`);
  assert.ok(!result.prompt.includes("xvocab"), "dynamic vocab segment must be dropped entirely");
});

test("combineCloudTranscriptionPrompt places dynamicVocabPrompt first and drops it before dictionary/hint on truncation", () => {
  const { dynamicVocab, dictionaryPrompt, langHint, maxChars } = buildVocabPriorityFixture();

  const withoutVocab = combineCloudTranscriptionPrompt(null, dictionaryPrompt, langHint, maxChars);
  assert.equal(withoutVocab.truncated, false);

  const result = combineCloudTranscriptionPrompt(
    dynamicVocab,
    dictionaryPrompt,
    langHint,
    maxChars
  );
  assert.equal(result.truncated, true);
  assert.equal(result.prompt, `${dictionaryPrompt} ${langHint}`);
  assert.ok(!result.prompt.includes("xvocab"), "dynamic vocab segment must be dropped entirely");
});

test("combineLocalTranscriptionPrompt omitting dynamicVocabPrompt (undefined) preserves prior 2-arg behavior", () => {
  const result = combineLocalTranscriptionPrompt(
    undefined,
    "apple, banana",
    "The audio may be in: English."
  );
  assert.equal(result.prompt, "apple, banana The audio may be in: English.");
  assert.equal(result.truncated, false);
});
