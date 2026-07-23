const test = require("node:test");
const assert = require("node:assert/strict");
const {
  computeTextCompressionRatio,
  isHallucinatedText,
  resolveDetectedLanguageCode,
  summarizeWhisperQuality,
  isWhisperSegmentLowQuality,
  summarizeParakeetQuality,
  isParakeetSegmentLowQuality,
  WHISPER_LOGPROB_FLOOR,
  WHISPER_COMPRESSION_CEIL,
  LANGUAGE_MISMATCH_PROBABILITY_FLOOR,
} = require("../../src/utils/transcriptionQualityHeuristics");

// --- computeTextCompressionRatio -------------------------------------------

test("computeTextCompressionRatio returns a low ratio for varied natural text", () => {
  const ratio = computeTextCompressionRatio(
    "The quick brown fox jumps over the lazy dog near the riverbank at dawn."
  );
  assert.ok(ratio < WHISPER_COMPRESSION_CEIL, `expected a low ratio, got ${ratio}`);
});

test("computeTextCompressionRatio returns a high ratio for a repeated-phrase string", () => {
  const repeated = "the same the same the same the same the same the same the same ".repeat(10);
  const ratio = computeTextCompressionRatio(repeated);
  assert.ok(ratio > WHISPER_COMPRESSION_CEIL, `expected a high ratio, got ${ratio}`);
});

test("computeTextCompressionRatio returns 1 for empty text", () => {
  assert.equal(computeTextCompressionRatio(""), 1);
  assert.equal(computeTextCompressionRatio(null), 1);
});

// --- isHallucinatedText (moved verbatim; existing coverage re-run) --------

test("isHallucinatedText flags known boilerplate hallucinations", () => {
  assert.equal(isHallucinatedText("Thanks for watching!", "en"), true);
  assert.equal(isHallucinatedText("Please subscribe.", "en"), true);
  assert.equal(isHallucinatedText("Subtitles by Amara.org", "en"), true);
});

test("isHallucinatedText flags musical note characters", () => {
  assert.equal(isHallucinatedText("♪ ♪ ♪", "en"), true);
});

test("isHallucinatedText flags predominantly non-latin output for a latin-script language", () => {
  assert.equal(isHallucinatedText("Привет как дела сегодня хорошо", "en"), true);
});

test("isHallucinatedText flags a repeated back-to-back phrase loop", () => {
  const words = "one two three four five six seven eight";
  assert.equal(isHallucinatedText(`${words} ${words}`, "en"), true);
});

test("isHallucinatedText returns false for normal text", () => {
  assert.equal(isHallucinatedText("Let's meet at noon tomorrow to discuss the project.", "en"), false);
});

test("isHallucinatedText returns false for empty/blank text", () => {
  assert.equal(isHallucinatedText("", "en"), false);
  assert.equal(isHallucinatedText("   ", "en"), false);
});

// --- isWhisperSegmentLowQuality --------------------------------------------

test("isWhisperSegmentLowQuality is true for empty text", () => {
  assert.equal(isWhisperSegmentLowQuality({ avgLogprob: -0.1 }, { text: "" }), true);
});

test("isWhisperSegmentLowQuality is true when avg_logprob is below the floor", () => {
  assert.equal(
    isWhisperSegmentLowQuality(
      { avgLogprob: WHISPER_LOGPROB_FLOOR - 0.5, compressionRatio: 1 },
      { text: "hello" }
    ),
    true
  );
});

test("isWhisperSegmentLowQuality is false when avg_logprob is above the floor", () => {
  assert.equal(
    isWhisperSegmentLowQuality(
      { avgLogprob: WHISPER_LOGPROB_FLOOR + 0.5, compressionRatio: 1 },
      { text: "hello" }
    ),
    false
  );
});

test("isWhisperSegmentLowQuality is true when compression_ratio is above the ceiling", () => {
  assert.equal(
    isWhisperSegmentLowQuality(
      { avgLogprob: -0.1, compressionRatio: WHISPER_COMPRESSION_CEIL + 1 },
      { text: "hello" }
    ),
    true
  );
});

test("isWhisperSegmentLowQuality is false when compression_ratio is below the ceiling", () => {
  assert.equal(
    isWhisperSegmentLowQuality(
      { avgLogprob: -0.1, compressionRatio: WHISPER_COMPRESSION_CEIL - 1 },
      { text: "hello" }
    ),
    false
  );
});

test("isWhisperSegmentLowQuality tolerates a null quality (no signal yet)", () => {
  assert.equal(isWhisperSegmentLowQuality(null, { text: "hello" }), false);
});

// --- summarizeWhisperQuality ------------------------------------------------

test("summarizeWhisperQuality computes a duration-weighted avg_logprob and max compression/no_speech", () => {
  const segments = [
    { start: 0, end: 1, avg_logprob: -0.2, compression_ratio: 1.5, no_speech_prob: 0.1 },
    { start: 1, end: 3, avg_logprob: -0.6, compression_ratio: 2.0, no_speech_prob: 0.4 },
  ];
  const quality = summarizeWhisperQuality(segments);
  // Weighted: (-0.2*1 + -0.6*2) / 3 = -1.4/3
  assert.ok(Math.abs(quality.avgLogprob - -1.4 / 3) < 1e-9);
  assert.equal(quality.compressionRatio, 2.0);
  assert.equal(quality.noSpeechProb, 0.4);
});

// --- resolveDetectedLanguageCode (docs/specs/dictation-language-mismatch-retry.md R2) ---

test("resolveDetectedLanguageCode returns the argmax code", () => {
  assert.equal(resolveDetectedLanguageCode({ en: 0.1, pt: 0.85, es: 0.05 }), "pt");
});

test("resolveDetectedLanguageCode returns undefined for a missing/empty map", () => {
  assert.equal(resolveDetectedLanguageCode({}), undefined);
  assert.equal(resolveDetectedLanguageCode(undefined), undefined);
  assert.equal(resolveDetectedLanguageCode(null), undefined);
});

// --- summarizeWhisperQuality with the new topLevel language-detection argument ---

test("summarizeWhisperQuality's second argument threads through detectedLanguageCode/detectedLanguageProbability", () => {
  const segments = [
    { start: 0, end: 1, avg_logprob: -0.2, compression_ratio: 1.5, no_speech_prob: 0.1 },
  ];
  const quality = summarizeWhisperQuality(segments, {
    detectedLanguageProbability: 0.9,
    languageProbabilities: { en: 0.9, pt: 0.05 },
  });
  assert.equal(quality.detectedLanguageCode, "en");
  assert.equal(quality.detectedLanguageProbability, 0.9);
  // Existing fields computed exactly as before.
  assert.equal(quality.avgLogprob, -0.2);
  assert.equal(quality.compressionRatio, 1.5);
});

test("summarizeWhisperQuality's existing single-argument call form stays backward compatible", () => {
  const segments = [
    { start: 0, end: 1, avg_logprob: -0.2, compression_ratio: 1.5, no_speech_prob: 0.1 },
  ];
  const quality = summarizeWhisperQuality(segments);
  assert.equal(quality.detectedLanguageCode, undefined);
  assert.equal(quality.detectedLanguageProbability, null);
  assert.equal(quality.avgLogprob, -0.2);
  assert.equal(quality.compressionRatio, 1.5);
});

// --- isWhisperSegmentLowQuality's language-mismatch check (docs/specs/dictation-language-mismatch-retry.md) ---

test("isWhisperSegmentLowQuality flags a mismatch above the confidence floor", () => {
  assert.equal(
    isWhisperSegmentLowQuality(
      {
        avgLogprob: -0.1,
        compressionRatio: 1,
        detectedLanguageCode: "pt",
        detectedLanguageProbability: 0.95,
      },
      { text: "hello" },
      ["en"]
    ),
    true
  );
});

test("isWhisperSegmentLowQuality does NOT flag a mismatch below the confidence floor (false-positive guard)", () => {
  assert.equal(
    isWhisperSegmentLowQuality(
      {
        avgLogprob: -0.1,
        compressionRatio: 1,
        detectedLanguageCode: "pt",
        detectedLanguageProbability: 0.5,
      },
      { text: "hello" },
      ["en"]
    ),
    false
  );
});

test("isWhisperSegmentLowQuality does NOT flag a matching language even at high probability (common-case guard)", () => {
  assert.equal(
    isWhisperSegmentLowQuality(
      {
        avgLogprob: -0.1,
        compressionRatio: 1,
        detectedLanguageCode: "en",
        detectedLanguageProbability: 0.99,
      },
      { text: "hello" },
      ["en"]
    ),
    false
  );
});

test("isWhisperSegmentLowQuality never applies the language-mismatch check when the accepted set is empty ('auto')", () => {
  const quality = {
    avgLogprob: -0.1,
    compressionRatio: 1,
    detectedLanguageCode: "pt",
    detectedLanguageProbability: 0.99,
  };
  assert.equal(isWhisperSegmentLowQuality(quality, { text: "hello" }, []), false);
  // 2-argument call form (no third argument at all) must also never flag it.
  assert.equal(isWhisperSegmentLowQuality(quality, { text: "hello" }), false);
});

test("isWhisperSegmentLowQuality handles a multi-language accepted set correctly", () => {
  const inSet = {
    avgLogprob: -0.1,
    compressionRatio: 1,
    detectedLanguageCode: "pt",
    detectedLanguageProbability: 0.9,
  };
  const outOfSet = {
    avgLogprob: -0.1,
    compressionRatio: 1,
    detectedLanguageCode: "fr",
    detectedLanguageProbability: 0.9,
  };
  assert.equal(isWhisperSegmentLowQuality(inSet, { text: "hello" }, ["en", "pt"]), false);
  assert.equal(isWhisperSegmentLowQuality(outOfSet, { text: "hello" }, ["en", "pt"]), true);
});

test("LANGUAGE_MISMATCH_PROBABILITY_FLOOR equals 0.8", () => {
  assert.equal(LANGUAGE_MISMATCH_PROBABILITY_FLOOR, 0.8);
});

// --- Parakeet counterparts --------------------------------------------------

test("summarizeParakeetQuality flags hallucinated text and computes a compression ratio", () => {
  const quality = summarizeParakeetQuality("Thanks for watching!", 0.05, "en");
  assert.equal(quality.hallucinated, true);
  assert.equal(quality.rms, 0.05);
  assert.ok(Number.isFinite(quality.compressionRatio));
});

test("isParakeetSegmentLowQuality is true for empty text", () => {
  assert.equal(isParakeetSegmentLowQuality({ compressionRatio: 1 }, { text: "" }), true);
});

test("isParakeetSegmentLowQuality is true when hallucinated", () => {
  assert.equal(
    isParakeetSegmentLowQuality({ compressionRatio: 1, hallucinated: true }, { text: "thanks for watching" }),
    true
  );
});

test("isParakeetSegmentLowQuality is true when the text-derived compression ratio exceeds the ceiling", () => {
  assert.equal(
    isParakeetSegmentLowQuality(
      { compressionRatio: WHISPER_COMPRESSION_CEIL + 1, hallucinated: false },
      { text: "some text" }
    ),
    true
  );
});

test("isParakeetSegmentLowQuality is false for a clean, non-repetitive result", () => {
  assert.equal(
    isParakeetSegmentLowQuality(
      { compressionRatio: 1.2, hallucinated: false },
      { text: "let's meet at noon tomorrow" }
    ),
    false
  );
});
