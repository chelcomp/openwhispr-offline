# Dynamic Prompt Vocabulary (Session-Aware Whisper Prompt Enrichment)

## Status
Implemented

## TL;DR
Add a second, *automatic* source of Whisper prompt words alongside the existing static
Custom Dictionary: a ranked list of "currently relevant" vocabulary mined from recent
transcription history (raw + cleaned text) and, only when the user has explicitly opted in,
OCR'd screen-context text — scored by frequency, filtered for stopwords/filler/stray
symbols, and merged into the existing `initialPrompt` pipeline.

- What's changing: `combineLocalTranscriptionPrompt()`/`combineCloudTranscriptionPrompt()`
  gain a third input segment (dynamic vocab), positioned **first** (dropped first on
  truncation) — static dictionary words and the language hint keep their current relative
  order and truncation-survival priority unchanged.
- Concrete decisions:
  - "Session" = the last N (default 20, configurable) non-discarded rows from
    `getTranscriptions()`, using existing `text`/`raw_text` columns — no schema change.
  - Screen-context mining uses the existing `screen_context_text` column — same rows, no
    new query.
  - New pure scoring module reuses `correctionLearner.js`'s Unicode-aware tokenizer;
    frequency-ranks tokens, drops stopwords/fillers/symbols/short tokens, caps the output
    list, joins to a comma-separated string like the dictionary prompt.
  - Computed once per warmup (hotkey-down), cached for that session — never a background
    poll, keeping idle CPU/RAM at zero.
- **Decision (resolved)**: OCR-derived (`screen_context_text`) vocabulary mining is gated
  behind its own separate, explicit settings toggle,
  `dynamicPromptVocabularyIncludeScreenContext`, defaulting **OFF**. It applies regardless of
  local vs. cloud transcription provider (no local-transcription-only restriction) — the user
  must explicitly opt in before any screen-context text is mined for prompt vocabulary at all.
  This is independent of `dynamicPromptVocabularyEnabled` (default ON), which governs only the
  transcript-derived sources (R1a/R1b). See Design → "Privacy: OCR-derived vocabulary."
- **Decision (this revision) — acronym filter fix**: original R3a dropped all tokens <3
  chars, silently destroying short acronyms ("API", "SQL", "AWS", "K8s"). Fixed: tokens whose
  original casing is fully uppercase/uppercase+digits survive starting at 2 chars; ordinary
  lowercase tokens (and 2-letter fillers like "uh"/"um") keep the 3+ char floor and stopword
  filtering as before.
- **Decision (this revision) — persistent recency-weighted stats**, agreed with the project
  owner: new `vocabulary_stats` table (`word`, `count`, `last_seen_at`) accumulates across the
  app's entire lifetime, not just the last-20-rows session window. Scoring blends a
  recency-decayed long-term signal with the existing session score, so consistently-used
  vocabulary surfaces even when not said in the last 20 dictations, without outranking what's
  actively relevant right now.
- **Decision (descoped) — in-memory semantic grouping (R11) dropped entirely**: an earlier
  revision of this spec proposed merging near-duplicate word variants (e.g.
  "deploy"/"deployment") via cosine similarity over embeddings from the ONNX utility process.
  This was never shippable: `src/workers/onnxWorker.js` does not expose a generic text-embedding
  request handler in production, so the feature would have silently no-op'd (via its own
  graceful-degradation fallback) on every real install. Rather than ship dead code behind a
  flag that's never turned on, R11 and its `groupSimilarVocabulary()` implementation have been
  removed from scope entirely — not shipped, not deferred behind a toggle. Near-duplicate word
  variants are simply scored/output as separate entries in v1; revisit only if a real
  text-embedding request type is added to `onnxWorker.js` for another feature first.
- Practical impact: transcription accuracy improves for proper nouns/jargon the user has
  recently said or that appear on their screen, without the user manually maintaining a
  dictionary entry for every project name, teammate, or app they use that week — and this now
  extends to vocabulary the user has used consistently over a long period (not just their last
  20 dictations). Short acronyms like "API"/"K8s" are no longer silently dropped. Near-duplicate
  word variants (e.g. "deploy"/"deployment") are not merged — this is out of scope for v1.

## Problem / Goal

The Custom Dictionary (CLAUDE.md §13) is static and user-curated — accurate but requires
manual upkeep. Meanwhile the app already collects, per turn: the raw transcript, the
cleaned/final transcript, and (opt-in, Windows-only) OCR'd screen-context text (§20),
persisted per-row in the `transcriptions` table. None of this is fed back into the Whisper
prompt. Users dictating in a consistent domain (a specific codebase, a recurring meeting,
a specific app's UI) re-mishear the same proper nouns/jargon repeatedly, and the existing
per-word auto-learn pipeline (`autoLearnDictionary.js`) only catches words the user
*manually corrects post-paste* — it does nothing for words never mistranscribed badly
enough to notice, or words that appear on screen but were never yet said aloud.

Goal: derive a short, high-signal, automatically-refreshed vocabulary list from recent
session data and feed it into the same `initialPrompt` Whisper already consumes, without
requiring any user action, while respecting the app's speed and privacy premises.

## Requirements

1. **Data sources mined** (pure functions, no IPC/Electron dependency):
   - R1a. Raw transcript text (`raw_text` column) from the last N history rows.
   - R1b. Cleaned/final transcript text (`text` column) from the same rows.
   - R1c. OCR'd screen-context text (`screen_context_text` column) from the same rows —
     **gated behind a new, default-OFF setting** (see R7/Design privacy discussion).
   - R1d. The current in-progress session's own just-completed dictation(s) are included as
     soon as they're persisted (i.e., the next dictation in the same session benefits from
     the previous one's words) — no separate "live buffer," reuses the same history query.
2. **"Session" definition**: the last `N` non-discarded, non-deleted rows returned by
   `DatabaseManager.getTranscriptions(N, { includeDiscarded: false })`, ordered most-recent
   first (existing `ORDER BY timestamp DESC`). `N` defaults to 20 and is not user-configurable
   in the initial version (avoids a settings-UI dependency merely to prove the concept) —
   revisit if validation shows a different N is clearly better.
3. **Tokenization & filtering**: reuse `correctionLearner.js`'s `tokenize()` (Unicode-aware,
   strips leading/trailing punctuation) as the base tokenizer. On top of that:
   - R3a. Drop tokens shorter than 3 characters (mirrors the dictionary auto-learn's own
     `correctedWord.length < 3` floor) — **with an acronym exception**: a token whose
     *original, pre-case-folding* text matches `/^[A-Z0-9]+$/` (fully uppercase, or
     uppercase+digits — e.g. "API", "SQL", "AWS", "ID", "UI", "GPT4"; note plain
     `/^[A-Z0-9]+$/` does not match mixed-case forms like "K8s" — see the worked note below)
     survives starting at **2 characters** instead of 3, since all-caps casing in
     transcribed/OCR'd text is a strong signal of an intentional acronym/technical term
     rather than a random short filler word. The casing check must run against the token's
     original casing captured *before* the case-folding step used for frequency counting
     (R3e) — never re-derive it from the folded/lowercased form. Ordinary lowercase tokens
     (including 2-letter filler like "uh"/"um") are unaffected and still fall to the R3c
     stopword filter, which continues to drop them — the acronym exception only changes the
     *length* floor, not the stopword list. Worked note: mixed-case tokens like "K8s" don't
     match a strict `/^[A-Z0-9]+$/` test; the implementation must apply the exception check
     using a rule that also accepts a leading uppercase run mixed with digits (e.g.
     `/^[A-Z][A-Z0-9]*$/i` restricted to the case-sensitive alphanumeric mix actually seen in
     acronyms, or an equivalent "≥1 uppercase letter and no lowercase letter *other than* a
     single trailing lowercase run following a digit" rule) — exact regex is an
     implementation detail for `spec-executor` to finalize against the test cases in
     Validation Plan, but it must not regress on "K8s"-style forms.
   - R3b. Drop tokens that are purely numeric or contain no letters (`\p{L}`).
   - R3c. Drop stopwords/connectives/filler using a static, checked-in stopword list per
     supported UI/transcription language family (start with English + Portuguese, matching
     the app's 2 maintained UI languages; the transcription language itself can be any of
     the 58 supported, so the list intentionally also covers common filler across languages
     already present in the codebase, e.g. any lists used by
     `transcriptionQualityHeuristics.js`'s hallucination-pattern detection — reuse rather
     than duplicate if a suitable list exists there).
   - R3d. Drop words already present in the static Custom Dictionary (case-insensitive) —
     no duplication between the two sources.
   - R3e. Case-fold for frequency counting but preserve the most-frequent original casing
     variant for the final output token (so proper nouns like "Kubernetes" aren't lowercased).
4. **Scoring**: frequency count across all mined text from the session window, per R1a–R1d
   sources; a token appearing in *both* the transcript and OCR text (or across multiple
   rows) scores higher — a simple raw count is sufficient for v1 (no TF-IDF/recency decay
   needed to prove value; document as a possible future refinement, not required now).
5. **Output cap**: the ranked list is capped at a fixed maximum token count before being
   joined into a prompt string (default 40 words — deliberately smaller than the dictionary's
   effective share of the 650/890-char budget, since this is a lower-confidence, higher-volume
   source that must not crowd out the user's own curated dictionary or the language hint).
6. **Prompt combination — placement and truncation direction**:
   - R6a. `combineLocalTranscriptionPrompt()` and `combineCloudTranscriptionPrompt()` in
     `src/utils/languageSupport.ts` gain a new optional parameter for the dynamic-vocab
     string, positioned **first** in the joined string: `[dynamicVocab, dictionaryPrompt,
     langHint]`, so tail-preserving truncation drops dynamic-vocab content first, then
     dictionary content, and always preserves the langHint — consistent with the existing
     documented rationale (shortest, most safety-critical segment survives longest).
   - R6b. Existing call sites' behavior is unchanged when the new parameter is omitted/empty
     — this is strictly additive, no regression to the language-detection-fix behavior these
     functions already implement.
7. **Privacy gating (resolved)**: the transcript-derived (R1a/R1b) source defaults ON as an
   extension of the existing dictionary/prompt mechanism (it's already local transcript text
   the app stores and already sends to whichever transcription provider the user configured,
   cloud or local — no new data leaves that wasn't already going to that same provider as part
   of transcription itself, since a *previous* turn's transcript is not "new" data relative to
   what the current transcription request already contains conceptually). The OCR-derived
   (R1c) source is gated behind a separate, default-OFF toggle,
   `dynamicPromptVocabularyIncludeScreenContext`, and applies to both local and cloud
   transcription providers alike once enabled — see Design.
8. **Performance**: the scoring pass must run in low single-digit milliseconds for a 20-row
   window (bounded text volume) and be triggered once per warmup call (hotkey-down), never a
   polling/background timer — see Design → "Speed & idle-budget impact."
9. **Two independent settings**:
   - `dynamicPromptVocabularyEnabled` (default `true`) — master toggle governing the
     transcript-derived sources (R1a/R1b); lets the user disable the whole feature if it ever
     produces bad suggestions.
   - `dynamicPromptVocabularyIncludeScreenContext` (default `false`) — separate, independent
     toggle governing whether `screen_context_text` (R1c) is additionally mined. Turning this
     on has no effect if `dynamicPromptVocabularyEnabled` is off (the whole feature is
     disabled); turning it off (the default) means OCR text is never mined regardless of the
     master toggle's state.
10. **Persistent, recency-weighted long-term vocabulary statistics** (additive to the
    session-window mining of R1a–R1c, not a replacement):
    - R10a. A new `vocabulary_stats` table (`word TEXT PRIMARY KEY`, `count INTEGER NOT NULL
      DEFAULT 0`, `last_seen_at DATETIME NOT NULL`) is updated every time a completed
      transcription's mined tokens survive the R3a–R3e filter pipeline: for each surviving
      token, upsert `count = count + 1`, `last_seen_at = now()`. This runs once per completed
      transcription (not per VAD chunk), gated behind the same `dynamicPromptVocabularyEnabled`
      master toggle as the rest of the feature — when the toggle is off, no rows are written
      or read.
    - R10b. Scoring combines two signals: (i) the existing session-window frequency count
      (R1a–R1c, last-20-rows) and (ii) a recency-weighted score derived from
      `vocabulary_stats`: `recencyScore = count * decayFactor(daysSinceLastSeen)`, where
      `decayFactor` is a simple exponential decay (e.g. `0.5 ^ (daysSinceLastSeen /
      HALF_LIFE_DAYS)`, `HALF_LIFE_DAYS` a checked-in constant — see Design for the concrete
      starting value). The two scores are combined (e.g. weighted sum, session score weighted
      higher) such that: a word recent in the session scores highest; a word long-term
      frequent but not seen this session scores moderately (via decay); a brand-new one-off
      word scores lowest. Exact combination weights are a Design-section decision, not
      user-configurable in v1.
    - R10c. This is purely additive storage — no existing table/column is restructured, so
      per Premise #6 no destructive migration is needed; `CREATE TABLE IF NOT EXISTS` is
      sufficient and existing user data (history, dictionary, settings) is untouched.
    - R10d. `vocabulary_stats` is operational-adjacent bookkeeping for this feature, not
      user-facing "collected data" in Premise #7's sense (it's server-side-of-the-app derived
      word statistics, not raw transcript/audio content) — it has no separate retention
      setting in v1; clearing it happens implicitly if the user disables
      `dynamicPromptVocabularyEnabled` and the underlying transcription history is deleted via
      existing "Clear All" flows is a Non-goal (see below) that can be revisited later if
      needed.
**R11 (in-memory semantic-proximity grouping) — descoped.** An earlier revision proposed
grouping near-duplicate vocabulary entries via cosine similarity over ONNX-worker-generated
embeddings. This has been dropped from scope entirely: `src/workers/onnxWorker.js` exposes no
generic text-embedding request handler in production, so the feature could never actually run
there — it would only ever hit its own graceful-degradation no-op path. See TL;DR for the full
rationale. Near-duplicate word variants are not merged in v1.

## Non-goals

- No UI for manually editing/curating the dynamic vocabulary list (it's fully automatic;
  the existing Custom Dictionary remains the manual-curation surface).
- No cross-session persistence of a *derived, pre-computed prompt string* artifact — the
  prompt string itself is still recomputed fresh each time; the only new persistent artifact
  is the lightweight `vocabulary_stats` counters table (R10), not a cached vocabulary list or
  prompt.
- No TF-IDF. Frequency + recency-decay is the only scoring signal (R10b) — no more
  sophisticated ranking model in v1.
- **No persistent vector store, no Qdrant reintroduction, no new sidecar/service, and no
  ONNX-embedding-based semantic grouping at all** — an earlier revision of this spec proposed
  reusing the existing ONNX worker's embedding-generation capability for small, in-memory
  cosine-similarity grouping (R11); that requirement has been descoped entirely (see TL;DR),
  not merely deferred, since `src/workers/onnxWorker.js` has no generic text-embedding request
  handler in production. This spec introduces no new persistent infrastructure of any kind.
- No per-language stopword completeness beyond English + Portuguese in v1; other
  transcription languages simply get less filler-filtering (dynamic vocab still works, just
  less precisely filtered) rather than blocking the feature on translating stopword lists
  for all 58 languages.
- No changes to the auto-learn correction pipeline (`autoLearnDictionary.js`,
  `correctionLearner.js`) — this is a parallel, independent mechanism that happens to reuse
  its tokenizer as a utility, not a modification of that pipeline's own behavior/thresholds.
- No retention/settings changes to `screen_context_text` itself (§20's existing retention
  rules for persisted screenshots are untouched; this spec only *reads* the already-persisted
  OCR text column when the new gate — R1c — is on).

## Design

### New module: `src/helpers/dynamicPromptVocabulary.js`

Electron/IPC-free (mirrors `autoLearnDictionary.js`'s pattern), so it is unit-testable
without any native binary or database mock beyond a plain array of row objects.

- `extractVocabularyTokens(text, { stopwords })`: tokenizes via `correctionLearner.js`'s
  `tokenize()`, applies R3a–R3c filters, returns `string[]`.
- `scoreVocabulary(rows, { existingDictionary, includeScreenContext, stopwords })`: given
  `rows` (each `{ text, raw_text, screen_context_text }`, i.e. exactly the shape
  `getTranscriptions()` already returns), tokenizes each configured field per row, folds
  case for counting (R3e), excludes existing-dictionary words (R3d), and returns a
  frequency-sorted `Array<{ word, count }>` descending.
- `buildDynamicVocabularyPrompt(rows, options)`: calls `scoreVocabulary`, caps at
  `maxWords` (default 40, R5), joins surviving words (highest count first) into a
  comma-separated string identical in shape to the existing dictionary prompt string (so
  it composes the same way downstream) — returns `""` when no rows/tokens qualify.
- A checked-in stopword/filler list: `src/constants/dynamicVocabularyStopwords.json`
  (`{ en: string[], pt: string[], universal: string[] }` — `universal` covers filler that
  isn't language-specific, e.g. isolated symbols already stripped by the tokenizer, plus any
  cross-language filler tokens found reusable from `transcriptionQualityHeuristics.js`).
- **R3a acronym exception (implementation detail)**: `extractVocabularyTokens()` must capture
  each token's original casing *before* R3e's case-folding step, test it against the acronym
  rule (see R3a above — accepts fully-uppercase and uppercase+digit forms, and must not
  regress on mixed forms like "K8s"), and apply a length floor of 2 instead of 3 only for
  tokens that pass that test. All other filters (R3b numeric-only, R3c stopwords, R3d
  dictionary-dup) still apply unchanged to acronym-exempted tokens — the exception only
  widens the length floor, nothing else.

### Persistent stats: new `vocabulary_stats` table

- Schema: `CREATE TABLE IF NOT EXISTS vocabulary_stats (word TEXT PRIMARY KEY, count INTEGER
  NOT NULL DEFAULT 0, last_seen_at DATETIME NOT NULL)` in `database.js`'s existing
  schema-initialization path (same place `screen_context_text`'s additive migration lives,
  per §20) — purely additive, no existing table touched, satisfies Premise #6 without a
  destructive migration.
- `DatabaseManager.recordVocabularyOccurrences(words)`: upserts each surviving token from a
  completed transcription's filter pipeline (`INSERT ... ON CONFLICT(word) DO UPDATE SET
  count = count + 1, last_seen_at = excluded.last_seen_at`), called once per completed
  transcription (mirrors where `setDictionary()`/auto-learn persistence already hooks in),
  gated on `dynamicPromptVocabularyEnabled`.
- `DatabaseManager.getVocabularyStats()`: returns all rows (bounded — this table only grows
  by distinct-word count, not by transcription count, so it stays small over realistic
  vocabulary sizes).
- **Recency-decay formula** (checked-in constant, simple and auditable):
  `recencyScore(count, lastSeenAt) = count * Math.pow(0.5, daysSince(lastSeenAt) /
  VOCAB_STATS_HALF_LIFE_DAYS)`, with `VOCAB_STATS_HALF_LIFE_DAYS = 14` as the starting
  constant (a word not seen in 14 days contributes half its raw count; not seen in 28 days,
  a quarter; etc.) — lives alongside the other tuning constants in
  `src/helpers/dynamicPromptVocabulary.js`, adjustable during implementation/validation
  without a design change.
- **Combined score**: `finalScore(word) = sessionWindowCount(word) * SESSION_WEIGHT +
  recencyScore(word) * LONGTERM_WEIGHT`, with `SESSION_WEIGHT = 1.0` and `LONGTERM_WEIGHT =
  0.3` as starting constants (session-recency dominates; long-term stats contribute but don't
  outrank a word the user is actively using right now). Words present in only one source
  simply have the other term as `0`. This keeps R10b's three-tier ordering (session-recent >
  long-term-frequent-but-stale > brand-new one-off) achievable without a more complex model.

### `src/utils/languageSupport.ts` changes

- `combineLocalTranscriptionPrompt(dynamicVocabPrompt, dictionaryPrompt, langHint, maxChars)`
  and `combineCloudTranscriptionPrompt(dynamicVocabPrompt, dictionaryPrompt, langHint,
  maxChars)` — new leading parameter, all existing call sites pass `null`/`""` unless wired
  in by `audioManager.js` (R6b: parameter is optional/backward compatible via default
  `undefined` treated as absent, exactly like the existing `Boolean` filter already handles
  `dictionaryPrompt`/`langHint` being falsy).
- Joined order becomes `[dynamicVocabPrompt, dictionaryPrompt, langHint].filter(Boolean).join(" ")`
  in both functions; tail-preserving truncation logic (`slice(-maxChars)` + word/comma
  boundary trim) is otherwise unchanged, so it naturally drops from the *front* of the
  combined string first — i.e. dynamic vocab, per R6a.
- `LOCAL_INITIAL_PROMPT_MAX_CHARS` (650) and the cloud 890/900-char cap are unchanged; the
  new source competes for the same budget rather than getting a separate reserved slice —
  this keeps the truncation logic in one place and matches R6a's "drop dynamic vocab first"
  intent without needing a second cap to reason about.

### `src/helpers/audioManager.js` wiring

- New method mirroring `getCustomDictionaryPrompt()`: `getDynamicVocabularyPrompt()` — calls
  `databaseManager.getTranscriptions(N, { includeDiscarded: false })` and
  `buildDynamicVocabularyPrompt()`, gated on the new `dynamicPromptVocabularyEnabled`
  setting and (separately) whether OCR inclusion is enabled (R1c gate — see Privacy section
  below for what that gate actually is pending the blocking decision).
- Call sites at the existing three `combineLocalTranscriptionPrompt`/
  `combineCloudTranscriptionPrompt` locations (lines ~1078, ~1428, ~2213 as of this spec's
  writing) each gain the new leading argument.
- Computed once at warmup time (`warmupTranscriptionEngine()`'s existing call path per §18),
  not re-queried per VAD chunk during progressive batching (§19) — the value is stable for
  the whole recording, avoiding repeated DB hits mid-dictation.

### Privacy: OCR-derived vocabulary (decided: opt-in, default off)

§20 gates screen *capture* on `shouldCaptureScreenContext()` — capture only happens when a
cleanup/agent LLM pass will actually consume the OCR text for *that specific turn*. This
spec's R1c instead lets a **previously captured and persisted** `screen_context_text` value
influence a **later, unrelated dictation's raw transcription request** — including one routed
to a cloud transcription provider (OpenAI/Groq/custom) that never itself triggered any screen
capture. That is new relative to §20's existing gate: it moves OCR-derived text from "only
reaches an LLM pass the user's own cleanup/agent config already sends data to" into "reaches
whichever transcription provider is configured, on a later turn."

The project owner has decided: **opt-in, default off, applies to both local and cloud
transcription providers alike** (no local-transcription-only restriction). Concretely:

- `dynamicPromptVocabularyEnabled` (default `true`) covers transcript-derived sources
  (R1a/R1b) only.
- A *separate* toggle, `dynamicPromptVocabularyIncludeScreenContext` (default `false`), gates
  R1c's OCR mining independently. Nothing from `screen_context_text` is ever read by
  `scoreVocabulary()`/`buildDynamicVocabularyPrompt()` unless this toggle is explicitly turned
  on in Settings.
- Once enabled, R1c applies uniformly regardless of which transcription provider (local
  whisper.cpp/Parakeet or cloud OpenAI/Groq/custom) is handling the *current* dictation — the
  user's opt-in is a blanket acknowledgment that previously-captured on-screen text may
  influence any subsequent dictation's prompt, not a per-provider distinction.

### Speed & idle-budget impact

- Triggered exactly once per recording, at the existing warmup call (hotkey-down) — no new
  background timer, satisfying Premise #2 (idle budget untouched: zero cost while not
  recording).
- `getTranscriptions(20, ...)` is an existing, already-indexed (`timestamp DESC`) query the
  app already performs elsewhere (history view) — bounded row count keeps this well under a
  millisecond on typical hardware; tokenizing ~20 rows of short dictation text is likewise
  sub-millisecond. This runs concurrently with the existing `warmupTranscriptionEngine()`/
  `warmupReasoningServer()` fire-and-forget calls, not serialized in front of them, so it does
  not add latency to the ≤500ms raw-transcription budget (Premise #3) — the prompt must only
  be ready by the time the *first* transcription request is actually sent, which is already
  gated behind engine warm-up completing.

### Migration / settings

- New settings keys: `dynamicPromptVocabularyEnabled` (default `true`),
  `dynamicPromptVocabularyIncludeScreenContext` (default `false`, per Option A above). Both
  are brand-new keys with defined defaults — no migration needed (Premise #6 only applies to
  changing/removing existing keys).
- Session-window mining reads existing `text`/`raw_text`/`screen_context_text` columns only —
  no schema change there.
- The new `vocabulary_stats` table (R10a) is an additive `CREATE TABLE IF NOT EXISTS` — no
  existing table/column is restructured or renamed, so per Premise #6 no destructive
  migration/backfill is required; the table simply starts empty on upgrade and accumulates
  from that point forward.

## Validation Plan

### Automated

- `test/helpers/dynamicPromptVocabulary.test.js` (new, `node --test`):
  - `extractVocabularyTokens()`: drops stopwords/fillers, drops <3-char tokens, drops
    numeric-only tokens, preserves proper-noun casing.
  - **R3a acronym-exception regression tests**: asserts "API", "AWS", "SQL", "ID", "UI",
    "GPT4"-style all-uppercase/uppercase+digit 2-3 char tokens survive the length filter;
    asserts "K8s"-style mixed-case acronym forms survive too (per the worked note in
    Requirements); asserts stray lowercase 2-letter fragments (e.g. "ai" lowercase, "ui"
    lowercase used as filler) and stopword-list fillers ("uh", "um") are still dropped —
    i.e. the exception is casing-gated, not merely length-gated, and stopword filtering
    still applies on top of it.
  - `scoreVocabulary()`: correctly ranks by frequency across multiple rows; excludes words
    already in the passed-in existing dictionary (case-insensitive); folds case for counting
    but returns the most-frequent casing variant; respects the `includeScreenContext` flag
    (asserts screen_context_text is ignored when the flag is false, included when true).
  - `buildDynamicVocabularyPrompt()`: caps output at `maxWords`; returns `""` for empty/no-op
    input; output ordering is highest-frequency-first.
  - **Recency-weighted scoring** (`recencyScore()`/`finalScore()` combination): asserts a
    word with a low session-window count but a high long-term `vocabulary_stats` count and a
    recent `last_seen_at` scores above a word with a high long-term count but a stale
    `last_seen_at` (decay has visibly reduced its contribution past a threshold); asserts a
    brand-new word present only in the session window (no `vocabulary_stats` row at all)
    still scores using the session-window term alone (no crash on a missing long-term entry);
    asserts the decay formula's output at `daysSince = HALF_LIFE_DAYS` is exactly half the
    raw count (pins the constant/formula against silent drift).
  - **`vocabulary_stats` persistence across simulated sessions**: using an in-memory/temp
    SQLite `DatabaseManager` instance (mirroring the existing pattern used by other
    `database.js`-backed tests — verify at implementation time which existing test file sets
    this pattern up, e.g. the screen-context-migration test), calls
    `recordVocabularyOccurrences()` across multiple simulated "sessions" (separate calls with
    time gaps) and asserts: (a) `count` accumulates correctly across calls for a repeated
    word, (b) `last_seen_at` updates to the most recent call's timestamp, (c) a fresh
    `CREATE TABLE IF NOT EXISTS` against an existing database with pre-existing unrelated
    tables/data leaves that other data untouched (migration-safety regression per Premise
    #6).
- `test/components/languageSupport.test.js` (existing file, updated):
  - New cases asserting `combineLocalTranscriptionPrompt`/`combineCloudTranscriptionPrompt`
    accept the new leading `dynamicVocabPrompt` parameter, place it first in the joined
    string, and that truncation drops dynamic-vocab content before dictionary content before
    langHint content (three-tier truncation-priority regression test — construct a combined
    string that overflows `maxChars` only after adding the dynamic-vocab segment, assert the
    langHint and dictionary segments both survive intact and only the vocab segment is
    truncated/dropped).
  - Existing test cases (2-argument calls) must continue to pass unmodified, proving R6b's
    backward-compatibility requirement.
- `test/helpers/audioManager.dynamicVocabulary.test.js` (new, or an addition to an existing
  `audioManager` test file if one exists — verify at implementation time): asserts
  `getDynamicVocabularyPrompt()` is gated correctly by both settings toggles (master +
  screen-context-inclusion), and that it's computed once per warmup call rather than
  re-queried per VAD chunk.

### Manual

1. Dictate 3-4 short sentences repeating an uncommon proper noun (e.g. a fictional project
   codename) across separate dictations, without adding it to the Custom Dictionary.
2. Start a new dictation and say the same term again in a noisy/ambiguous way; verify (via
   debug logs, `dynamicPromptVocabulary` or transcription-pipeline debug category) that the
   term appears in the composed `initialPrompt` sent to whisper.cpp/the cloud API.
3. Toggle `dynamicPromptVocabularyEnabled` off in Settings; repeat step 2 and verify the term
   is absent from the composed prompt.
4. With `dynamicPromptVocabularyIncludeScreenContext` left at its default (off), capture
   screen context on one dictation via the existing §20 flow, then start an unrelated plain
   dictation with no cleanup/agent configured and verify — via debug logs — that OCR-derived
   words from the prior turn do NOT appear in that plain dictation's prompt.
5. Enable `dynamicPromptVocabularyIncludeScreenContext` in Settings, repeat the same
   capture-then-plain-dictation sequence, and verify the OCR-derived words DO appear in the
   composed prompt this time — confirming the toggle is the sole gate and applies regardless
   of local vs. cloud transcription provider.

### Docs

- `CLAUDE.md` §13 (Custom Dictionary / prompt-combination pipeline): add a paragraph
  documenting the new third prompt source, its settings keys, the updated
  `combineLocalTranscriptionPrompt`/`combineCloudTranscriptionPrompt` signatures, the R3a
  acronym-exception rule, and the `vocabulary_stats` table + recency-decay scoring, once
  implemented. Do not document any semantic-grouping step — R11 was descoped, not shipped.
- `docs/RECREATION_SPEC.md`: update §0 and the relevant settings-keys/database-schema
  listings to reflect the two new localStorage keys, the new `vocabulary_stats` table, and
  the updated prompt-combination/scoring behavior.

## Open Questions

- Should `N` (session window row count, default 20) be user-configurable in a later
  iteration, or is a fixed default sufficient long-term? Non-blocking — ship fixed for v1,
  revisit if manual testing shows a strong need.
- Should the dynamic-vocab list be visible to the user anywhere (e.g. a read-only "currently
  suggested words" debug view), for transparency/trust, or is debug-log visibility enough?
  Non-blocking, product/UX call rather than a technical one.
