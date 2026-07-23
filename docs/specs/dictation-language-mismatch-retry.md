# Dictation Language-Mismatch Retry

## Status
Implemented

## TL;DR
- What's changing: local Dictation's progressive VAD-batching pipeline (CLAUDE.md §19)
  gains a new low-quality signal — when a VAD-closed utterance's Whisper-detected language
  doesn't match what the user has configured as acceptable, that chunk is treated the same
  as an existing low-`avg_logprob`/high-`compression_ratio` chunk: held and merged with the
  next utterance for a retranscription with more acoustic context, via the mechanism that
  already exists for exactly this purpose (`docs/specs/audio-transcription-batching.md`).
  No new retry path is introduced.
- Key decisions:
  - Root-cause fix required first: `whisper.js`'s `parseWhisperResult()` currently drops
    `detected_language`/`detected_language_probability`/`language_probabilities` from the
    whisper-server response before they ever reach the batching pipeline — this spec threads
    them through.
  - Derive the detected language as a whisper short code (`"en"`, `"pt"`, ...) via the
    **argmax of `language_probabilities`** (already short-code-keyed by whisper.cpp itself:
    `whisper_lang_str(i)`, not `whisper_lang_str_full()`) rather than hand-maintaining a
    full-name→short-code table for `detected_language`/`whisper_lang_str_full()`'s output —
    avoids a second, drift-prone lookup table for an unpinned fork.
  - New confidence floor `LANGUAGE_MISMATCH_PROBABILITY_FLOOR = 0.8` gates the check — a
    deliberately conservative starting value (see Design) so short, ambiguous VAD chunks
    don't spuriously trigger retries on genuinely-correct-language audio.
  - `preferredLanguage`'s comma-separated multi-select is parsed into an accepted-code array
    via a new `getAcceptedLanguageCodes()` helper; empty array (the `"auto"` case) means the
    mismatch check never applies — by design, there's no "accepted language" to violate.
  - Parakeet is explicitly out of scope (no native language-detection field exists in the
    vendored sherpa-onnx offline protocol — same reason it already has a different,
    text-derived confidence heuristic).
- **Non-blocking but important limitation, not a blocking question**: when a single specific
  language is selected, Whisper is *forced* to decode in that language on every retry too
  (both the per-request `language` field and, once the sibling
  `dictation-language-detection-fix` spec lands, the CLI `--language` flag) — so this signal
  cannot make a genuinely-wrong-language utterance come out correct on retry in that mode.
  Its real effect there is to raise the session's aggregate `lowQualityRatio`, which can
  trigger the *existing*, separate full-clip-fallback re-transcription. The mechanism's full
  corrective power is in **auto/multi-language mode**, where language isn't forced and more
  acoustic context can genuinely flip the detected language. This spec states that
  distinction rather than overclaiming a language auto-correct capability; see Design and
  Open Questions.
- Practical impact: a VAD-chunked dictation utterance that Whisper confidently (≥80%)
  detects as a language outside what the user selected now gets a second chance with more
  context before being pasted, exactly like any other low-confidence chunk today. No change
  to plain single-language dictation whose detected language matches, and no new latency in
  that common case.

## Problem / Goal

Local Dictation's progressive VAD-batching session (`src/helpers/dictationBatchingSession.js`,
CLAUDE.md §19) transcribes each VAD-closed utterance once via a caller-supplied `transcribe()`
callback, and defers/merges a chunk with the next utterance when a caller-supplied
`isLowQuality()` predicate flags it — bounded by `maxMerges=2`/`maxMergedMs=20000`. Today,
for Whisper, `isWhisperSegmentLowQuality()` (`src/utils/transcriptionQualityHeuristics.js`)
only inspects `avg_logprob` and `compression_ratio` from whisper.cpp's per-segment output.

whisper-server's `verbose_json` response (this app always requests `verboseJson: true` on
this path — see `src/helpers/ipcHandlers.js`'s `transcribeWhisperPreviewSegment()`) also
includes a real, independent language-detection pass, computed **even when a specific
`language` was forced** (confirmed against the vendored fork's source,
`OpenWhispr/whisper.cpp`, `examples/server/server.cpp:1058-1076`):

```
jres["language"]                     = whisper_lang_str_full(whisper_full_lang_id(ctx));   // decode language actually used
jres["detected_language"]            = whisper_lang_str_full(detected_lang_id);            // independent auto-detect pass
jres["detected_language_probability"] = lang_probs[detected_lang_id];
jres["language_probabilities"]        = { <short-code>: <prob>, ... };                     // whisper_lang_str(i), every entry >0.001
```

This app never sets whisper-server's `no_language_probabilities` flag, so this block always
runs whenever `verboseJson: true` is requested — which the dictation-batching path always
does. **This signal is currently discarded before it ever reaches the batching pipeline**:
`whisper.js`'s `parseWhisperResult()` builds its return value from only `result.text` and
(conditionally) `result.segments` — `detected_language`/`detected_language_probability`/
`language_probabilities` are never copied through, so `ipcHandlers.js`'s
`transcribeWhisperPreviewSegment()` has no way to see them today, and no language-mismatch
signal reaches `isWhisperSegmentLowQuality()`.

This spec adds that missing plumbing and a new, additional low-quality condition: when the
utterance's detected language, above a confidence floor, doesn't match what the user has
configured as acceptable (`preferredLanguage`), treat the chunk as low quality — feeding it
into the *same* existing merge-and-retry mechanism, not a new one.

**Relationship to sibling specs** (do not duplicate, this spec is additive/independent):
- `docs/specs/dictation-language-detection-fix.md` fixes the CLI `--language` startup flag
  and warm-up language plumbing for local Whisper. That spec is about the language *sent
  into* the decoder; this spec is about a *downstream quality signal* derived from what
  whisper-server reports it detected in its response, and is independent of whether that
  other fix has landed — the per-request multipart `language` field (already wired
  correctly today per that spec's Problem section) is what determines decode language
  regardless.
- `docs/specs/meeting-tinydiarize-investigation.md` — unrelated (`-tdrz`/speaker turns for
  meetings). Not touched here.
- `docs/specs/audio-transcription-batching.md` — defines the merge/retry mechanism this spec
  plugs a new signal into. Not redesigned here.

## Requirements

- **R1.** `whisper.js`'s `parseWhisperResult()` must pass through
  `detected_language_probability` and `language_probabilities` from the raw whisper-server
  JSON response onto its returned object (as `detectedLanguageProbability` and
  `languageProbabilities`, matching the file's existing camelCase convention), whenever
  present — mirroring how `segments` is already conditionally copied through. Absent fields
  (e.g. a future response shape, or `no_language_probabilities` somehow set) must not throw
  and must simply leave those keys undefined — graceful degradation, no new hard dependency.
- **R2.** `src/utils/transcriptionQualityHeuristics.js` gains:
  - `resolveDetectedLanguageCode(languageProbabilities)`: a pure helper returning the
    short-code key with the maximum probability value in the map, or `undefined` for a
    missing/empty map. No hand-maintained language table — this is the argmax of whatever
    whisper-server itself already reported, keyed in whisper's own short-code form.
  - `summarizeWhisperQuality(segments, topLevel = {})`: extended with a second, optional
    parameter carrying `{ detectedLanguageProbability, languageProbabilities }` from the
    response. The returned quality object gains `detectedLanguageCode` (via
    `resolveDetectedLanguageCode(topLevel.languageProbabilities)`) and
    `detectedLanguageProbability` (passed through if finite, else `null`). Existing
    single-argument call form (no `topLevel`) must keep working unchanged — both new fields
    resolve to `undefined`/`null` and no existing behavior changes.
  - `LANGUAGE_MISMATCH_PROBABILITY_FLOOR = 0.8`: new exported constant (see Design for
    reasoning).
  - `isWhisperSegmentLowQuality(quality, ctx, acceptedLanguageCodes = [])`: extended with a
    third, optional parameter. In addition to the two existing checks (unchanged), also
    returns `true` when **all** of: `acceptedLanguageCodes.length > 0`,
    `quality?.detectedLanguageCode` is truthy, `quality.detectedLanguageProbability` is a
    finite number `>= LANGUAGE_MISMATCH_PROBABILITY_FLOOR`, and
    `!acceptedLanguageCodes.includes(quality.detectedLanguageCode)`. When
    `acceptedLanguageCodes` is empty (the `"auto"` case, or simply omitted by an existing
    2-argument caller) this new condition can never fire — existing 2-argument callers and
    tests keep working unchanged.
  - Parakeet's `isParakeetSegmentLowQuality()` is **not** modified — explicit scoped
    exclusion (see Non-goals), not a gap.
- **R3.** `src/utils/languageSupport.ts` gains `getAcceptedLanguageCodes(language)`:
  returns `[]` for `null`/`undefined`/`""`/`"auto"`; for a comma-separated multi-select
  (e.g. `"en,pt"`) returns each entry's base code (`.split("-")[0]`, matching
  `getBaseLanguageCode()`'s existing normalization), filtering empty/`"auto"` entries; for a
  single code (`"en"` or a hyphenated regional form like `"pt-BR"`) returns a one-element
  array of its base code (`["en"]` / `["pt"]`).
- **R4.** `src/helpers/audioManager.js`'s dictation-preview start call site (the block that
  invokes `window.electronAPI.startDictationPreview({...})`) must additionally resolve
  `acceptedLanguages = getAcceptedLanguageCodes(preferredLanguage)` (from the same
  `getSettings()` read already done there for `language`/`langHint`) and include it in the
  payload.
- **R5.** `src/types/electron.ts`'s `startDictationPreview` opts type gains
  `acceptedLanguages?: string[]`.
- **R6.** `src/helpers/ipcHandlers.js`:
  - `start-dictation-preview` handler destructures `acceptedLanguages` from its payload and
    stores it in new module-scoped state `dictationPreviewAcceptedLanguages` (defaulting to
    `[]` if not an array) — reset to `[]` in `resetDictationPreviewState()`, alongside the
    existing `dictationPreviewLanguage` reset.
  - `transcribeWhisperPreviewSegment()`: both branches (segments present or the
    no-segments/plain-text fallback) must compute `quality` via `summarizeWhisperQuality()`
    including the new `topLevel` argument sourced from the transcription result's
    `detectedLanguageProbability`/`languageProbabilities` (populated by R1). Today the
    no-segments branch leaves `quality = null` entirely; this changes it to a non-null
    object carrying (at minimum) the language-detection fields when present — a narrow,
    explicitly-scoped broadening of that edge case, not a redesign of its existing
    avg_logprob/compression_ratio semantics (which remain `null` in that branch exactly as
    today, since `summarizeWhisperQuality([])` already returns `null` for both).
  - The `createDictationBatchingSession({...})` call's `isLowQuality` field, for the
    non-Parakeet branch, must pass `dictationPreviewAcceptedLanguages` through to
    `isWhisperSegmentLowQuality()` (e.g. via a small wrapping closure) rather than passing
    the bare function reference as it does today. Parakeet's branch is unchanged.

## Non-goals

- No change to the merge/retry bookkeeping itself (`maxMerges`, `maxMergedMs`,
  `tailFinalizeBudgetMs`, deferral logic) in `dictationBatchingSession.js` — this spec only
  adds a new input to an existing `isLowQuality` predicate.
- No change to Parakeet's quality heuristic (`isParakeetSegmentLowQuality`,
  `summarizeParakeetQuality`) — sherpa-onnx's offline-websocket-server protocol has no native
  language-detection field, matching the existing, documented reason it already has a
  different, text-derived confidence heuristic (CLAUDE.md §19).
- No change to Meeting/Note Recording's local-transcription chunking path
  (`ipcHandlers.js`'s meeting mic/system-audio chunk handler, or the meeting-note
  re-transcription path) — neither uses the VAD-batching session or
  `isWhisperSegmentLowQuality()` as an `isLowQuality` callback; they're a different,
  fixed-interval chunking mechanism entirely, out of scope here.
- No change to the CLI `--language` startup flag or warm-up language plumbing — that's
  `docs/specs/dictation-language-detection-fix.md`'s scope, not this one's.
- Not fixing the "forced single-language mode can't self-correct on retry" limitation
  described in the TL;DR — relaxing the per-request forced language specifically during a
  merge-retry, so a genuinely-wrong-language utterance could actually come back correct, is
  flagged as a possible follow-up in Open Questions, not designed or implemented here. The
  user's request was to reuse the existing merge/retry mechanism as-is with a new trigger,
  not to redesign what happens during a retry.
- No settings/schema/localStorage key changes, no new persisted value — Premise #6
  (Migration safety) does not apply. `acceptedLanguages` is derived fresh, in-memory, per
  dictation-preview session start; nothing is written to disk or localStorage.

## Design

### 1. `src/helpers/whisper.js` — `parseWhisperResult()`

In the existing `result.text !== undefined` branch (the one that already conditionally
copies `result.segments` onto `out` when present), additionally copy through, when present
on the raw parsed JSON:

- `result.detected_language_probability` → `out.detectedLanguageProbability`
- `result.language_probabilities` → `out.languageProbabilities`

`result.detected_language` and `result.language` (the whisper.cpp full-name strings,
`whisper_lang_str_full()`) are **not** needed and are **not** copied through — the short-code
derivation below uses `language_probabilities` instead (see rationale in §2). Copying only
happens when the source field is present, so an unexpected/older server response shape
degrades to the fields simply being absent on `out`, never throwing.

### 2. `src/utils/transcriptionQualityHeuristics.js`

**Why `language_probabilities` instead of `detected_language`/`whisper_lang_str_full()`:**
`detected_language` is a full language name string (`"english"`, `"portuguese"`, ...) —
comparing it against `preferredLanguage`'s whisper short codes (`"en"`, `"pt"`, ... — the
same codes already sent to whisper.cpp via `-l`/the per-request `language` field, per
CLAUDE.md §6 and the sibling `dictation-language-detection-fix` spec's Problem section) would
require a hand-maintained full-name↔short-code table mirroring whisper.cpp's internal
`g_lang` map — a second, drift-prone source of truth for an unpinned vendored fork.
`language_probabilities`, however, is *already* keyed by whisper's own short codes
(`whisper_lang_str(i)`, confirmed against `server.cpp:1076`, as distinct from
`detected_language`'s `whisper_lang_str_full(detected_lang_id)` at line 1070) and is
populated in the exact same conditional block as `detected_language`/
`detected_language_probability` — so its argmax entry is, by construction, the same
detection whisper-server itself reports, with no extra lookup table needed. This is the
"correct normalization" this spec adopts: use whisper's own short-code map rather than
re-deriving one.

**New helper:**

```
resolveDetectedLanguageCode(languageProbabilities)
```

Returns the key of the maximum-value entry in `languageProbabilities` (a plain object of
`{shortCode: probability}`), or `undefined` if the map is missing, not an object, or empty.
Pure, no I/O.

**`summarizeWhisperQuality(segments, topLevel = {})`** (extended signature): unchanged
avg_logprob/compression_ratio/no_speech_prob computation from `segments`; additionally sets
on the returned object:
- `detectedLanguageCode = resolveDetectedLanguageCode(topLevel.languageProbabilities)`
- `detectedLanguageProbability = Number.isFinite(topLevel.detectedLanguageProbability) ? topLevel.detectedLanguageProbability : null`

Existing call sites (this file's own tests, and any future single-argument caller) keep
working: `topLevel` defaults to `{}`, so both new fields resolve to `undefined`/`null` and no
existing check is affected.

**New constant:**

```
LANGUAGE_MISMATCH_PROBABILITY_FLOOR = 0.8
```

**Reasoning for 0.8** (a deliberate starting value, not an empirically-tuned one — same
framing this module already uses for `WHISPER_LOGPROB_FLOOR`/`WHISPER_COMPRESSION_CEIL`,
explicitly called "classic...thresholds" reused "as-is"): whisper's language-ID pass is a
99-way softmax, so even a moderately-confident top entry (e.g. 0.5) is already ~50x above
uniform chance — but per whisper.cpp's own documented behavior and community reports, LID
confidence is known to be materially less reliable on short clips, which is exactly what
individual VAD-segmented utterances tend to be (a single spoken phrase, often a few seconds).
A low floor would make the mismatch check fire on the *common, correct-language* path
whenever a short utterance's LID pass happens to wobble — directly harming the case this
spec must not regress (plain single-language dictation with a matching detected language).
Setting the floor high (0.8) biases toward **missing** some genuine mismatches rather than
**flagging** correct-language audio, since a false positive here costs an unnecessary retry
on ordinary dictation while a false negative simply leaves today's (status-quo) behavior
unchanged for that chunk. This value should be treated as tunable pending real-world
feedback, exactly like this module's other reused thresholds.

**`isWhisperSegmentLowQuality(quality, ctx, acceptedLanguageCodes = [])`** (extended
signature): existing two checks (avg_logprob floor, compression_ratio ceiling) unchanged.
New condition, ORed in:

```
if (
  acceptedLanguageCodes.length > 0 &&
  quality?.detectedLanguageCode &&
  Number.isFinite(quality.detectedLanguageProbability) &&
  quality.detectedLanguageProbability >= LANGUAGE_MISMATCH_PROBABILITY_FLOOR &&
  !acceptedLanguageCodes.includes(quality.detectedLanguageCode)
) {
  return true;
}
```

When `acceptedLanguageCodes` is `[]` — either because the caller is on `"auto"` (R3 returns
`[]` for that case) or because an existing 2-argument caller never supplies it — this branch
can never evaluate true, so behavior for every existing caller/test is unchanged.

`isParakeetSegmentLowQuality` is untouched.

### 3. `src/utils/languageSupport.ts`

New function `getAcceptedLanguageCodes(language: string | null | undefined): string[]`,
alongside the existing `getBaseLanguageCode`/`getMultiLanguagePromptHint`:

- `"auto"` / falsy / empty string → `[]` (no accepted-set constraint — matches
  `getBaseLanguageCode`'s and `getMultiLanguagePromptHint`'s existing `"auto"` short-circuit).
- Comma-separated (e.g. `"en,pt"`) → `["en", "pt"]`: split on `,`, drop empty/`"auto"`
  entries, take each entry's base code via `.split("-")[0]` (same normalization
  `getBaseLanguageCode` already applies to a single code).
- Single code (`"en"`, or a hyphenated regional form like `"pt-BR"`) → one-element array of
  its base code (`["en"]` / `["pt"]`).

This single helper naturally covers all three cases from the Problem/Goal framing: single
language → 1-element array, multi-language → 2+-element array, `"auto"` → empty array
meaning "no check."

### 4. `src/helpers/audioManager.js`

At the existing `window.electronAPI.startDictationPreview({...})` call site (the block that
already reads `getSettings()` for `preferredLanguage` and computes `language`/`langHint` via
`getBaseLanguageCode`/`getMultiLanguagePromptHint`), additionally compute
`acceptedLanguages = getAcceptedLanguageCodes(preferredLanguage)` (new import from
`../utils/languageSupport`, alongside the two already imported there) and add it to the
payload object as a new `acceptedLanguages` field.

### 5. `src/types/electron.ts`

`startDictationPreview`'s opts type gains `acceptedLanguages?: string[];`, alongside its
existing `language?: string` field. No `preload.js` change needed — its `startDictationPreview`
wrapper already forwards the entire `opts` object verbatim to the `start-dictation-preview`
IPC channel.

### 6. `src/helpers/ipcHandlers.js`

- New module-scoped state `let dictationPreviewAcceptedLanguages = [];`, declared alongside
  the existing `dictationPreviewLanguage`/`dictationPreviewInitialPrompt` state.
- `resetDictationPreviewState()`: reset `dictationPreviewAcceptedLanguages = [];` alongside
  its existing resets.
- `start-dictation-preview` handler: destructure `acceptedLanguages` from the IPC payload
  (alongside `provider`/`model`/`language`/`initialPrompt`/`showOverlay`) and set
  `dictationPreviewAcceptedLanguages = Array.isArray(acceptedLanguages) ? acceptedLanguages : [];`
  before the `createDictationBatchingSession({...})` call.
- `transcribeWhisperPreviewSegment()`: change both branches (the `allSegments.length > 0`
  branch, which already calls `summarizeWhisperQuality(kept.length ? kept : allSegments)`,
  and the `else` branch, which currently leaves `quality = null`) to call
  `summarizeWhisperQuality(segmentsArrayOrEmpty, { detectedLanguageProbability:
  result.detectedLanguageProbability, languageProbabilities: result.languageProbabilities })`
  — i.e. the `else` branch now also computes `quality` (via an empty segments array, which
  already yields `null` avg_logprob/compression_ratio, so no regression there) instead of
  leaving it `null` outright, so the language-detection fields aren't lost in that edge case
  either.
- The `createDictationBatchingSession({...})` call's `isLowQuality` option, currently
  `isNvidia ? isParakeetSegmentLowQuality : isWhisperSegmentLowQuality`, becomes
  `isNvidia ? isParakeetSegmentLowQuality : (quality, ctx) =>
  isWhisperSegmentLowQuality(quality, ctx, dictationPreviewAcceptedLanguages)` — a small
  closure capturing the session's accepted-language state, created fresh on every
  `start-dictation-preview` call (so it always reads the current session's value, never a
  stale one from a previous session).

### Non-Negotiable Product Premises compliance

- **Speed (≤500ms raw transcription budget)**: this spec touches only the existing bounded
  merge/retry path (`maxMerges=2`/`maxMergedMs=20000`, plus the existing
  `tailFinalizeBudgetMs=300ms` wall-clock cap at finalize time) — it adds a new *trigger*
  into an already-existing, already-bounded mechanism, not a new unbounded retry loop or any
  additional per-chunk latency in the common case (matching-language, high-confidence
  detection: the new condition short-circuits on the first failed check —
  `acceptedLanguageCodes.length > 0` — with negligible cost, and even when it proceeds, an
  object-key lookup and array `.includes()` call add no measurable latency). No change to
  the non-batching, no-cleanup, no-agent raw-transcript path.
- **Privacy**: no new network calls, no new data leaving the device — this is a purely local
  comparison of two already-local values (whisper-server's own response, and the user's own
  setting).
- **Performance (idle budget)**: no new listener, timer, or background process — this logic
  only runs inside an already-active dictation-preview session's existing per-chunk
  transcribe callback.
- **Migration safety**: no settings/schema/localStorage changes (see Non-goals).
- **Graceful degradation**: if `languageProbabilities`/`detectedLanguageProbability` are ever
  absent from a whisper-server response (e.g., an unexpected build, or a future server
  change), `resolveDetectedLanguageCode()` returns `undefined` and the new condition simply
  never fires — falls back to today's existing avg_logprob/compression_ratio-only behavior,
  never throws.

## Validation Plan

### Automated

- **`test/utils/transcriptionQualityHeuristics.test.js`** (extend existing file):
  - `resolveDetectedLanguageCode({ en: 0.1, pt: 0.85, es: 0.05 })` returns `"pt"` (argmax).
  - `resolveDetectedLanguageCode({})` / `resolveDetectedLanguageCode(undefined)` /
    `resolveDetectedLanguageCode(null)` all return `undefined`.
  - `summarizeWhisperQuality(segments, { detectedLanguageProbability: 0.9,
    languageProbabilities: { en: 0.9, pt: 0.05 } })` returns an object whose
    `detectedLanguageCode === "en"` and `detectedLanguageProbability === 0.9`, alongside the
    existing avg_logprob/compression_ratio fields computed exactly as before.
  - `summarizeWhisperQuality(segments)` (no second argument — existing call form) still
    returns the same avg_logprob/compression_ratio/no_speech_prob shape as today, with
    `detectedLanguageCode === undefined` and `detectedLanguageProbability === null` — proves
    the signature change is backward compatible.
  - **Mismatch, above floor, flagged low-quality**: `isWhisperSegmentLowQuality({
    avgLogprob: -0.1, compressionRatio: 1, detectedLanguageCode: "pt",
    detectedLanguageProbability: 0.95 }, { text: "hello" }, ["en"])` → `true`.
  - **Mismatch, below floor, NOT flagged (false-positive guard)**:
    `isWhisperSegmentLowQuality({ avgLogprob: -0.1, compressionRatio: 1, detectedLanguageCode:
    "pt", detectedLanguageProbability: 0.5 }, { text: "hello" }, ["en"])` → `false`.
  - **Matching language, even at high probability, NOT flagged (load-bearing common-case
    guard)**: `isWhisperSegmentLowQuality({ avgLogprob: -0.1, compressionRatio: 1,
    detectedLanguageCode: "en", detectedLanguageProbability: 0.99 }, { text: "hello" },
    ["en"])` → `false`.
  - **`"auto"` (empty accepted set) never applies the check**:
    `isWhisperSegmentLowQuality({ avgLogprob: -0.1, compressionRatio: 1, detectedLanguageCode:
    "pt", detectedLanguageProbability: 0.99 }, { text: "hello" }, [])` → `false`, and the
    2-argument call form `isWhisperSegmentLowQuality({ ...same... }, { text: "hello" })` (no
    third argument at all) also → `false`.
  - **Multi-language accepted set**: with `acceptedLanguageCodes = ["en", "pt"]`, a detected
    code of `"pt"` at `detectedLanguageProbability: 0.9` → `false` (inside the set); a
    detected code of `"fr"` at the same probability → `true` (outside the set).
  - Existing avg_logprob/compression_ratio-only tests in this file continue to pass
    unmodified — proves no regression to the two pre-existing checks.

- **New file `test/components/languageSupport.test.js`** (or, if the sibling
  `dictation-language-detection-fix` spec's own planned test file of the same name has
  already landed by the time this spec is executed, append these cases to it instead of
  creating a duplicate file — coordinate via a quick `ls`/`git log` check before writing):
  - `getAcceptedLanguageCodes("auto")` / `(null)` / `(undefined)` / `("")` → `[]`.
  - `getAcceptedLanguageCodes("en")` → `["en"]`.
  - `getAcceptedLanguageCodes("pt-BR")` → `["pt"]` (regional-code base normalization).
  - `getAcceptedLanguageCodes("en,pt")` → `["en", "pt"]`.
  - `getAcceptedLanguageCodes("en,auto")` → `["en"]` (an `"auto"` entry mixed into a
    multi-select is dropped, not treated as "no constraint").

- **New file `test/helpers/whisperParseResult.test.js`**: instantiate `new WhisperManager()`
  (constructor is side-effect-free — only allocates a `WhisperServerManager` instance,
  doesn't spawn anything) and call `.parseWhisperResult(fixture)` directly with a
  whisper-server-shaped `verbose_json` fixture object (`{ text, segments, language,
  detected_language, detected_language_probability, language_probabilities }`):
  - Asserts the returned object's `detectedLanguageProbability`/`languageProbabilities` match
    the fixture's `detected_language_probability`/`language_probabilities` (R1 — the
    plumbing fix).
  - Asserts a fixture **without** those fields (a plain `{ text, segments }` response, e.g.
    matching a non-verbose or older server shape) returns an object with both keys
    `undefined` and does not throw — graceful degradation.
  - Asserts `text`/`segments` passthrough behavior is unchanged from today (regression guard
    on the existing method).

### Manual

1. In Settings → Speech-to-Text, set Language to a single specific language (e.g. English),
   local Whisper enabled, live preview overlay on (`showTranscriptionPreview`). Dictate
   normally in English; confirm no visible change in behavior or latency — no unexpected
   merges/holds on ordinary speech.
2. With the same single-language (English) setting, dictate a short phrase clearly in a
   different language (e.g. Portuguese) mid-utterance. With `--log-level=debug`, confirm a
   merge/defer is logged for that chunk (the same debug path an existing low-`avg_logprob`
   chunk would trigger) rather than the chunk committing immediately — per the TL;DR's stated
   limitation, the final pasted text may still reflect the forced English decode; this step
   confirms the *signal fires*, not that the output language self-corrects.
3. Select 2+ languages in the multi-select language setting (e.g. English + Portuguese);
   dictate in either — confirm no spurious merges (both are "accepted", so the mismatch
   check should never fire for either).
4. Select `"auto"`; dictate in any language; confirm behavior is unchanged from before this
   spec — no language-mismatch merges are ever triggered in this mode by construction
   (`acceptedLanguages` resolves to `[]`).

### Docs

- **CLAUDE.md §19** (Dictation Progressive VAD Batching): add a short note that
  `isWhisperSegmentLowQuality`'s Whisper-only confidence signal set now also includes a
  language-mismatch check (with a link to this spec), alongside the existing
  avg_logprob/compression_ratio signals, and that Parakeet is explicitly excluded from it
  (same framing as the existing Parakeet-exclusion note already there).
- **`docs/specs/audio-transcription-batching.md`**: cross-reference this spec as the origin
  of the language-mismatch trigger, if that spec's Design section enumerates
  `isWhisperSegmentLowQuality`'s specific conditions.
- **`docs/RECREATION_SPEC.md`**: check §0 and wherever `isWhisperSegmentLowQuality`/dictation
  batching quality signals are described; update once implemented.

## Open Questions

- Should a merge-retry, when it fires specifically because of a language mismatch (as
  opposed to avg_logprob/compression_ratio), temporarily relax the forced per-request
  `language` field (e.g. fall back to `"auto"` for just that retry) so a genuinely
  wrong-language utterance in single-language mode could actually come back correct, instead
  of only ever raising the session's aggregate `lowQualityRatio`? This would give the
  mechanism real corrective power in the single-language case, not just in auto/multi-language
  mode — but it's a materially different, riskier change (it means the retry's `language`
  parameter is no longer always identical to the session's configured language, with
  knock-on effects on the whisper-server restart-guard/signature machinery from the sibling
  `dictation-language-detection-fix` spec) and wasn't requested. Flagged as a possible
  follow-up spec, not addressed here.
- Is `0.8` the right floor? No real-world telemetry exists yet on how confidently whisper's
  LID pass scores genuinely-correct-language short VAD chunks in this app's actual usage
  patterns (background noise levels, mic quality, utterance length distribution). This value
  should be revisited once the feature has shipped and real dictation sessions can be
  observed (e.g. via debug logs), rather than tuned further from source reading alone.
- Parakeet's equivalent gap (no native language-detection field) is a known, permanent
  limitation of the vendored sherpa-onnx offline-websocket-server protocol, not something a
  follow-up spec could close without a different runtime/model — noted here for completeness,
  not tracked as actionable follow-up.
