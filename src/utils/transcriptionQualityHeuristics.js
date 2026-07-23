// Shared, engine-agnostic transcription-quality heuristics for the dictation
// progressive-batching pipeline (see docs/specs/audio-transcription-batching.md
// Design §2/§3). Consolidates logic that used to be either inlined in
// ipcHandlers.js (summarizeWhisperQuality, isWhisperSegmentLowQuality, the
// NO_SPEECH_THRESHOLD segment filter) or living on WhisperManager
// (isHallucinatedText, itself already pure text logic despite its home).
//
// No Electron/I/O dependency — pure functions over strings/numbers, matching
// the existing precedent (dictationRouting.js) and trivially unit-testable
// with `node --test`.

const zlib = require("zlib");

// Classic Whisper decode-failure thresholds (logprob_threshold=-1.0,
// compression_ratio_threshold=2.4). Reused as-is for Parakeet's text-derived
// heuristic (Design §3) — the compression-ratio metric is purely textual, not
// decoder-internal, so it transfers mechanically even though it was originally
// tuned for whisper.cpp's decode-failure behavior.
const WHISPER_LOGPROB_FLOOR = -1.0;
const WHISPER_COMPRESSION_CEIL = 2.4;
// Segment filter threshold shared by both engines' preview/summarize paths.
const NO_SPEECH_THRESHOLD = 0.6;

// docs/specs/dictation-language-mismatch-retry.md: confidence floor gating the
// language-mismatch low-quality check. Deliberately conservative (whisper's
// language-ID pass is known to be less reliable on short clips, which is
// exactly what individual VAD-segmented utterances tend to be) — biases
// toward missing genuine mismatches rather than flagging correct-language
// audio. A starting value, not empirically tuned, same framing as
// WHISPER_LOGPROB_FLOOR/WHISPER_COMPRESSION_CEIL above.
const LANGUAGE_MISMATCH_PROBABILITY_FLOOR = 0.8;

// The same zlib-deflate-based compression ratio whisper.cpp itself computes
// for `compression_ratio` — a purely textual metric (raw length / compressed
// length), so it applies identically to any engine's output text. Empty text
// returns 1 (no compression benefit, i.e. not suspiciously repetitive).
function computeTextCompressionRatio(text) {
  const normalized = String(text || "");
  if (!normalized.length) return 1;
  const rawBytes = Buffer.byteLength(normalized, "utf8");
  const compressedBytes = zlib.deflateSync(Buffer.from(normalized, "utf8")).length;
  if (compressedBytes <= 0) return 1;
  return rawBytes / compressedBytes;
}

// Detect known transcription-hallucination patterns — returns true if the
// text should be discarded. Moved here verbatim from WhisperManager
// (whisper.js), which now delegates to this implementation so every existing
// call site keeps working unchanged.
function isHallucinatedText(text, language) {
  if (!text || !text.trim()) return false;

  // Musical note characters — whisper hallucinates these on music/noise
  if (/[♪♫♩♬]/.test(text)) return true;

  // Known boilerplate hallucinations whisper emits on silence/noise
  const KNOWN_HALLUCINATIONS = [
    /^[\s.,!?]*thanks? for watching[\s.,!?]*$/i,
    /^[\s.,!?]*thank you[\s.,!?]*$/i,
    /^[\s.,!?]*please subscribe[\s.,!?]*$/i,
    /^[\s.,!?]*subtitles by[\s.,!?]*/i,
    /^[\s.,!?]*transcribed by[\s.,!?]*/i,
    /^[\s.,!?]*www\./i,
  ];
  if (KNOWN_HALLUCINATIONS.some((re) => re.test(text.trim()))) return true;

  // When a latin-script language is selected, reject text that is
  // predominantly non-latin. Greek/Cyrillic/Arabic output on a pt-BR or
  // en-US session is always a hallucination.
  const LATIN_SCRIPT_LANGUAGES = new Set([
    "af",
    "sq",
    "az",
    "bs",
    "ca",
    "cs",
    "cy",
    "da",
    "de",
    "en",
    "eo",
    "es",
    "et",
    "eu",
    "fi",
    "fr",
    "gl",
    "hr",
    "hu",
    "id",
    "is",
    "it",
    "lt",
    "lv",
    "mk",
    "ms",
    "mt",
    "nl",
    "no",
    "pl",
    "pt",
    "ro",
    "sk",
    "sl",
    "sq",
    "sr",
    "sv",
    "sw",
    "tl",
    "tr",
    "uz",
    "vi",
  ]);
  const baseLang = language ? language.split("-")[0].toLowerCase() : null;
  if (baseLang && LATIN_SCRIPT_LANGUAGES.has(baseLang)) {
    const stripped = text.replace(/\s/g, "");
    if (stripped.length > 0) {
      // Count characters outside the Latin Extended-B range (U+0000–U+024F)
      const nonLatin = (stripped.match(/[^ -ɏ]/g) || []).length;
      if (nonLatin / stripped.length > 0.3) return true;
    }
  }

  // Repetition loop: whisper sometimes emits the same phrase back-to-back
  const words = text.trim().split(/\s+/);
  if (words.length >= 8) {
    const half = Math.floor(words.length / 2);
    if (words.slice(0, half).join(" ") === words.slice(half, half * 2).join(" ")) return true;
  }

  return false;
}

// docs/specs/dictation-language-mismatch-retry.md: argmax of whisper-server's
// own `language_probabilities` map (already short-code-keyed by whisper.cpp
// itself — `whisper_lang_str(i)`, not `whisper_lang_str_full()`) — no
// hand-maintained full-name<->short-code lookup table needed. Returns
// undefined for a missing/non-object/empty map. Pure, no I/O.
function resolveDetectedLanguageCode(languageProbabilities) {
  if (!languageProbabilities || typeof languageProbabilities !== "object") return undefined;
  let bestCode;
  let bestProb = -Infinity;
  for (const [code, prob] of Object.entries(languageProbabilities)) {
    if (Number.isFinite(prob) && prob > bestProb) {
      bestProb = prob;
      bestCode = code;
    }
  }
  return bestCode;
}

// Aggregate whisper's per-segment confidence proxies into one quality view.
// Fields degrade gracefully — whatever this whisper-server build doesn't
// populate (avg_logprob / compression_ratio) is left null and simply ignored
// by the low-quality predicate below. Moved verbatim from its previous inline
// definition in ipcHandlers.js. `topLevel` (docs/specs/dictation-language-
// mismatch-retry.md R2) is an optional second parameter carrying
// { detectedLanguageProbability, languageProbabilities } from the raw
// whisper-server response — existing single-argument call sites keep working
// unchanged (both new fields resolve to undefined/null).
function summarizeWhisperQuality(segments, topLevel = {}) {
  let durSum = 0;
  let logprobWeighted = 0;
  let maxComp = 0;
  let maxNoSpeech = 0;
  let haveLogprob = false;
  let haveComp = false;
  for (const s of segments) {
    const dur = Math.max(0, (Number(s.end) || 0) - (Number(s.start) || 0)) || 1;
    if (Number.isFinite(s.avg_logprob)) {
      logprobWeighted += s.avg_logprob * dur;
      durSum += dur;
      haveLogprob = true;
    }
    if (Number.isFinite(s.compression_ratio)) {
      maxComp = Math.max(maxComp, s.compression_ratio);
      haveComp = true;
    }
    if (Number.isFinite(s.no_speech_prob)) maxNoSpeech = Math.max(maxNoSpeech, s.no_speech_prob);
  }
  return {
    avgLogprob: haveLogprob && durSum > 0 ? logprobWeighted / durSum : null,
    compressionRatio: haveComp ? maxComp : null,
    noSpeechProb: maxNoSpeech,
    detectedLanguageCode: resolveDetectedLanguageCode(topLevel.languageProbabilities),
    detectedLanguageProbability: Number.isFinite(topLevel.detectedLanguageProbability)
      ? topLevel.detectedLanguageProbability
      : null,
  };
}

// Moved verbatim from its previous inline definition in ipcHandlers.js.
// `acceptedLanguageCodes` (docs/specs/dictation-language-mismatch-retry.md R2)
// is an optional third parameter; existing 2-argument callers/tests keep
// working unchanged since the new condition can never fire on an empty array.
function isWhisperSegmentLowQuality(quality, ctx, acceptedLanguageCodes = []) {
  if (!ctx?.text) return true;
  if (!quality) return false;
  if (Number.isFinite(quality.avgLogprob) && quality.avgLogprob < WHISPER_LOGPROB_FLOOR) {
    return true;
  }
  if (
    Number.isFinite(quality.compressionRatio) &&
    quality.compressionRatio > WHISPER_COMPRESSION_CEIL
  ) {
    return true;
  }
  if (
    acceptedLanguageCodes.length > 0 &&
    quality?.detectedLanguageCode &&
    Number.isFinite(quality.detectedLanguageProbability) &&
    quality.detectedLanguageProbability >= LANGUAGE_MISMATCH_PROBABILITY_FLOOR &&
    !acceptedLanguageCodes.includes(quality.detectedLanguageCode)
  ) {
    return true;
  }
  return false;
}

// Parakeet (offline-runtime) has no native confidence/log-probability field in
// the vendored sherpa-onnx offline-websocket-server JSON protocol (confirmed:
// parseOfflineMessage() only ever reads `text` — see Design §2). This is the
// Parakeet-side counterpart of summarizeWhisperQuality, built from a
// text-derived compression ratio, the shared hallucination detector, and the
// RMS of the chunk that produced this text (silence gate) — a deliberate,
// flagged deviation from the Whisper-native ideal, not a silent substitution.
function summarizeParakeetQuality(rawText, rmsForChunk, language) {
  const text = String(rawText || "").trim();
  return {
    compressionRatio: computeTextCompressionRatio(text),
    rms: Number.isFinite(rmsForChunk) ? rmsForChunk : null,
    hallucinated: isHallucinatedText(text, language),
  };
}

// Low-quality when: ctx.text is empty; or the text was flagged as a
// hallucination; or its text-derived compression ratio exceeds the same
// 2.4 ceiling reused from Whisper (see module doc comment for why this
// starting value is adopted rather than left blocking).
function isParakeetSegmentLowQuality(quality, ctx) {
  if (!ctx?.text) return true;
  if (!quality) return false;
  if (quality.hallucinated) return true;
  if (
    Number.isFinite(quality.compressionRatio) &&
    quality.compressionRatio > WHISPER_COMPRESSION_CEIL
  ) {
    return true;
  }
  return false;
}

module.exports = {
  WHISPER_LOGPROB_FLOOR,
  WHISPER_COMPRESSION_CEIL,
  NO_SPEECH_THRESHOLD,
  LANGUAGE_MISMATCH_PROBABILITY_FLOOR,
  computeTextCompressionRatio,
  isHallucinatedText,
  resolveDetectedLanguageCode,
  summarizeWhisperQuality,
  isWhisperSegmentLowQuality,
  summarizeParakeetQuality,
  isParakeetSegmentLowQuality,
};
