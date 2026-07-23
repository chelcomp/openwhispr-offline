# Dictation Language Detection Fix

## Status
Implemented

## TL;DR
- What's changing: (1) the local `whisper-server` CLI `--language` flag is threaded correctly
  (was always stale/`"auto"`); (2) a language-setting change now **unloads the running
  whisper-server (unload-only, no auto-reload)** instead of restarting it, mirroring the
  existing model/provider-switch behavior; (3) folded in: the `initialPrompt` (dictionary +
  language hint) is reordered/capped, and gains `carry_initial_prompt`, so the hint stops
  getting silently dropped once a dictionary is long.
- Revised understanding (verified against the bundled `OpenWhispr/whisper.cpp` fork source via
  `gh api`): the per-request `language` field **already overrides** the CLI default
  unconditionally, and this app always sends it — so the CLI-flag bug likely had **little
  real effect on output**. The fix is kept as hygiene/defense-in-depth, not asserted as the
  definite root cause.
- Key decisions:
  - No auto-restart inside `start()`'s no-op guard (drops the prior draft's plan). Per
    explicit owner instruction ("unload — do not reload"), a language change now unloads via
    the existing `sync-startup-preferences` mechanism only — same shape as today's
    model/provider-switch unload.
  - Local prompt order flips to **dictionary-then-hint** (whisper.cpp truncates from the
    front, so the hint must sit at the end). Local gains its first-ever cap (~650 chars,
    derived from whisper.cpp's real ~224-token ceiling).
  - **Cloud path is now unified with local (Revision 3, supersedes the prior "deliberately
    left unreordered" call)** — per explicit owner direction to force both paths to match.
    Live-verified this revision (`curl` against OpenAI's and Groq's actual docs, not assumed):
    OpenAI states the hosted API "only considers the final 224 tokens of the prompt and
    ignores anything earlier" — same keep-tail direction and ~224-token ceiling already
    source-verified for whisper.cpp. Groq confirms the same 224-token ceiling but not
    explicitly which end is dropped (treated as high-confidence-by-architecture, same model
    weights, not directly cited). So cloud's own truncation (`slice(0, MAX_PROMPT_CHARS)`,
    keep-front) was itself backwards relative to how the real API re-truncates — not merely
    differently-ordered. Fix: cloud now shares local's order (dictionary-then-hint) and
    keep-tail truncation (R12, revised); only the numeric cap (890/900, an unrelated Groq
    hard-rejection limit) stays unchanged. Scope: OpenAI/Groq/self-hosted "custom" (the shared
    formData path) — Mistral/xAI use separate mechanisms and are untouched.
  - `carry_initial_prompt=true` enabled now (per-request field, not a CLI flag) — negligible
    cost (1 of 224 prompt tokens), keeps the whole prompt alive across a multi-segment decode.
- No blocking open question. Non-blocking follow-ups: Parakeet's equivalent path (untouched),
  and manual confirmation that the real vendored binary honors this end-to-end.
- Practical impact: changing language frees the model's RAM immediately instead of restarting
  it; next dictation cold-starts with the new language. Long custom dictionaries should stop
  silently pushing the language hint out of the transcription prompt.

## Problem / Goal

`preferredLanguage` is a single global setting (comma-separated for multi-select, `"auto"`
exclusive) that resolves to one effective language code via `getBaseLanguageCode()`
(`src/utils/languageSupport.ts`) at each of Dictation, Meeting, Note Recording, and Upload's
entry points. That resolved value is correctly sent as a per-request multipart `language`
field on every `WhisperServerManager.transcribe()` call
(`src/helpers/whisperServer.js:757-761`).

The local `whisper-server` binary is also started with its own `--language` CLI flag
(`buildWhisperServerArgs()`, `whisperServer.js:128-171`), baked in once at process-start time.
Tracing every call path that starts the server shows `language` is never actually supplied to
it:

- `whisper.js`'s `_runServerTranscription()` (the function underlying every local-Whisper
  transcription, including each VAD-chunked utterance in the always-on progressive batching
  session — see CLAUDE.md §19) calls `this.serverManager.start(modelPath, { useCuda,
  vadEnabled, vadModelPath, vadConfig })` — no `language` key, despite `language` being an
  available local variable in that same function (already used for the `transcribe()` call
  right below it).
- The three warm-up call sites that fire at hotkey-down/file-selection —
  `audioManager.js`'s `warmupTranscriptionEngine()`, `meetingRecordingStore.ts`'s
  `startRecording()`, and `UploadAudioView.tsx`'s `warmupUploadTranscriptionEngine()` —
  all call `window.electronAPI.whisperServerStart(modelName)` with no language argument at
  all; neither `preload.js`, `ipcHandlers.js`'s `whisper-server-start` handler, nor
  `WhisperServerManager.start()` currently has any notion of an "effective language" to
  compare or forward.

**Revised, source-verified understanding of the actual impact (new this revision).** The
vendored fork's server (`examples/server/server.cpp:560-562`, `OpenWhispr/whisper.cpp`)
overwrites `params.language` from the per-request multipart `language` field
unconditionally, on every request:

```
if (req.has_file("language")) { params.language = req.get_file_value("language").content; }
```

This runs *after* the CLI startup default is loaded and wins every time. Since this app's
`transcribe()` already always sends a `language` field (`language || "auto"`), the
CLI-startup-language bug most likely had **little to no user-visible effect on transcription
output** in the common single-process-lifetime case — the correct per-request value was
already winning. This spec's fix to the CLI flag is retained as correctness/hygiene and a
safety net for any future code path that might ever omit the per-request field (defense in
depth), not because it's proven to be the definite root cause of any specific mis-detection
report. State this honestly rather than over-claiming causation.

**Product decision on how a language change should propagate to a running server (new this
revision).** The project owner gave an explicit instruction superseding the prior draft's
plan: *"whenever a language is changed on setting, unload whisper server — do not reload —
only unload it — make sure to send language on startup and on every request."* Concretely:
switching the language setting should behave exactly like the existing "model/provider
switch" behavior in `docs/specs/on-demand-model-lifecycle.md`'s R4 — immediate unload, lazy
reload only via a genuine next trigger (warm-up or a real transcription request) — not like a
forced synchronous restart baked into `start()`'s own no-op guard.

Additionally, the transcription `initialPrompt` (custom dictionary words + a multi-language
hint sentence) has its own, separate correctness issues that are folded into this same spec at
the project owner's request (same code shape, same problem space — not worth a second spec):
whisper.cpp's real prompt-context ceiling is small (~224 tokens for this app's bundled
models), its truncation/eviction behavior drops content from the **front** of the combined
prompt, the current code puts the language hint **first** (most at risk) and the dictionary
**second**, the local path has **no length cap at all** (unlike the cloud path's existing
890/900-char cap), and whisper.cpp's `carry_initial_prompt` option — which would keep the
whole prompt reliably present across a multi-segment decode instead of letting it evict
mid-utterance — is available but never enabled.

## Requirements

### CLI/per-request language plumbing (unchanged from prior revision)

- **R1 (revised).** `whisperServer.js` gains a `getLanguageSignature(options = {})` helper —
  exported like `getVadSignature` — returning `` `language:${options.language || "auto"}` ``.
  Unlike the prior revision's plan, this signature is **tracked for comparison purposes only**
  (consumed by the new R7 unload check below) and is **not** added as a term in `start()`'s
  own no-op restart guard. `WhisperServerManager` gains an instance field
  `this.languageSignature`, initialized to `"language:auto"` in the constructor and updated to
  the newly-resolved signature only at the point a restart is actually about to happen (the
  same point `vadSignature`/`threadSignature` are already updated, immediately before
  `_doStart()`) — i.e. it always reflects the language the currently-running process was
  actually started with, never a value that was requested-but-no-op'd-away.
  - Why the guard itself doesn't need a language term: once R7 (below) proactively unloads on
    a genuine language change, the server's `ready` flag is `false` by the time the next
    `start()` call is made for real use — and `start()`'s no-op guard's very first condition is
    `this.ready && ...`, so a stopped server never takes the no-op shortcut regardless of
    signature matching. The signature is still tracked (for R7's comparison), just not
    consulted inside `start()` itself.
- **R2 (unchanged).** `whisper.js`'s `_runServerTranscription()` must include the function's
  own `language` variable in the options object passed to
  `this.serverManager.start(modelPath, { ... })` (currently `{ useCuda, vadEnabled,
  vadModelPath, vadConfig }`, `whisper.js:312-317`) — this is the root-cause CLI-arg fix.
- **R3 (unchanged).** All three warm-up call sites must resolve and pass the same effective
  language their own surface already computes for its real transcription call, threaded
  end-to-end (renderer call → `preload.js` → `whisper-server-start` IPC handler →
  `WhisperServerManager.startServer()`/`start()`):
  - `audioManager.js`'s `warmupTranscriptionEngine()` — via `getBaseLanguageCode(settings.preferredLanguage)`.
  - `meetingRecordingStore.ts`'s `startRecording()` — same computation `getMeetingTranscriptionOptions()` already does.
  - `UploadAudioView.tsx`'s `warmupUploadTranscriptionEngine()` — same computation the real-transcription path already does, gated to the `"whisper"` local provider only.
  - **Justification revised this revision**: under the prior revision's design (language as a
    guard term inside `start()`), this was Speed-load-bearing — skipping it would have forced a
    synchronous restart on the first real per-chunk `start()` call after hotkey release. Under
    this revision's design (R1: no language term in the guard), that specific restart can no
    longer happen at all — a per-chunk `start()` call no-ops whenever `ready`/model/vad/thread
    already match, regardless of language. R3 is still required, but for a different, more
    modest reason: it's the explicit product-owner instruction ("send language on startup"),
    and it's the only way a warm-up-driven cold start ever gets the correct CLI `--language`
    flag — without it, a server that only ever gets warmed (never restarted for an unrelated
    reason) would sit on the stale `auto` CLI default for its whole lifetime, relying entirely
    on the per-request field for correctness. Not fixing R3 wouldn't violate the Speed budget
    under this design, but would leave the CLI flag wrong indefinitely for warm-up-started
    servers, which defeats the point of R2.
- **R4 (unchanged).** Multi-language selection (2+ codes → `"auto"` + prompt hint) must not
  regress; add its first regression test.
- **R5 (unchanged).** `--best-of 5` is not modified; recorded so it isn't re-litigated.
- **R6 (unchanged).** Add regression coverage proving `-tr`/`--translate` is never emitted by
  `buildWhisperServerArgs()` or `transcribe()`'s multipart body.

### Unload-on-language-change (new this revision, replaces the old auto-restart plan)

- **R7.** Extend the existing `sync-startup-preferences` IPC round-trip (`useSettings.ts` →
  `ipcHandlers.js`) — the same mechanism that already unloads the stale server on a
  model/provider switch (`docs/specs/on-demand-model-lifecycle.md` R4) — to also unload the
  running whisper-server when the *resolved effective* transcription language changes,
  compared against the tracked `languageSignature` from R1:
  - `useSettings.ts`'s existing `useEffect` (the one calling
    `window.electronAPI.syncStartupPreferences({...})`) gains `preferredLanguage` in its
    store destructure and dependency array, resolves
    `const language = getBaseLanguageCode(preferredLanguage);` (importing `getBaseLanguageCode`
    from `../utils/languageSupport`, not currently imported in this file), and adds `language`
    to the payload object.
  - `ipcHandlers.js`'s `sync-startup-preferences` handler, inside its existing non-nvidia
    ("whisper") branch (the same branch that already does the same-provider
    model-mismatch-unload check), additionally computes
    `getLanguageSignature({ language: prefs.language })` and compares it against
    `this.whisperManager.serverManager?.languageSignature`. If the whisper server is currently
    `ready` **and** the signatures differ, call `this.whisperManager.stopServer()` — **and
    nothing else**. No `startServer()`/`start()` call is made as a direct consequence of this
    branch, matching the same "unload immediately, reload only lazily" shape the existing
    model-switch code in this same handler already follows.
  - This check does not apply when `localTranscriptionProvider === "nvidia"` (Parakeet) or
    when `useLocalWhisper` is `false` (cloud) — both already fully out of scope per Non-goals.
  - `src/types/electron.ts`'s `syncStartupPreferences` prefs type gains an optional
    `language?: string` field.
- **R8.** No change to `main.js`'s wake-from-sleep handler — it already calls
  `whisperManager.stopServer()` unconditionally on resume (unload-only, matching this same
  design philosophy) and is unaffected by anything in R1/R7.

### Initial-prompt ordering, cap, and `carry_initial_prompt` (new this revision)

- **R9.** Extract the prompt-combining logic that currently exists inline in three places in
  `audioManager.js` (the live-preview batching path at `~1069`, the main local-Whisper path at
  `~1404-1409`, and the cloud path at `~2178-2198`) into two small, pure, dependency-free
  helper functions added to `src/utils/languageSupport.ts` (already the home of
  `getMultiLanguagePromptHint`, already imported by `audioManager.js`), so this logic finally
  gets direct unit-test coverage instead of being untestable inline code inside a
  DOM/Electron-coupled class:
  - `combineLocalTranscriptionPrompt(dictionaryPrompt, langHint, maxChars = LOCAL_INITIAL_PROMPT_MAX_CHARS)`
    — used by both local (whisper.cpp) call sites. Orders as **dictionary, then hint** (hint
    last). If the combined string exceeds `maxChars`, keeps the **last** `maxChars` characters
    (`slice(-maxChars)`), then trims forward to the next word boundary so the retained text
    doesn't begin mid-word. Returns `{ prompt, truncated, originalLength, truncatedLength }`.
  - `combineCloudTranscriptionPrompt(dictionaryPrompt, langHint, maxChars)` — used by the cloud
    path only. **Revised this revision (Revision 3)**: no longer wraps the old behavior
    unchanged. Orders as **dictionary, then hint** (hint last — now matches the local
    function's order exactly, same parameter order too). If the combined string exceeds
    `maxChars`, keeps the **last** `maxChars` characters (`slice(-maxChars)`, inverted from
    the old `slice(0, maxChars)`), then finds the **first** comma inside that kept tail and
    drops everything up to and including it (plus a leading-space trim) so the retained text
    starts at a clean dictionary-entry boundary rather than mid-entry — the mirror-image of
    the old logic's "find the *last* comma near the *end* of the kept front and cut there."
    Falls back to trimming at the first whitespace character if the kept tail contains no
    comma at all (e.g. an unusually long single dictionary entry). Because `langHint` is
    always far shorter than `maxChars` (890/900), `slice(-maxChars)` can never cut into the
    hint itself, and the first-comma boundary search always lands inside the dictionary
    portion that precedes it — the discriminating invariant that makes this truncation
    provably safe for the hint. Same return shape as the local function
    (`{ prompt, truncated, originalLength, truncatedLength }`).
  - `LOCAL_INITIAL_PROMPT_MAX_CHARS` is a new exported constant (see R10 for its derivation).
- **R10.** Local path gains a length cap where none exists today (Bug 2). Derivation, to be
  captured as a code comment mirroring the cloud path's existing
  `whisperServer.js`/`audioManager.js:2174-2177` comment style: whisper.cpp's real prompt
  ceiling is `max_prompt_ctx = min(n_max_text_ctx, n_text_ctx/2)`
  (`src/whisper.cpp:6927`); this app's bundled models all use the standard `n_text_ctx = 448`,
  giving `max_prompt_ctx = 224`. With `carry_initial_prompt` enabled (R13),
  `max_tokens = max_prompt_ctx - 1 = 223` tokens are actually available for the prompt. At a
  conservative ~3 chars/token (below the ~4 chars/token typical for English, to leave headroom
  for non-Latin scripts and dictionary jargon, which often tokenize less efficiently), that's
  ≈669 characters; round down for margin to **`LOCAL_INITIAL_PROMPT_MAX_CHARS = 650`**. This is
  an explicitly acknowledged char-based approximation of a token-based limit — erring toward
  truncating a little early rather than risking overflow — not an exact conversion.
- **R11.** Reorder the two local call sites (`~1069`, `~1404-1409` in `audioManager.js`) to use
  `combineLocalTranscriptionPrompt()` (dictionary-then-hint, capped, with debug-logged
  truncation exactly mirroring the cloud path's existing truncation-log shape at
  `audioManager.js:2187-2195`). Reorder is a deliberate, direction-specific fix: whisper.cpp's
  own prompt handling drops content from the **front** as the prompt overflows the token
  window (either at tokenize time when `carry_initial_prompt` truncates to "the last N
  tokens," or via ordinary rolling-buffer eviction when it's off) — so the hint, being short
  and specifically relevant to the bug this whole spec exists to fix, must sit at the end,
  where it's safest.
- **R12 (revised this revision — Revision 3, supersedes the prior "deliberately not
  reordered" decision).** The project owner directed that both paths be forced to match.
  Verified this revision, live, via `curl` (not assumed): OpenAI's official docs
  (`platform.openai.com/docs/guides/speech-to-text`) state "The `whisper-1` model only
  considers the final 224 tokens of the prompt and ignores anything earlier" — the hosted
  API keeps the **tail** and drops the front, the identical direction and the identical
  ~224-token ceiling already source-verified for the bundled whisper.cpp fork (Revision 2:
  `src/whisper.cpp:6934-6957`, `max_prompt_ctx = min(n_max_text_ctx, n_text_ctx/2)`). Groq's
  docs (`console.groq.com/docs/speech-to-text`) independently confirm the identical
  `224`-token ceiling for their `prompt` parameter ("Prompt to guide the model's style or
  specify how to spell unfamiliar words. (limited to 224 tokens)"; "The prompt parameter (max
  224 tokens) helps provide context...") but do not explicitly document which end is dropped
  when exceeded — treated as high-confidence-by-architecture (same underlying Whisper model
  weights; any faithful implementation of the same checkpoint's decode conditioning would need
  to replicate the reference implementation's keep-tail slicing to produce sane output, since
  this behavior is baked into how the model was trained to consume prompt context, not a
  hosting-layer policy choice a re-implementer could silently flip without degrading quality).
  This applies to every provider reachable through this shared formData/multipart path —
  OpenAI, Groq, and self-hosted/"custom" endpoints (confirmed via `getTranscriptionEndpoint()`/
  `isGroqEndpoint`, `audioManager.js:2172-2177`, and by tracing that Mistral/xAI are proxied
  through separate main-process IPC handlers with their own `contextBias`/`keyterms`
  mechanisms — `audioManager.js:2215-2281` — and never reach this `prompt`/formData code at
  all, so they stay untouched and out of scope, unaffected by this change).

  **Conclusion**: this app's own cloud-side app-level truncation
  (`combinedApiPrompt.slice(0, MAX_PROMPT_CHARS)`, keep-front) was not merely
  differently-ordered from local — it was truncating in the direction *opposite* to how the
  real API re-truncates downstream. Sending a still-too-long (in tokens) hint-first string
  that survives this app's own front-keeping cap does not protect the hint at all once the
  API's own internal ~224-token window drops the front of *that* string too — the hint,
  placed first, was sitting exactly where both truncation layers agree to cut.

  **Fix**: `combineCloudTranscriptionPrompt()` (R9, revised) now uses the same order
  (dictionary, then hint) and the same keep-tail truncation principle as
  `combineLocalTranscriptionPrompt()` — unifying both the ordering and the underlying
  direction-of-truncation reasoning, for the identical underlying reason (both are the same
  Whisper architecture's ~224-token prompt-context window; the app's own char-based cap and
  the API's own token-based cap now both favor keeping the tail, reinforcing each other instead
  of opposing each other). The cloud path's own `MAX_PROMPT_CHARS` **value** (890 Groq / 900
  others) is unchanged — that number is an orthogonal, API-hard-rejection-avoidance constraint
  (Groq documented to reject prompts > 896 chars outright, a validation limit unrelated to the
  ~224-token context-window concern), not a proxy for the token ceiling; it stays as pure
  headroom against a hard 400 error, while the *direction* it truncates in is what changes.

  **Accepted side-effect, symmetric with R11's local tradeoff**: because truncation now keeps
  the tail, which dictionary entries survive a long-dictionary truncation flips from
  "earliest-added entries" (old, keep-front) to "most-recently-added entries" (new,
  keep-tail) — the same accepted tradeoff already made for the local path in R11, now
  applying identically to cloud.

  Wrap the corrected logic in `combineCloudTranscriptionPrompt()` per R9 so it is
  regression-tested for the first time, this time with an ordering and truncation-direction
  change, not a byte-for-byte-preserving wrap.
- **R13.** Enable `carry_initial_prompt=true` as a per-request multipart field in
  `WhisperServerManager.transcribe()` (`whisperServer.js`, alongside the existing `language`
  and `prompt` fields, `~757-771`) whenever `initialPrompt` is truthy — adopted now, not
  deferred. Reasoning: (a) the per-request field is more consistent with how `language` and
  `prompt` are already sent fresh per request in this codebase, versus adding a CLI startup
  flag in `buildWhisperServerArgs()`; (b) the only tradeoff, per source
  (`examples/server/server.cpp:166,238,572-574`; `src/whisper.cpp`), is reserving 1 of the 224
  prompt-context tokens (`max_tokens = max_prompt_ctx - 1`), already accounted for in R10's
  budget derivation; (c) for this app's actual use — custom dictionary accuracy plus the
  language hint, potentially spanning a multi-segment decode within one VAD-batched chunk up
  to `maxMergedMs = 20000` (CLAUDE.md §19) — a static, always-re-included prefix materially
  helps both survive the whole utterance rather than just its first few seconds. Since the
  exact vendored `whisper-server` binary version is unpinned in this worktree (see Open
  Questions), an older build that predates this field would, per standard multipart-form
  handling, simply ignore an unrecognized field name rather than error — consistent with
  Premise #5's graceful-degradation expectation; call this out explicitly rather than treating
  it as a hard dependency.

## Non-goals

- Parakeet (`parakeetWsServer.js`/`parakeetServer.js`) is not touched by this spec, including
  by the new R7 unload-on-language-change mechanism — it is explicitly scoped out of that
  check as well as the original CLI/per-request plumbing. Flagged as an Open Question for a
  possible separate follow-up.
- Meeting/Note Recording's warm-up VAD-signature mismatch (pre-existing, independent of
  language) is out of scope, as previously noted.
- `-tdrz`/tinydiarize for meetings — scoped separately in
  `docs/specs/meeting-tinydiarize-investigation.md`.
- No settings/schema/localStorage key changes. `preferredLanguage` itself is untouched; the
  new `language` field added to the existing `sync-startup-preferences` IPC payload is derived
  from it at call time, not a new persisted key. Premise #6 (Migration safety) does not apply.
- The cloud path's own `MAX_PROMPT_CHARS` **value** (890 Groq / 900 others — Groq's documented
  hard prompt-length rejection threshold, an orthogonal concern from the ~224-token
  context-window issue) is unchanged by this spec. Its **truncation direction** and **ordering**
  **do** change this revision (R12, revised — supersedes the prior "unchanged, keep-front"
  Non-goal), unified with local now that OpenAI's/Groq's own documented ~224-token,
  keep-tail prompt behavior is understood to make keep-front the wrong direction for this
  app's own pre-truncation. Mistral/xAI remain untouched — they never reach this code path.
- No CLI-level `--carry-initial-prompt` flag added to `buildWhisperServerArgs()` — R13 uses the
  per-request field instead, by design (see R13's reasoning).
- `start()`'s no-op restart guard gains no new comparison term for language (superseded design
  from the prior revision — see R1).

## Design

### 1. `src/helpers/whisperServer.js`

- Add `getLanguageSignature(options = {})` (returns `` `language:${options.language ||
  "auto"}` ``), exported via `module.exports.getLanguageSignature = getLanguageSignature;`
  matching the existing `getVadSignature` export.
- Constructor: add `this.languageSignature = "language:auto";` next to the existing
  `vadSignature`/`threadSignature` initializations.
- `start(modelPath, options)`: **do not** add a language term to the existing no-op guard
  condition (this is the key change from the prior revision — see R1's rationale). Compute
  `nextLanguageSignature` alongside the existing signature computations, and set
  `this.languageSignature = nextLanguageSignature;` at the same point
  `vadSignature`/`threadSignature` are updated — i.e. only on an actual restart, right before
  `this.startupPromise = this._doStart(...)`.
- No change to `_doStart()` — it already threads `options.language` into
  `buildWhisperServerArgs({ ..., language: options.language, ... })`
  (`whisperServer.js:506-514`); R2/R3 just need to actually populate it.
- No change to `onWakeFromSleep()`/`lastStartOptions` capture — unaffected, as in the prior
  revision.
- `transcribe(audioBuffer, options)`: add a new multipart part,
  `Content-Disposition: form-data; name="carry_initial_prompt"` with body `"true"`, added
  immediately after the existing `initialPrompt` block (`~763-771`) and gated the same way
  (only emitted when `initialPrompt` is truthy — mirrors the existing `prompt` field's own
  gating, avoiding a meaningless field when there's no prompt to carry).

### 2. `src/helpers/whisper.js`

- `_runServerTranscription()`: add `language` to the options object passed to
  `this.serverManager.start(modelPath, { ... })` (`whisper.js:312-317`) — unchanged from the
  prior revision, this is the root-cause CLI-arg fix.

### 3. Warm-up call sites (three, same shape) + plumbing — unchanged from prior revision

- `preload.js`: `whisperServerStart: (modelName, language) => ipcRenderer.invoke("whisper-server-start", modelName, language)`.
- `src/types/electron.ts`: update `whisperServerStart`'s type signature to accept an optional `language`.
- `ipcHandlers.js`'s `whisper-server-start` handler: accept and forward the third IPC argument to `this.whisperManager.startServer(modelName, { useCuda, language })`.
- `audioManager.js`'s `warmupTranscriptionEngine()`, `meetingRecordingStore.ts`'s `startRecording()`, `UploadAudioView.tsx`'s `warmupUploadTranscriptionEngine()`: each resolves the same effective language its own real-transcription call already computes, and passes it as the new second argument.
- `parakeetServerStart` call sites are **not** touched.
- Confirmed by a repo-wide grep for `whisperServerStart` this revision: exactly three call
  sites exist (`audioManager.js:672`, `meetingRecordingStore.ts:703`,
  `UploadAudioView.tsx:257`), matching this enumeration — no fourth caller was missed. A
  caller that omitted the new `language` argument would fall back to `undefined` →
  `"auto"` (backward-compatible, not a hard break) if one were ever added later.

### 4. Unload-on-language-change (new)

- `src/hooks/useSettings.ts`:
  - Import `getBaseLanguageCode` from `../utils/languageSupport`.
  - Add `preferredLanguage` to the existing destructure from `store` (the one already feeding
    the `syncStartupPreferences` effect) and to that effect's dependency array.
  - Inside the effect, resolve `const language = getBaseLanguageCode(preferredLanguage);` and
    add `language` to the object passed to `window.electronAPI.syncStartupPreferences({...})`.
    (Leave it `undefined` for `"auto"`/multi-select, same convention `getBaseLanguageCode`
    already uses elsewhere — `getLanguageSignature`'s own `|| "auto"` fallback on the main-process
    side normalizes it, so no double-fallback logic is needed here.)
- `src/types/electron.ts`: add `language?: string;` to the `syncStartupPreferences` prefs type.
- `src/helpers/ipcHandlers.js`'s `sync-startup-preferences` handler: inside the existing
  non-nvidia ("whisper") branch — the same branch containing the current
  `if (currentWhisperModel && currentWhisperModel !== prefs.model)` same-provider
  model-switch-unload check — add a sibling check:
  - `require("./whisperServer").getLanguageSignature` (inline require, matching this handler's
    existing style of inline-requiring `./modelManagerBridge`).
  - Compute `nextLanguageSignature = getLanguageSignature({ language: prefs.language })`.
  - If `this.whisperManager.serverManager?.ready` is true **and**
    `this.whisperManager.serverManager.languageSignature !== nextLanguageSignature`, call
    `this.whisperManager.stopServer().catch((err) => debugLogger.error("Failed to stop
    whisper-server on language change", { error: err.message }));` — and nothing else. No
    `startServer()`/`start()` call follows from this branch.
  - This check is independent of (and additive to) the existing model-mismatch check in the
    same branch — either or both may fire in the same call if both changed together.

### 5. Initial-prompt ordering/cap/carry (new)

- `src/utils/languageSupport.ts`: add `LOCAL_INITIAL_PROMPT_MAX_CHARS = 650` (derivation
  comment per R10) and the two pure functions from R9
  (`combineLocalTranscriptionPrompt`/`combineCloudTranscriptionPrompt`), all exported.
- `src/helpers/audioManager.js`:
  - Live-preview batching path (`~1067-1069`): replace the inline
    `[langHint, dictionaryWords].filter(Boolean).join(" ") || undefined` with a call to
    `combineLocalTranscriptionPrompt(dictionaryWords, langHint)`, using `.prompt || undefined`
    for `initialPrompt`, and logging via `logger.debug("Transcription prompt truncated", {
    originalLength, truncatedLength, maxChars: LOCAL_INITIAL_PROMPT_MAX_CHARS }, "transcription")`
    when `.truncated` is true (mirrors the cloud path's existing log shape).
  - Main local-Whisper path (`~1404-1409`): same replacement/logging for `combinedPrompt`.
  - Cloud path (`~2178-2198`): replace the inline order/truncation logic with
    `combineCloudTranscriptionPrompt(dictionaryPrompt, langHintForApi, MAX_PROMPT_CHARS)`,
    keeping the existing debug-log call, now driven by the helper's returned
    `truncated`/`originalLength`/`truncatedLength` fields instead of locally-computed ones.
    **Revised this revision (Revision 3): this is no longer functionally identical to
    today** — the combined string's order flips from `[langHintForApi, dictionaryPrompt]` to
    `[dictionaryPrompt, langHintForApi]` (dictionary first, hint last — matching the local
    call sites' argument order and combined output exactly), and the truncation direction
    inside the helper flips from keep-front to keep-tail per R12. `MAX_PROMPT_CHARS`'s value
    (890 Groq / 900 others) is passed through unchanged.

### Speed premise compliance (≤500ms raw transcription budget)

- **Revised conclusion for this revision (R1's guard change removes the restart trigger
  entirely, rather than merely keeping it rare)**: since `start()`'s no-op guard has no
  language term, a per-chunk `_runServerTranscription()` → `start()` call inside the
  hotkey-release-to-transcript window **can never restart the server on account of a
  language mismatch** — it no-ops whenever `ready` and model/vad/thread already match,
  full stop, regardless of what language was requested. The scenario the prior revision's R3
  justification was written to prevent (warm-up leaves the server on `auto`, the first
  per-chunk call detects a mismatch, forces a synchronous restart after release) is no longer
  possible under any circumstance, not just rare — there is no code path left that restarts
  for language reasons inside that window.
- **Honest residual risk, named rather than glossed over**: R7's `stopServer()` call (fired
  from a Settings-page `useEffect`, not from the recording path) is fire-and-forget/async. If a
  user changes the language setting and starts dictating before that stop completes, the
  warm-up's `start()` call could run first, see the old server still `ready` (language isn't
  checked), and no-op against it — leaving the stale-language server briefly still loaded. In
  that narrow race, correctness is still preserved (the per-request `language` field, confirmed
  always-correct per Problem/Goal, overrides the CLI default on every transcribe call
  regardless of which process happens to be running) — the only cost is a stale CLI default
  persisting a bit longer than ideal, never an incorrect transcript and never a
  restart-inside-the-window. In practice the human gap between changing a Settings-page
  dropdown and pressing the dictation hotkey is expected to dwarf the time a `stop()` takes, so
  this is expected to be rare in practice, not just theoretically bounded.
- **Alternative not taken, flagged for the project owner's awareness**: a guard-term restart
  (the prior revision's design) would have closed this specific race for free, at the cost of
  reintroducing a possible — if rare — restart inside the hotkey-release window whenever the
  race is actually hit. This spec follows the owner's explicit "only unload it" instruction
  literally and does not add the guard term; if the residual race above is judged worse than an
  occasional guarded restart, that would be a one-line design change to reconsider (add the
  language term back into the guard) — not raised as blocking, since the literal instruction
  points this way and the race's real-world impact is expected to be small.

## Validation Plan

### Automated

- **`test/helpers/whisperServerVadArgs.test.js`** (extend existing file):
  - `getLanguageSignature({})` / `{ language: undefined }` → `"language:auto"`;
    `{ language: "en" }` → `"language:en"`; differs from `{ language: "pt" }`.
  - Extend `buildWhisperServerArgs` assertions across representative option permutations to
    assert the returned args array never contains `"--translate"`/`"-tr"` (R6).

- **`test/helpers/whisperServer.test.js`** (extend existing file, same
  `loadWhisperServerManager({ userDataDir, spawn: fakeSpawn })` fixture):
  - "start() still no-ops (no restart) when nothing changed, including language" — call
    `start()` twice with identical options (including the same `language`); `spawnCount`
    stays `1`.
  - **New/replacing the prior revision's "restarts when only language changes" test**: "start()
    does *not* restart merely because `language` differs from a previous call, when the server
    is still `ready`" — start once with `{ language: "en" }` (`spawnCount === 1`), call `start()`
    again with identical `modelPath`/vad/threads but `{ language: "pt" }`; assert `spawnCount`
    stays `1` (confirms the guard was deliberately *not* given a language term — R1) — this
    replaces the prior revision's now-superseded "restarts on language change" test.
  - "transcribe()'s multipart body includes `carry_initial_prompt=true` whenever `initialPrompt`
    is supplied, and omits the field entirely when it isn't" (R13) — stub
    `manager._doTranscribeRequest` to capture `body`, set `manager.ready = true` /
    `manager.canConvert = true`, supply a minimal valid WAV buffer; call `transcribe()` once
    with `{ language: "en", initialPrompt: "test" }` (assert body contains
    `name="carry_initial_prompt"` and `true`) and once with `{ language: "en" }` (no
    `initialPrompt`, assert the field is absent).
  - "transcribe()'s multipart request body never includes a translate field regardless of
    options" (R6) — same fixture/shape as before.

- **New/extended `test/helpers/syncStartupPreferencesLanguageSwitch.test.js`** (mirrors
  `syncStartupPreferencesModelSwitch.test.js`'s exact `loadHandler`/fake-`ipcMain` fixture; the
  fake `whisperManager` fixture gains a `serverManager: { ready, languageSignature }`
  sub-object):
  - "stops the Whisper server when only the effective language changes (model unchanged,
    server currently ready)" — `serverManager: { ready: true, languageSignature: "language:en" }`,
    call with `{ useLocalWhisper: true, localTranscriptionProvider: "whisper", model: <same>,
    language: "pt" }`; assert `stopServer` called exactly once. Unlike the prior revision's
    version of this test, give the fake `whisperManager` a real `startServer` spy (e.g.
    `startServer: async (...args) => { startCalls.push(args); }`) so the assertion isn't
    vacuously true against a fixture that simply lacks the method — assert
    `startCalls.length === 0` to actually prove no reload happens as a direct consequence of
    this handler call.
  - "does not stop Whisper when the language is unchanged" — matching `languageSignature` →
    zero `stopServer` calls.
  - "does not stop Whisper when no server is currently running" (`ready: false`) — zero
    `stopServer` calls regardless of language difference.
  - "does not touch Parakeet when only the language changes under the nvidia provider" —
    confirms the Non-goals boundary (Parakeet untouched).

- **`test/helpers/audioManagerWarmup.test.js`** (extend existing file — its current assertions
  break once `whisperServerStart` gains a second argument): update the `calls.push([...])`
  assertions in the existing "warms the Whisper server..." tests to include the resolved
  `language` argument (e.g. `["whisper", "base", undefined]` when no `preferredLanguage` is set
  in the test's settings object, and a non-`undefined` value in a new test case that does set
  `preferredLanguage: "pt"`).

- **New file `test/components/languageSupport.test.js`** (R4, R9, R10 — TS/ESM source, no prior
  coverage; runs via the tsx-registered `test/components/*.test.js` bucket):
  - `getBaseLanguageCode()`: `"auto"` → `undefined`; multi-language (`"en,pt"`) → `undefined`;
    single (`"en"`) → `"en"`; regional (`"pt-BR"`) → `"pt"`.
  - `getMultiLanguagePromptHint()`: `""` for `"auto"`/single/empty/`null`; non-empty hint
    (containing both language labels) for 2+ comma-separated selection.
  - `combineLocalTranscriptionPrompt()`: short inputs → `dictionary + " " + hint` order,
    `truncated: false`; a combined string exceeding `LOCAL_INITIAL_PROMPT_MAX_CHARS` (e.g. a
    very long synthetic dictionary + a short hint) → `truncated: true`, the returned `prompt`
    ends with the hint text intact (proves the front, not the tail, was dropped), and
    `truncatedLength <= LOCAL_INITIAL_PROMPT_MAX_CHARS`.
  - `combineCloudTranscriptionPrompt()` (**revised this revision — assertions inverted from
    the superseded R12 draft to match the corrected, unified direction**): short inputs →
    `dictionary + " " + hint` order (matching `combineLocalTranscriptionPrompt()`'s order
    exactly), `truncated: false`; a combined string exceeding a test-supplied `maxChars` (a
    long synthetic comma-separated dictionary + a short hint, mirroring the local test's
    shape) → `truncated: true`, the returned `prompt` **ends with the hint text intact** (tail
    preserved, front dropped — the discriminating assertion proving the direction actually
    flipped, mirroring the local test rather than the old front-preserving cloud assertion),
    and `truncatedLength <= maxChars`.
  - **New test, boundary-finding (R12)**: construct a synthetic dictionary of many short
    comma-separated entries (e.g. `"word1, word2, word3, ..."`) long enough that the combined
    prompt exceeds `maxChars` well past at least one comma inside the kept tail, plus a short
    hint. Assert the returned `prompt` does not begin mid-entry — it either begins immediately
    after a comma+space boundary (i.e. does not start with a partial word fragment matching
    the tail end of some earlier entry) or, for a case with no comma inside the kept tail
    (e.g. one very long single entry with no commas at all), begins immediately after the
    first whitespace character instead. Also assert the hint is never truncated by
    constructing a case where `maxChars` is deliberately set smaller than the dictionary alone
    but still larger than the hint, and confirming the returned `prompt`'s suffix exactly
    equals the hint string.
  - `LOCAL_INITIAL_PROMPT_MAX_CHARS` equals `650`.

### Manual

1. In Settings → Speech-to-Text, set Language to a specific non-English language (e.g.
   Portuguese) with local Whisper enabled. Dictate a short phrase in that language; confirm
   the pasted transcript is transcribed as that language. This exercises the real vendored
   `whisper-server` binary's actual behavior, not fully verifiable from source alone.
2. With `--log-level=debug` running, switch the language setting to a different language while
   the app is open (no dictation in progress). Confirm the debug log shows the whisper-server
   process being stopped shortly after the switch, and confirm **no** new "Starting
   whisper-server" log line appears until the next dictation hotkey press (proves unload-only,
   no proactive reload — this is the R7 regression the fix targets).
3. Immediately after step 2's unload, press the dictation hotkey and dictate; confirm the
   server cold-starts with `--language <new-language>` in its args (visible in the debug log's
   "Starting whisper-server" args) and the new language takes effect on this very next
   dictation.
4. Dictate twice in a row without changing the language setting between them; confirm the
   whisper-server process is not needlessly restarted between the two (only one "Starting
   whisper-server" line).
5. Select 2+ languages in the multi-select language setting; dictate; confirm transcription
   still works via auto-detection.
6. With a long custom dictionary (30+ entries) and a non-`"auto"` non-English language
   selected, dictate a short phrase; with debug logging on, confirm the debug log shows the
   combined initial prompt with the language hint positioned after the dictionary text (not
   before), and — if the combined length exceeds ~650 characters — a "Transcription prompt
   truncated" debug line from the local path (previously only the cloud path logged this).
7. **New this revision (R12).** Switch to cloud transcription (OpenAI or Groq configured),
   set the same long custom dictionary (30+ entries, enough to exceed 890/900 chars combined
   with the hint) and a non-`"auto"` non-English language, dictate a short phrase; with debug
   logging on, confirm the debug log's "Transcription prompt truncated" line for the cloud
   path fires with the expected `originalLength`/`truncatedLength`/`maxChars` fields, and
   confirm the transcription still succeeds (the cloud API accepts the request — proves the
   reordering/truncation-direction change didn't introduce a malformed request). Note: this
   log only carries lengths, not the prompt text itself, so it cannot visually confirm
   ordering (dictionary-then-hint vs. the old hint-then-dictionary) — that proof is the
   automated `combineCloudTranscriptionPrompt()` test above (asserting the returned `prompt`
   ends with the intact hint), not something observable from this manual step.

### Docs

- **CLAUDE.md §18** (On-Demand Model Lifecycle): note that a language-setting change is now a
  third trigger (alongside model/provider switch) for the existing "unload immediately, reload
  only lazily" `sync-startup-preferences` behavior, and that warm-up call sites thread the
  resolved language for the reasons above.
- **CLAUDE.md §19** / wherever `initialPrompt` construction is described (currently not
  documented in CLAUDE.md at file level beyond the batching mechanism) — consider a short note
  under "Custom Dictionary" (§13) pointing at the new ordering/cap/`carry_initial_prompt`
  behavior, since §13 already documents how the dictionary becomes a Whisper `prompt`.
- **`docs/specs/on-demand-model-lifecycle.md`**: update to note the language-change trigger
  added to `sync-startup-preferences`.
- **`docs/RECREATION_SPEC.md`**: update §0 (or wherever local Whisper's language handling is
  described) to reflect the corrected CLI flag, the unload-on-language-change behavior, and the
  initial-prompt changes.

## Open Questions

- Does `ParakeetWsServer` have an equivalent CLI-vs-per-request language gap, and should it
  also get an unload-on-language-change trigger? Not investigated as part of this spec — worth
  a follow-up spec if confirmed to matter.
- Whether the *exact* vendored `whisper-server` binary this app currently ships/downloads
  (fork version unpinned in this worktree) includes the `carry_initial_prompt` field
  (`server.cpp:572-574` in the traced fork source) cannot be confirmed against the actual
  shipped binary from this environment — R13's design already treats an older binary silently
  ignoring the unknown field as acceptable graceful degradation, but only manual validation
  step 6 above can confirm the field is actually honored end-to-end on real hardware.
- **New this revision (R12).** Groq's own docs (`console.groq.com/docs/speech-to-text`,
  fetched live via `curl` this revision) confirm the identical `224`-token prompt ceiling as
  OpenAI's documented behavior, but — unlike OpenAI's docs, which explicitly state "considers
  the final 224 tokens... ignores anything earlier" — Groq's docs do not explicitly state
  which end of an over-length prompt gets dropped. This spec's design treats Groq (and any
  other OpenAI-compatible "custom" endpoint reachable via this same formData path) as
  behaving identically to OpenAI's documented keep-tail direction, on the reasoning that all
  three run the same underlying Whisper model weights/architecture and any faithful
  implementation must replicate the reference implementation's keep-tail prompt-slicing to
  produce coherent output — a high-confidence architectural inference, not a directly-cited
  fact for Groq specifically. If a future investigation finds Groq (or a specific "custom"
  self-hosted server) genuinely truncates front-preserving instead, the blanket unification in
  R12 would need to become a per-provider-aware branch instead — flagged here as the condition
  under which this decision should be revisited, not treated as blocking today.

## Revision Notes

- **Revision 3 (this revision)**: surgically revisits Revision 2's one deliberate asymmetry —
  "cloud path left unreordered, hint-first" — per explicit project-owner direction to force
  both paths to match. Verified live via `curl` this revision (not assumed): OpenAI's docs
  (`platform.openai.com/docs/guides/speech-to-text`) state the `whisper-1` model "only
  considers the final 224 tokens of the prompt and ignores anything earlier" — confirming the
  hosted API keeps the tail/drops the front, the same direction and ~224-token ceiling already
  source-verified for the bundled whisper.cpp fork in Revision 2. Groq's docs
  (`console.groq.com/docs/speech-to-text`) independently confirm the identical 224-token
  ceiling for their `prompt` parameter but don't explicitly document the truncation direction
  — treated as high-confidence-by-architecture (same model weights), not directly cited,
  and flagged as a new Open Question in case a future finding contradicts it. Conclusion:
  the app's own cloud-side truncation (`slice(0, MAX_PROMPT_CHARS)`, keep-front) was itself
  truncating in the wrong direction relative to how the real API re-truncates downstream, so
  this is a principled unification, not a cosmetic reorder — `combineCloudTranscriptionPrompt()`
  (R9, R12) now shares `combineLocalTranscriptionPrompt()`'s order (dictionary-then-hint) and
  keep-tail truncation principle, applying to every provider reachable via the shared
  formData/multipart path (OpenAI, Groq, self-hosted/"custom"; Mistral/xAI are proxied
  separately and untouched). `MAX_PROMPT_CHARS`'s numeric value (890/900) is unchanged — an
  orthogonal Groq hard-rejection-avoidance constraint, not a proxy for the 224-token concern.
  Updated: TL;DR, R9's cloud sub-bullet, R12 (rewritten), the Non-goals cloud-truncation
  bullet, Design §5's cloud-path bullet, the Validation Plan's cloud helper test (assertions
  inverted) plus a new boundary-finding regression test, a new manual validation step (7), and
  Open Questions (new Groq-direction-confidence item). No other requirement (R1-R8, R10, R11,
  R13), the unload-only design, or the Speed-premise section were touched.
- **Revision 2**: (a) reframed the CLI `--language` bug's real-world impact
  after verifying from the bundled fork's source that the per-request field already overrides
  the CLI default unconditionally; (b) replaced the planned auto-restart-on-language-mismatch
  inside `start()`'s no-op guard with an explicit, product-owner-directed unload-only design
  piggybacking on the existing `sync-startup-preferences` model/provider-switch-unload
  mechanism (R7, new); (c) folded in a new, related scope: `initialPrompt`
  ordering/truncation-direction/cap fixes for the local path, a deliberate non-reorder + first
  regression test for the already-correct cloud path, and enabling `carry_initial_prompt` on
  every per-request call with an initial prompt (R9-R13, new); (d) corrected R3's justification
  and the Speed premise section, which had carried over a stale "restart-prevention" rationale
  from the superseded guard-term design — the honest justification is the owner's explicit
  instruction plus warm-up-path CLI-flag correctness, not a Speed-budget requirement, and a
  small residual async-unload/warm-up race is now named explicitly rather than glossed over;
  (e) strengthened the R7 "no auto-reload" regression test to assert against a real
  `startServer` spy rather than a fixture that simply lacks the method; (f) confirmed by grep
  that exactly three `whisperServerStart` call sites exist, matching R3's enumeration.
- **Revision 1**: initial draft — CLI `--language` plumbing fix (R1-R6), original
  (now-superseded) auto-restart-on-language-change design.
