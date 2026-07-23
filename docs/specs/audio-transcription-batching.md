# Dictation Audio Transcription: Progressive VAD Batching with Confidence-Gated Retry

## Status
Implemented

## TL;DR

- Local Dictation transcription gets one shared, engine-agnostic mechanism for both Whisper and
  Parakeet: progressive VAD-chunked transcription during recording, confidence-gated per chunk,
  with bounded merge-and-retry on low confidence, falling back to a single full-clip
  re-transcription only when the whole session's aggregate quality is poor. This generalizes a
  mechanism that already exists today for Whisper only, behind an opt-in "preview" toggle
  (`showTranscriptionPreview`), to be the *default, always-on* Dictation behavior for both engines.
- **Resolved decision (project owner, 2026-07-20)**: the three shipped Parakeet models with
  `runtime: "online"` (`nemotron-speech-streaming-en-0.6b`, `nemotron-3.5-asr-streaming-0.6b`,
  `nemotron-3.5-asr-streaming-0.6b-1120ms`) — which have no offline/batch sherpa-onnx execution
  path and were the spec's one blocking open question — are **removed from the product entirely**
  (Option A). There is now exactly **one** unified batching/quality mechanism across all local
  engines, with no per-model streaming exception anywhere.
- Concrete decisions:
  - The three online-runtime models are deleted from `modelRegistryData.json`, Settings UI, and
    `download-sherpa-onnx.js`. Existing users on one of these models are migrated on next launch to
    `parakeet-tdt-0.6b-v3` (both the main-process `.env`/`PARAKEET_MODEL` copy and the renderer's
    `localStorage` copies) — no user data is lost, per CLAUDE.md's Migration Safety premise.
  - `parakeetStreamingBeta` (setting + UI toggle) is removed, as already planned.
  - Since no model in the product can ever have `runtime: "online"` again, the underlying
    `sherpa-onnx-online-websocket-server` binary, its download-script entries, and
    `ParakeetWsServer.createOnlineStream()`/`_transcribeOnline()` are now dead code with zero
    remaining callers (Dictation, Meeting, and Upload all route through the same
    `ParakeetWsServer.transcribe()`) — this spec now removes them too, not just the Dictation
    preview call site.
  - The former scope-boundary carve-out (Design §6, old Non-goals bullet "true streaming is not
    removed") is deleted — it no longer applies to anything.
- No blocking open questions remain. This spec is ready for the project owner to review and flip
  `Status` to `Approved`.
- Practical impact: users see faster, higher-quality Dictation pasting for both Whisper and
  Parakeet by default (no toggle needed); the three ultra-low-latency streaming Parakeet models are
  no longer selectable (a real, acknowledged product-surface reduction, accepted by the project
  owner in favor of one consistent, quality-first mechanism); any user previously on one of those
  three models is auto-migrated to `parakeet-tdt-0.6b-v3` transparently on upgrade.

## Problem / Goal

The project owner's stated priority driving every decision in this spec: **"My focus is extreme
transcription quality."** Streaming (sherpa-onnx's online/streaming WS mode, or any true
incremental-encoder mode) was explicitly rejected for any engine because it keeps internal decoder
state across chunks — incompatible with a mechanism that needs to recombine and resend raw audio
for a redo. Instead: **progressive batch transcription during recording, confidence-gated, with a
bounded merge-and-retry policy**, falling back to a single full-clip transcription only when the
progressive path can't reach acceptable confidence.

Today, Dictation's *pasted* transcript is produced by exactly one full-clip inference call at
hotkey release (`AudioManager.processWithLocalWhisper()` / `processWithLocalParakeet()` in
`src/helpers/audioManager.js`, via the `transcribe-local-whisper` / `transcribe-local-parakeet` IPC
handlers). Latency for that call scales with recording length, which is fundamentally at odds with
CLAUDE.md's Non-Negotiable Product Premise §3 ("Speed — sub-500ms raw transcription": hotkey
release → raw transcript ≤500ms for the default/fast engines) for anything longer than a very
short utterance.

**Critical research finding: most of this mechanism already exists in the codebase today — as an
opt-in, off-by-default "preview" feature, not as the load-bearing Dictation path.** Both
`showTranscriptionPreview` and `parakeetStreamingBeta` (`src/stores/settingsStore.ts`) default to
`false`. When `showTranscriptionPreview` is on, `src/helpers/whisperStreamingSession.js`
(`WhisperVadStreamingSession`) already does almost exactly what's being asked for **Whisper**:
segments live PCM by silence (energy-RMS VAD with adaptive noise floor, pure JS, no Electron/engine
dependency), transcribes each closed utterance exactly once, and — if `isLowQuality` (driven by
whisper.cpp's `avg_logprob`/`compression_ratio`/`no_speech_prob`) rejects a chunk — holds its audio
and merges it into the next utterance for a retry, bounded by `maxMerges=2`/`maxMergedMs=20000`.
At hotkey release (`stop-dictation-preview` in `src/helpers/ipcHandlers.js`), the session's
`finish()` flushes the last open utterance and the whole session's committed transcript is handed
back as `streamingText` **only if** `finalized && lowQualityRatio <= 0.5 && coverageRatio >= 0.4`
— otherwise the renderer (`AudioManager._resolveStreamingWhisperText`) falls back to a full
offline re-transcription of the whole clip. This is precisely decision #2's "most audio is
pre-transcribed by release time, fall back to full-audio only when quality is low" — just gated
behind a cosmetic UI toggle instead of being the default mechanism.

**Parakeet, however, does not have the equivalent mechanism today**, and there is a second, more
consequential problem this spec must resolve rather than hide:

1. **Parakeet's non-streaming ("offline") preview path is a dumb fixed-3-second timer** that
   re-transcribes the *entire accumulated buffer* every cycle (capped at 14s to avoid crossing
   `parakeetServer.js`'s 15s single-segment limit) — no VAD chunking, no confidence gating, no
   merge/retry. It does not produce a `streamingText` fast path at all; Parakeet dictation always
   pays the full offline re-transcription cost at release (unless the beta streaming path below is
   used).
2. **Parakeet's `parakeetStreamingBeta` toggle uses `ParakeetWsServer.createOnlineStream()`** —
   genuine sherpa-onnx online/streaming decoding — which is exactly the mechanism decision #1
   rejects. This is the piece of existing code most directly in conflict with the confirmed
   decisions and must be retired from the Dictation preview/fast-path call site
   (`ipcHandlers.js`'s `start-dictation-preview` handler, `provider === "nvidia" && streamingBeta`
   branch, and `AudioManager._resolveStreamingParakeetText`).

**A second, load-bearing research finding that changes the scope of decision #1 and must be
surfaced, not silently resolved:** `ParakeetWsServer.transcribe()` (the *general-purpose* entry
point used for every Parakeet transcription request anywhere in the app — final Dictation, Meeting,
Upload, not just the preview beta) unconditionally routes to `_transcribeOnline()` /
`createOnlineStream()` whenever the currently-loaded model's registry `runtime` is `"online"`
(`src/helpers/parakeetModelInfo.js: getModelRuntime()`). Three shipped, currently-selectable models
in `src/models/modelRegistryData.json` are `runtime: "online"`: `nemotron-speech-streaming-en-0.6b`,
`nemotron-3.5-asr-streaming-0.6b`, and `nemotron-3.5-asr-streaming-0.6b-1120ms`. Their
encoder/decoder/joiner ONNX graphs are exported for sherpa-onnx's *online* (streaming, causal,
chunked-state) runtime — there is no offline-websocket-server binary or model export that can serve
them; "no true streaming, ever" cannot be honored for these three specific models without removing
support for them from the product. That was a different, larger, and separate decision from "prefer
batching over streaming as the Dictation speed mechanism," which this spec could not make
unilaterally — it was escalated to the project owner as Open Question #1, with three options laid
out in Design §12. **The project owner has now resolved it directly: Option A — drop the three
models from the product entirely.** See Design §12/§13 and Open Questions #1 (resolved) for the
decision record and its implementation design.

## Requirements

1. **A single shared batching/confidence mechanism for both engines — this is the central, resolved
   decision this spec exists to implement, restated in the project owner's own words: "Let's keep a
   single logic — the same one already applied to the OpenAI [local Whisper] models."** Whisper and
   Parakeet dictation both go through the same VAD-segmentation → per-chunk transcribe →
   confidence-gate → commit-or-merge-and-retry pipeline, via one shared, engine-agnostic module,
   with **no per-model or per-engine exception** (this supersedes the earlier draft's carve-out for
   `runtime: "online"` Parakeet models — see Requirement 9 and Open Questions #1). The only
   engine-specific code permitted is the confidence-signal-extraction (Requirement 3) and the raw
   `transcribe(pcmChunk)` call each engine already exposes.
2. **Progressive, VAD-chunked transcription during recording, not fixed-interval polling of a
   growing buffer.** Replace Parakeet's fixed-3-second-timer/growing-buffer preview mechanism with
   the same energy-RMS VAD segmentation Whisper's preview already uses (Design §1 explains why this
   JS-level VAD, not either engine's own native VAD support, is the right layer for both engines).
3. **Confidence-gated per-chunk validation**, using the best signal each engine can actually supply
   (Design §2 documents exactly what was found, per engine):
   - Whisper: reuse whisper.cpp's real `avg_logprob`/`compression_ratio`/`no_speech_prob` fields
     (already parsed today, already used for exactly this purpose).
   - Parakeet (offline-runtime only): no native confidence field exists in the vendored
     sherpa-onnx offline-websocket-server JSON protocol (confirmed: `parseOfflineMessage()` /
     `createOnlineAccumulator()` in `src/helpers/parakeetWsResult.js` only ever read `text` /
     `is_final` / `segment`). Use a text-derived heuristic instead — explicitly flagged as a
     deviation from the ideal, not silently substituted: a zlib-based compression-ratio computed
     directly on the returned text (the same technique whisper.cpp itself uses to derive
     `compression_ratio` — it is text-only, not a decoder-internal signal, so it transfers to any
     engine's output), reuse of the existing engine-agnostic hallucination-pattern detector
     (`WhisperManager.isHallucinatedText`, itself already pure text logic despite living on
     `whisperManager`), and the existing RMS/silence gates (`minSegmentRms` in the shared VAD
     session, `SILENCE_RMS_THRESHOLD`/`computeFloat32RMS` in `parakeetServer.js`) standing in for
     Whisper's `no_speech_prob`.
4. **Bounded merge-and-retry on low confidence.** A low-confidence chunk's raw audio is combined
   with the *preceding* chunk's raw audio and resent for retranscription, repeating until
   confidence is acceptable or a bound is hit — reusing the existing, already-implemented
   `maxMerges`/`maxMergedMs` caps unchanged. Additionally, add a new elapsed-wall-clock-time budget
   that applies specifically to the finalization of the *last, still-open* chunk at hotkey release
   (Design §4) so a stubborn low-confidence tail can't blow through the Speed premise even though
   it's still within `maxMerges`/`maxMergedMs`.
5. **Full-audio fallback only as the last resort**, gated on the whole session's aggregate quality
   (reusing the already-implemented `lowQualityRatio`/`coverageRatio` thresholds), not on any single
   chunk's retry budget expiring — see Design §4 for why these are deliberately different triggers.
6. **The mechanism is the default, always-on behavior for eligible local Dictation, not an opt-in
   preview toggle.** `showTranscriptionPreview` becomes purely a "show the live caption overlay
   window" toggle; it no longer gates whether the progressive batching pipeline itself runs.
7. **Retire the Parakeet online-streaming beta path from Dictation** (`parakeetStreamingBeta`
   setting, its Settings UI toggle, `createOnlineStream()`/`_transcribeOnline()` call sites reached
   from the dictation-preview handlers). Strengthened by the resolved decision: this is no longer a
   narrow call-site retirement leaving the underlying online-runtime models and primitives in place
   — see Requirement 9.
8. **Regression tests proving, at minimum:**
   a. VAD-based chunk boundary detection produces reasonable segment splits on a sample audio
      fixture.
   b. A low-confidence chunk triggers exactly one merge-with-previous-and-retry, and the retry cap
      (`maxMerges`) is respected — it never loops forever.
   c. The full-audio fallback triggers correctly when the progressive mechanism can't reach
      acceptable confidence within budget (aggregate `lowQualityRatio`/`coverageRatio` gate).
   d. Both Whisper and offline-runtime Parakeet go through the identical batching module and
      code path — no per-engine special-casing beyond the confidence-signal-extraction functions.
9. **[New, per resolved Option A decision] Remove the three `runtime: "online"` Parakeet models and
   their now-dead-code primitives entirely** — not just exclude them from the new mechanism:
   - Delete `nemotron-speech-streaming-en-0.6b`, `nemotron-3.5-asr-streaming-0.6b`, and
     `nemotron-3.5-asr-streaming-0.6b-1120ms` from `src/models/modelRegistryData.json`'s
     `localProviders` Parakeet list, so they no longer appear in the Settings model dropdown.
   - In `scripts/download-sherpa-onnx.js`, delete the `onlineBinaryPath`/`onlineOutputName`
     properties from all 6 per-platform config objects (`BINARIES`'s 4 platform entries and
     `CUDA_BINARIES`'s 2 entries) — these are already optional, falsy-guarded properties (the same
     pattern as `diarizeBinaryPath`/`diarizeOutputName` for platforms without a diarization binary),
     so deleting them is sufficient; `downloadBinary()`'s "Online WebSocket server" extraction block
     (gated on `config.onlineBinaryPath && onlineOutputPath`) then never runs and can be deleted too.
   - Remove the now-uncallable primitives in `ParakeetWsServer`
     (`src/helpers/parakeetWsServer.js`) **by symbol, not line number** (line numbers drift on the
     next unrelated edit to this file — a prior draft of this requirement cited specific lines that
     turned out to be wrong, e.g. attributing a line inside `isCudaBinaryAvailable()` to
     `getWsBinaryPath()`): `createOnlineStream()`, `_transcribeOnline()`, and `_warmUpOnline()` in
     full; the `runtime === "online"` / `modelRuntime === "online"` branches inside
     `getWsBinaryPath()`, `isCudaBinaryAvailable()`, `_doStart()` (both its launch-args branch and
     its `_warmUp()`-vs-`_warmUpOnline()` dispatch), `transcribe()`, and `hasAnyWsBinary()`; and every
     module-level constant/import whose only remaining consumer is one of the above (at minimum
     `TAIL_SILENCE`, `ONLINE_CHUNK_BYTES`, `ONLINE_FINISH_TIMEOUT_MS`, and the `createOnlineAccumulator`
     import from `parakeetWsResult.js` — `createOnlineAccumulator`'s export there becomes unused too
     and should be dropped in the same pass, verified by grepping for its remaining callers first).
     Also remove `parakeet.js`'s `supportsOnlineStreaming()` and the `sherpa-onnx-online-ws-` fragment
     from the `parakeet` array in `sidecarReaper.js`'s `EXPECTED_BINARY_FRAGMENTS`.
     **Verification step, not just a list to follow**: after removal, grep
     `parakeetWsServer.js` (and `parakeetWsResult.js`) for `online`/`Online` — anything the grep still
     turns up is either a deliberate remnant (e.g. the `modelRuntime` field itself, which stays a
     general two-value field even though only `"offline"` is reachable now) or something this list
     missed. This matters because standard lint/typecheck does **not** flag unused class methods, so
     an orphaned `_warmUpOnline()`-style leftover would silently pass `pr-reviewer`'s automated gates
     without this explicit check.
   - Confirmed via Grep (this spec's own research, Design §11/§13): Dictation, Meeting, and Upload all
     call the same `ParakeetWsServer.transcribe()`, which — once no model can ever have
     `runtime: "online"` — simplifies to always route through `_transcribeOffline()`; there is no
     remaining caller of the online-path primitives anywhere in the app. See Design §13 for the full
     removal/migration design.
10. **[New, per resolved Option A decision] Migrate existing users off the removed model IDs with no
    data loss**, per CLAUDE.md's Migration Safety premise — see Design §13 and Requirement 9's
    detail. This is not optional cleanup; it is a hard requirement because real users may currently
    be persisted on one of the three removed model IDs in both the main-process `.env` and the
    renderer's `localStorage`.

## Non-goals

- **~~True streaming for the three `runtime: "online"` Parakeet models is not removed.~~ Superseded
  by the resolved Option A decision**: the three models are removed from the product entirely (see
  Requirement 9, Design §13, Open Questions #1), so there is no remaining streaming exception to
  preserve.
- **~~Removing the `sherpa-onnx-online-websocket-server` binary, its download-script entries, or
  `ParakeetWsServer.createOnlineStream()`/`_transcribeOnline()` as low-level primitives.~~ Superseded
  by the resolved Option A decision**: this spec now *does* remove these primitives, since Option A
  leaves them with zero remaining callers anywhere in the app (Dictation, Meeting, and Upload all
  route through the same `ParakeetWsServer.transcribe()`). See Requirement 9 and Design §13.
- **Option C (routing the three online models' VAD-chunked/merge-retry calls through independent,
  state-free `_transcribeOnline()` invocations per chunk, so they gain the new mechanism without
  true streaming) is not adopted.** It was a technically-feasible alternative (Design §12) but is
  mooted by removing the models entirely — there's nothing left to route.
- **Meeting transcription and Upload transcription are out of scope.** Meeting already has its own,
  separate confidence-gated chunk pipeline (`NO_SPEECH_THRESHOLD` segment filtering,
  `avg_logprob`/`compression_ratio` merge-once logic around `ipcHandlers.js:5230-6500`) built for a
  continuous-conversation shape rather than a single hotkey press/release, and this spec does not
  redesign it. The new shared quality-heuristic module (Design §2) is written so a future spec could
  reuse it there, but doing so is not part of this spec.
- **Cloud/BYOK/self-hosted (`lan`) Dictation transcription is unaffected** — this mechanism only
  applies when `useLocalWhisper === true` and the active local engine/model combination is eligible
  (Whisper, or Parakeet with an offline-runtime model). Consistent with
  `docs/specs/transcription-engine-lifecycle.md`'s existing scope boundary.
- **No change to whisper-server's own native `--vad --vad-model` (Silero) flag**, used today by the
  full-audio-fallback call and by Meeting/Upload. That is a different layer (server-side
  segmentation of one big `/inference` call) from the JS-side pre-chunking this spec is about — see
  Design §1 for why both exist and neither replaces the other.
- **Custom dictionary / auto-learn handling** is fully out of scope, per
  `docs/specs/text-monitor-final-text-only.md` — no changes here duplicate that spec's territory.
  The `initialPrompt` (dictionary hint words) is still passed to every per-chunk transcribe call
  exactly as it is today.
- **No new persisted setting is introduced to turn the batching mechanism on/off.** It is inherent
  to using local Whisper or offline-runtime Parakeet for Dictation, matching decision #6's framing
  that this is the new baseline mechanism, not a feature to opt into.

## Design

### 1. Two different "VAD" layers in this codebase — which one does the chunking, and why

There are two unrelated VAD mechanisms already in the code, and this spec only touches one of them:

- **whisper-server's own native Silero VAD** (`--vad --vad-model`, `buildWhisperServerArgs()` in
  `src/helpers/whisperServer.js`) segments audio *inside a single `/inference` HTTP call* and
  returns multiple `segments[]` in one JSON response. This is what the full-audio-fallback call
  (and Meeting/Upload) already use via `_resolveWhisperVadOptions("dictation")`. Parakeet's WS
  server args (`parakeetWsServer.js: _doStart()`) have **no VAD flag at all** — confirmed by reading
  the actual spawn arguments (`--tokens`, `--encoder`, `--decoder`, `--joiner`, `--port`,
  `--num-threads`/`--num-work-threads`, `--provider`). There is no engine-level VAD to lean on for
  Parakeet.
- **The pure-JS energy-RMS VAD already in `whisperStreamingSession.js`** decides, client-side in the
  main process (fed live PCM16 from the renderer), *when to close an utterance and send it as its
  own single-chunk `/inference` or WS call*. It has zero whisper-specific code in its actual
  mechanics (frame RMS, adaptive noise floor, pre-roll, silence-triggered flush, merge-on-low-
  -quality) — the "Whisper" in its name reflects only that it was first wired up for Whisper's
  preview, not that its segmentation logic is Whisper-specific.

Since Parakeet has no native VAD to reuse, and the existing JS VAD is already engine-agnostic in
practice, **the answer to "should VAD happen at the shared app/pipeline level" is yes, and it
already does for Whisper — this spec generalizes the same JS-level VAD to Parakeet** rather than
inventing a second chunking mechanism. This directly satisfies Requirement 2.

> **Superseded note**: at the time this spec was implemented, the JS energy-RMS VAD's
> `minSpeechDurationMs`/`minSilenceDurationMs` (and other fields) were sourced from
> `_resolveWhisperVadOptions("dictation")` — i.e. borrowed from the Silero VAD settings
> described above. `docs/specs/live-preview-vad-sensitivity.md` (implemented) replaced this
> with a separate, independent, user-visible "Live Preview Sensitivity" settings namespace;
> the energy-RMS VAD no longer reads any Silero-sourced value for any field. See that spec
> for the current, correct config-sourcing design.

### 2. Confidence signal per engine — what was actually found

- **Whisper**: `whisperServer.js: transcribe()` already requests `response_format=verbose_json`
  when `options.verboseJson` is set, and whisper.cpp's server (vendored from `OpenWhispr/whisper.cpp`
  via `scripts/download-whisper-cpp.js`) returns per-segment `avg_logprob`, `compression_ratio`, and
  `no_speech_prob` in that mode — already consumed today by `summarizeWhisperQuality()` /
  `isWhisperSegmentLowQuality()` (currently inlined in `ipcHandlers.js`, thresholds
  `avg_logprob < -1.0` / `compression_ratio > 2.4`, the classic whisper decode-failure thresholds).
  **No further engine-side investigation is needed here — the signal is real, already wired, and
  already used for exactly this purpose.** This spec only relocates/generalizes the existing logic
  (see §3) so it can sit next to Parakeet's equivalent in one shared module.
- **Parakeet (offline-runtime)**: `parakeetWsServer.js: _transcribeOffline()` sends
  `[int32 sample_rate][int32 byte_length][float32 samples]` over the offline-websocket-server
  binary's documented binary protocol and gets back one JSON message per utterance, parsed by
  `parseOfflineMessage()` in `src/helpers/parakeetWsResult.js` — which only ever reads a `text`
  field. Tracing every consumer of that JSON in this codebase (`parakeetWsResult.js`,
  `parakeetWsServer.js`, `parakeet.js`) confirms **no confidence, log-probability, or per-token
  score field is read or exists in what this app's vendored offline-websocket-server binary
  returns.** This is the honest answer the task asked for: **there is no native confidence signal
  for Parakeet's offline-ws mode.** The fallback proposed here (Requirement 3) —
  text-compression-ratio + hallucination-pattern reuse + RMS/silence gating — is a deliberate,
  flagged deviation from the Whisper-native ideal, not a silent substitution. If a future
  sherpa-onnx release adds a genuine confidence field to this protocol, swapping
  `isParakeetSegmentLowQuality`'s implementation for a native one is a small, isolated change
  thanks to the shared-module design in §3.

### 3. New shared module: `src/utils/transcriptionQualityHeuristics.js`

Consolidates the confidence/quality logic that today is either inlined in `ipcHandlers.js`
(`summarizeWhisperQuality`, `isWhisperSegmentLowQuality`, the `NO_SPEECH_THRESHOLD` segment filter)
or lives on `WhisperManager` (`isHallucinatedText`, already pure text logic with no whisper-specific
dependency despite its home). Exports:

- `computeTextCompressionRatio(text)` — the same zlib-deflate-based ratio whisper.cpp itself
  computes for `compression_ratio` (a purely textual metric, not a decoder-internal one), so it can
  be applied identically to any engine's output text.
- `isHallucinatedText(text, language)` — the existing logic moved here verbatim (regex-based
  known-hallucination patterns, non-Latin-script rejection, word-repetition-loop detection).
  `WhisperManager.isHallucinatedText` becomes a thin delegating wrapper so every existing call site
  (`ipcHandlers.js:5257,6405,6493`) keeps working unchanged.
- `summarizeWhisperQuality(segments)` and `isWhisperSegmentLowQuality(quality, ctx)` — moved
  verbatim from their current inline definitions in `ipcHandlers.js`, unchanged thresholds
  (`WHISPER_LOGPROB_FLOOR = -1.0`, `WHISPER_COMPRESSION_CEIL = 2.4`). **Extended by
  `docs/specs/dictation-language-mismatch-retry.md`**: `summarizeWhisperQuality(segments, topLevel)`
  gained an optional second parameter carrying whisper-server's language-detection fields, and
  `isWhisperSegmentLowQuality(quality, ctx, acceptedLanguageCodes)` gained a third, optional
  parameter that ORs in a language-mismatch condition (`LANGUAGE_MISMATCH_PROBABILITY_FLOOR = 0.8`)
  — both backward compatible with existing 1-/2-argument call forms.
- **New**: `isParakeetSegmentLowQuality(quality, ctx)` — low-quality when: `ctx.text` is empty;
  or `isHallucinatedText(ctx.text, language)`; or
  `computeTextCompressionRatio(ctx.text) > WHISPER_COMPRESSION_CEIL` (the same 2.4 ceiling reused
  across engines — **adopted as the starting value** even though it was tuned for Whisper's
  decode-failure behavior, not Parakeet's; see Open Questions for why this is treated as resolved
  rather than left blocking, and revisit once real Parakeet usage data exists).
- **New**: `summarizeParakeetQuality(rawText, rmsForChunk)` — returns
  `{ compressionRatio, rms, hallucinated }`, the Parakeet-side counterpart of
  `summarizeWhisperQuality`, feeding `isParakeetSegmentLowQuality`.

This module has no Electron/I/O dependency (pure functions over strings/numbers), matching the
existing precedent (`dictationRouting.js`, `transcriptionEnginePinning.js` from the sibling
lifecycle spec) and making it trivially unit-testable with `node --test`.

### 4. Shared batching session: rename and generalize `whisperStreamingSession.js`

Rename `src/helpers/whisperStreamingSession.js` → `src/helpers/dictationBatchingSession.js`,
exporting `createDictationBatchingSession` / `DictationBatchingSession` (the internal VAD-frame /
merge-retry mechanics are **unchanged** — this is a rename plus one behavioral addition, not a
rewrite). Update the sole import site (`ipcHandlers.js:44`) and rename the existing test file
`test/helpers/whisperStreamingSession.test.js` → `test/helpers/dictationBatchingSession.test.js`
(update only its import names, not its assertions' logic — the segmentation behavior under test
does not change).

**New behavior added to `finish()`**: a wall-clock elapsed-time budget,
`TAIL_FINALIZE_BUDGET_MS` (**adopted default: 300ms** — see Open Questions for why this is treated
as resolved rather than left blocking; chosen to leave headroom under the 500ms total budget
for IPC round trips and the existing 120ms post-stop flush wait already present in
`stop-dictation-preview`), that applies **only** while `finish()` is deciding whether to defer
(merge-and-retry) the last, still-open utterance at hotkey release. Concretely: `finish()` records
its own start time; the existing `defer` decision inside `_pump()` (today: `qualityLow && hasNext &&
!capHit`) additionally requires `!budgetExceeded` when `hasNext` is false (i.e., when this is
genuinely the release-time tail with nothing further to merge into) — once the budget is exceeded,
the tail's current best-effort transcript is committed immediately (identical to today's existing
"cap hit / no next / finishing" commit-despite-low-confidence behavior), it does **not** trigger
the full-audio fallback. This is deliberate and directly answers Requirement 4/5's "what does
'acceptable' mean when retries exhaust the budget": exhausting the *tail's own* retry budget only
ever affects that one small chunk's confidence bookkeeping (rolled into `lowQualityMs` like any
other committed-despite-low-confidence chunk) — it is the **separate**, session-wide
`lowQualityRatio`/`coverageRatio` gate (already implemented, unchanged) that decides whether the
*whole* progressive transcript is good enough to paste directly or whether the full-audio fallback
should run. Two different triggers, two different scopes, by design — collapsing them into one
would either (a) make one bad word trigger an expensive full re-transcription on every dictation
(defeats the Speed premise for the common case), or (b) let the tail merge forever chasing
confidence (defeats the bounded-retry requirement).

### 5. `ipcHandlers.js` changes

- `start-dictation-preview`: remove the `provider === "nvidia" && streamingBeta &&
  supportsOnlineStreaming` branch entirely (retires the true-streaming call site). For
  `provider === "nvidia"`, check `getModelRuntime(model) !== "online"` (import from
  `parakeetModelInfo.js`); if the model is offline-runtime, create a
  `createDictationBatchingSession` wired to a new `transcribeParakeetSegment(pcmBuffer)` callback
  (converts PCM→WAV via the existing `pcm16ToWav` helper already used elsewhere in this file, calls
  `this.parakeetManager.transcribeLocalParakeet(wav, {model})`, and returns
  `{ text, quality: summarizeParakeetQuality(text, bufferRms(pcmBuffer)) }`) and
  `isLowQuality: isParakeetSegmentLowQuality` — the same wiring shape already used for Whisper, just
  with different callbacks (Requirement 1/8d). **Note (per resolved Option A decision, Design §13):
  once Requirement 9's model removal lands, no model can ever have `runtime: "online"` again, so
  this `getModelRuntime(model) !== "online"` guard becomes unconditionally true** — spec-executor's
  call whether to simplify/remove the now-dead-condition check or leave it as harmless defensive
  code against a future model addition.
- Add a `showOverlay` boolean to the handler's params (renderer passes the current
  `showTranscriptionPreview` setting value explicitly, decoupled from whether a session is created
  at all — Requirement 6). Every `windowManager.showTranscriptionPreview()` /
  `appendTranscriptionPreview()` / `holdTranscriptionPreview()` / `resizeTranscriptionPreview()` /
  `hideTranscriptionPreview()` call already reached from this handler family becomes a no-op when
  `showOverlay` is false, while the batching session itself (VAD segmentation, confidence gating,
  commit, `finish()`) always runs when eligible.
- `stop-dictation-preview`: generalize the existing Whisper-branch finalize logic (120ms flush wait,
  `session.finish()`, `lowQualityRatio`/`coverageRatio` gate against
  `MAX_STREAM_LOW_QUALITY_RATIO`/`MIN_STREAM_COVERAGE_RATIO`, unchanged) to run for whichever engine
  created a session (Whisper or offline-runtime Parakeet) — this logic is already
  engine-agnostic since it only touches the session's return shape, not engine internals. Remove
  the now-dead `dictationPreviewStream`/true-streaming branch, `dictationPreviewAccumBuffer`,
  `dictationPreviewAccumBytes`, `MAX_PREVIEW_ACCUM_BYTES`, `MAX_PARAKEET_PREVIEW_ACCUM_BYTES`, and
  `transcribeDictationPreviewChunk()` (the fixed-3-second-timer function) — all dead once both
  engines share one VAD session.

### 6. ~~Scope boundary for the three `runtime: "online"` Parakeet models~~ — retired

This section originally carved out an exception for the three `runtime: "online"` Parakeet models,
letting them keep their existing one-shot streaming behavior outside the new batching mechanism.
**That carve-out no longer applies**: the resolved Option A decision (Open Questions #1) removes
these three models from the product entirely, so there is nothing left to draw a scope boundary
around. See Design §13 for the removal/migration design that supersedes this section.

`SettingsPage.tsx`'s `selectedParakeetModelSupportsStreaming` check and its `parakeetStreamingBeta`
auto-disable `useEffect` are removed along with the setting itself (Requirement 7), since there is
no longer a beta toggle to auto-disable, and no online-runtime model left to check for.

### 7. `audioManager.js` changes

- Decouple worklet/IPC startup from `showTranscriptionPreview`: the PCM-collector worklet and
  `startDictationPreview`/`sendDictationPreviewAudio` IPC now start whenever
  `useLocalWhisper && (localTranscriptionProvider !== "nvidia" || getModelRuntime(parakeetModel) !==
  "online")` (a small renderer-side helper mirrors `parakeetModelInfo.js`'s runtime lookup via the
  already-imported `ModelRegistry`/`PARAKEET_MODEL_INFO`), independent of
  `showTranscriptionPreview`. Pass `showOverlay: !!showTranscriptionPreview` through
  `startDictationPreview`'s options (§5). **Note (per resolved Option A decision)**: once
  Requirement 9's model removal lands, `getModelRuntime(parakeetModel) !== "online"` is
  unconditionally true here too, for the same reason as §5 — same "simplify or leave as dead code"
  call for spec-executor.
- `_resolveStreamingWhisperText`/`_resolveStreamingParakeetText`: drop the
  `settings.showTranscriptionPreview`/`settings.parakeetStreamingBeta` gates (the mechanism is now
  always eligible for eligible engine/model combos); keep the `metadata?.stopPreviewResult`
  presence check unchanged. Merge these two now-nearly-identical methods (and their matching
  `_buildStreamingWhisperResult`/`_buildStreamingParakeetResult` pair) into one shared
  `_resolveBatchedTranscriptionText(settings, metadata)` / `_buildBatchedTranscriptionResult(rawText,
  source)` pair parameterized only by the `source` label string (`"local-whisper-live"` vs.
  `"local-parakeet-live"`) — reinforcing Requirement 1/8d: after this change, the only
  Whisper-vs-Parakeet-specific code left anywhere in the Dictation batching path is the
  `transcribe`/`isLowQuality` callback pair in §5.

### 8. Settings/UI changes

- Remove `parakeetStreamingBeta` entirely: the setting key (`settingsStore.ts` read/default/setter/
  hydration), its Settings UI toggle and `selectedParakeetModelSupportsStreaming` logic
  (`SettingsPage.tsx`), and its translation strings across all locale files.
- `showTranscriptionPreview`'s label/description copy in Settings should be reworded (implementation
  detail for spec-executor, coordinate with i18n files) to reflect its narrowed meaning: "show a
  live caption overlay while dictating" rather than implying it controls transcription speed —
  since after this spec, the speed mechanism is always on regardless of this toggle. **Resolved**:
  the reworded copy should also include a short note that Dictation speed no longer depends on this
  toggle (see Open Questions for why this is settled rather than left open) — exact phrasing is
  spec-executor's call, added through the normal i18n process across all locale files.

### 9. Interaction with `docs/specs/transcription-engine-lifecycle.md`

Every per-chunk `transcribe()` call this spec introduces (Whisper's `transcribeWhisperPreviewSegment`
-equivalent, the new `transcribeParakeetSegment`) goes through the exact same
`WhisperServerManager.transcribe()` / `ParakeetServerManager.transcribe()` →
`ParakeetWsServer.transcribe()` entry points every other caller already uses — so each progressive
batch call is automatically **a "touch"** for that spec's `resetIdleTimer()`/`activeRequestCount`
bookkeeping (Design §3/§8 there) with zero additional plumbing needed here. This matters
concretely: since the batching mechanism is now always-on during any local Dictation recording (not
opt-in), Dictation's pinned engine will receive far more frequent small `transcribe()` calls than
before (once per VAD-closed utterance instead of once per recording) — which is exactly the kind of
continuous "use" the lifecycle spec's idle-timeout (R7, 5 minutes) and pinning (R1/R2) design
already accounts for; no change is needed there, but implementers of *this* spec should read that
spec's Design §3 (`activeRequestCount`, `resetIdleTimer()`) to confirm the new call sites wrap
correctly once both specs are implemented, in whichever order they land.

**Strengthened note (per resolved Option A decision)**: this is no longer just a caller-narrowing
concern. `transcription-engine-lifecycle.md`'s Design §3 currently describes
`createOnlineStream()` as "used directly for realtime dictation preview" — but Requirement 9 of
*this* spec removes `createOnlineStream()`/`_transcribeOnline()` entirely as dead code (zero
remaining callers once the three online-runtime models are gone). Whoever next touches
`transcription-engine-lifecycle.md` needs to make a real edit there, not just note a narrower
caller — the primitive itself won't exist anymore. (Separately, that spec's own header already
marks it "Superseded by `docs/specs/on-demand-model-lifecycle.md`" and "never implemented" — this
note is for whoever maintains its historical record or the superseding doc, not a claim that this
spec depends on it being implemented.)

### 10. Performance note (CLAUDE.md §2)

This spec knowingly increases the number of small transcription calls issued **during active
recording** (previously: one call at release; now: roughly one call per VAD-closed utterance plus
occasional merge-retries). This is an explicit, accepted tradeoff already signed off on by the
project owner ("trading theoretical lowest-possible latency for a mechanism that can validate and
retry") and is not a violation of the Performance premise's **idle** budget (§2 is scoped to "no
active recording, no transcription/reasoning in flight" — this mechanism only runs while a
recording is actively in progress). It is bounded naturally by speech content (one call per VAD
utterance, not a fixed timer racing independent of what the user is saying), matching the existing,
already-shipped precedent for Whisper's preview. No new always-on timer/polling loop is introduced;
`requestPartial()`'s existing 1500ms timer (cosmetic partial-caption re-transcription of the still-
open utterance) is unchanged and, like today, only fires while `showOverlay` is true, since a
volatile partial-caption re-transcription has no purpose when there's no overlay to show it in —
this is the one piece of the mechanism that legitimately stays gated behind the visual toggle (it
does not affect the committed/pasted transcript either way).

### 11. Resolved investigation: do the three `runtime: "online"` Parakeet models have *any* offline/batch inference path?

**This investigation's findings directly support the project owner's Option A decision recorded in
§12** — the confirmed absence of any offline/batch path for these three models is precisely why
"keep only models that mandatorily support batch and offline" (the project owner's own framing)
required removing them rather than accommodating them.

This was the open blocker flagged for further conversation with the project owner
("vamos conversar mais sobre este item"). The codebase and its vendored sherpa-onnx binaries were
inspected directly (not assumed) to confirm the claim in the Problem/Goal section. Findings, with
evidence:

- **Two structurally different sherpa-onnx server binaries exist and are bundled separately.**
  `scripts/download-sherpa-onnx.js:15-72` downloads and installs `sherpa-onnx-offline-websocket-server`
  (renamed `sherpa-onnx-ws-{platform}-{arch}`) and `sherpa-onnx-online-websocket-server` (renamed
  `sherpa-onnx-online-ws-{platform}-{arch}`) as two distinct upstream binaries — this split is
  upstream sherpa-onnx project structure, not something invented in this codebase.
  `ParakeetWsServer.getWsBinaryPath(runtime)` (`src/helpers/parakeetWsServer.js:45-72`) picks one or
  the other purely from the model's `runtime` field; `ParakeetWsServer.transcribe()`
  (`parakeetWsServer.js:332-340`) routes to `_transcribeOffline()` or `_transcribeOnline()`
  accordingly. There is no code path, flag, or fallback anywhere that runs an `"online"`-runtime
  model through the offline binary or vice versa.
- **The model *export itself* — not just the server binary choice — is streaming-specific.**
  `src/models/modelRegistryData.json` shows the difference directly: the two offline models'
  download assets are named `sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2` and, tellingly,
  `sherpa-onnx-nemo-parakeet-unified-en-0.6b-int8-**non-streaming**.tar.bz2` (line 49) — the upstream
  release explicitly labels the offline export "non-streaming." The three `runtime: "online"` models'
  assets (lines 63, 91, 119) are named
  `sherpa-onnx-nemotron-speech-streaming-en-0.6b-**560ms**-int8-...`,
  `sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-**560ms**-int8-...`, and
  `...-nemotron-3.5-asr-streaming-0.6b-**1120ms**-int8-...`. The `560ms`/`1120ms` figures are the
  causal encoder's fixed chunk/lookahead window baked into the exported ONNX graph at export time
  (this is standard sherpa-onnx/icefall streaming-Zipformer/Conformer export practice: a streaming
  encoder takes additional cached-state tensors as graph inputs — `cached_len`, `cached_key`,
  `cached_val`, `cached_conv`, etc. — that a non-streaming encoder graph does not have and cannot
  accept). This is corroborated in-app: `TAIL_SILENCE`'s doc comment
  (`parakeetWsServer.js:24-30`) explicitly references "the largest (1120 ms) chunk window" as a
  property of the model itself, not a server configuration choice.
- **Practical consequence confirmed by tracing every call site**: `ParakeetWsServer._doStart()`
  (`parakeetWsServer.js:143-165`) always passes the same three model files
  (`encoder.int8.onnx`/`decoder.int8.onnx`/`joiner.int8.onnx`) regardless of runtime — but to a
  different binary. Because the online models' encoder graph has a different input/output tensor
  signature than an offline encoder graph requires, there is no way to feed
  `nemotron-speech-streaming-en-0.6b`'s exported files into the offline binary and get a valid result;
  the offline binary would reject the graph outright. There is no vendored non-streaming counterpart
  export of these three specific NVIDIA Nemotron checkpoints available from the sherpa-onnx model zoo
  today.
- **No confidence signal exists for the online path either** (relevant to Design §2/§3):
  `parseOfflineMessage()`/`createOnlineAccumulator()` (`src/helpers/parakeetWsResult.js:1-48`) confirm
  the online protocol's JSON messages only ever carry `text`/`is_final`/`segment` — the same
  text-derived heuristic proposed for offline-runtime Parakeet in Design §3 would be the only
  available confidence signal here too, whichever resolution option is chosen.

**Conclusion**: the claim in Problem/Goal is confirmed, not merely assumed. These three shipped
models genuinely have no batch/offline sherpa-onnx execution path available in this codebase or in
what's published upstream for the checkpoint export. "No streaming, ever" cannot be applied to them
without either (a) dropping the models, or (b) changing what "no streaming" means for their specific
call path. Both are legitimate, materially different product decisions — see §12.

### 12. Resolution options for the three online-runtime models

> **DECISION (project owner, 2026-07-20): Option A.** In the project owner's own words: *"vamos usar
> somente modelos que suportem obrigatoriamente batch e offline... remova os demais... remova a
> flag beta stream... vamos manter uma unica logica que é a que esta aplicada para os modelos
> openAI"* — i.e. "let's use only models that mandatorily support batch and offline... remove the
> others... remove the streaming beta flag... let's keep a single logic — the same one already
> applied to the OpenAI [local Whisper] models." This resolves Open Questions #1. See Design §13 for
> the implementation design. The A/B/C options and tradeoffs below are kept as the historical record
> of what was evaluated before this decision — the old "Recommendation: Option B" paragraph at the
> end of this section is **superseded** and no longer reflects this spec's direction.

Three options were evaluated before the decision above. This section exists to make that
conversation concrete, not to pre-empt it (it no longer needs to, since the decision is now made).

**Option A — Drop the three models from the product entirely.**
Remove them from `modelRegistryData.json`, their Settings UI entries, and download-script support;
migrate any user currently on one of these models to a documented default offline model (e.g.
`parakeet-tdt-0.6b-v3`) on next launch, per CLAUDE.md's Migration Safety premise. Cleanest possible
adherence to "no streaming, ever, for any engine" — after this, there is no code path in the entire
app that uses `createOnlineStream()`/`_transcribeOnline()` for Dictation, Meeting, or Upload, and the
whole online-websocket-server binary/download entry could eventually be removed too.
*Tradeoff*: this is a real product regression, not a refactor — it removes model options a prior
decision already chose to ship (very low per-utterance latency: 560ms/1120ms chunk windows;
multilingual coverage for `nemotron-3.5-asr-streaming-0.6b`). Users currently on one of these models
lose it outright, with no equivalent replacement at the same latency point. This is the largest-blast
-radius option and is the one most likely to need its own migration-focused user communication.

**Option B — Keep them as a documented, narrow Speed/mechanism exception (this spec's current
Non-goals/Design §6 already describes this; restated here for direct comparison).** The three
models keep exactly their current one-shot-at-release behavior, internally implemented via
`createOnlineStream()`, completely untouched by and excluded from the new progressive-batching
mechanism (no VAD chunking, no confidence gate, no merge-retry, no fast committed text). This is
recorded as a new, explicit exception of the same kind as CLAUDE.md §3's existing documented
medium/large-Whisper exception to the Speed premise.
*Tradeoff*: minimal implementation risk and zero product-surface loss — but it does mean these three
models never gain the quality-improving merge-and-retry mechanism this whole spec exists to deliver,
indefinitely, and it leaves "no true streaming, ever" true only for the *new mechanism*, not for the
app as a whole — a reader of Problem/Goal's opening sentence could reasonably say this is a carve-out
of the letter of decision #1, even though Design §6/this section explain why. It is honest about that
tension rather than hiding it, which is the main reason it is workable as an interim answer.

**Option C — Run the online models through the new mechanism by treating each closed VAD chunk as
an independent, state-free "batch" call to the streaming API.** `ParakeetWsServer._transcribeOnline()`
(`parakeetWsServer.js:402-430`) already opens a fresh WebSocket, streams the given buffer in
`ONLINE_CHUNK_BYTES` pieces, appends `TAIL_SILENCE`, and returns one finalized `{ text }` per call —
no decoder state persists across separate `_transcribeOnline()`/`createOnlineStream()` invocations.
That means it could be wired as the `transcribe(pcmChunk)` callback for the shared batching session
(Requirement 1) exactly like the offline engines: each VAD-closed utterance (and each merge-retry
combined buffer) becomes its own independent online-stream call, using the same text-derived
confidence heuristic already proposed for offline Parakeet (Design §3) since the online protocol has
no confidence field either (§11 above). Externally, to the rest of the pipeline, this behaves exactly
like any other engine's batch `transcribe()` call — no state survives across separate committed
chunks, which is precisely the property Problem/Goal cites as the reason streaming was rejected. This
would let these three models participate fully in VAD chunking, confidence gating, and merge-retry.
*Tradeoff, and why this is "promising, not yet provable"*: (1) **Real, untested accuracy risk**: these
models' causal encoders are designed to benefit from continuous left-context across a whole
utterance; feeding them shorter, VAD-chunked slices instead of the full recording (today's actual
behavior) could measurably *reduce* transcription quality for exactly these three models relative to
what they achieve today — the opposite of this spec's stated priority. This is an empirical question
that needs a real side-by-side accuracy comparison before it could be recommended as the default, not
something resolvable by code review alone. (2) More WS connect/finish/TAIL_SILENCE round trips per
recording (bounded by speech content, same class of cost already accepted in Design §10, but higher
than today's single one-shot call for these three models specifically). (3) Adds a third distinct
transcribe-callback shape (Whisper / offline-Parakeet / online-Parakeet-as-batch) to §5's wiring,
slightly weakening (not breaking) the "only confidence-signal-extraction differs" framing in
Requirement 1, since the server-routing/session-lifecycle also differs by one more branch.
Implementation cost is moderate (the raw mechanism already exists in `_transcribeOnline()`); the
open risk is entirely about output quality, which can only be settled by trying it.

**~~Recommendation: Option B, pending project owner decision.~~ Superseded — see the DECISION callout
at the top of this section.** This paragraph originally recommended Option B as the lowest-risk
interim answer, with Option C flagged as a follow-up prototype and Option A reserved for a
project-owner-driven product decision. The project owner has since made exactly that call directly:
Option A. This paragraph is kept, struck through, as historical record of the reasoning that was
in play before the decision — see Design §13 for what actually gets implemented now.

### 13. Model removal & migration design (Option A implementation)

This section is the concrete design that supersedes old Design §6 and implements Requirements 9/10.

**Registry, UI, and download-script removal:**
- Delete the three `runtime: "online"` entries (`nemotron-speech-streaming-en-0.6b`,
  `nemotron-3.5-asr-streaming-0.6b`, `nemotron-3.5-asr-streaming-0.6b-1120ms`) from
  `src/models/modelRegistryData.json`'s `localProviders` Parakeet list. The Settings model dropdown
  reads from the registry, so it drops them automatically; also remove any remaining
  `runtime === "online"`-specific badge/copy in `SettingsPage.tsx` tied to these entries (largely
  already covered by the `selectedParakeetModelSupportsStreaming` removal in §6/§8).
- In `scripts/download-sherpa-onnx.js`, delete the `onlineBinaryPath`/`onlineOutputName` properties
  from all 6 per-platform config objects (`BINARIES`'s 4 entries, `CUDA_BINARIES`'s 2 entries) and
  the "Online WebSocket server" extraction block in `downloadBinary()` that's gated on them — see
  Requirement 9 for why deleting the properties alone is sufficient (they're already optional/
  falsy-guarded, same pattern as `diarizeBinaryPath`/`diarizeOutputName`).

**Code removal (dead once the three models are gone) — see Requirement 9 for the full symbol list
and the mandatory post-removal grep-verification step (line-number citations are deliberately not
used here; they drift on unrelated edits and a prior draft's line citations for this exact file were
found to be wrong during spec review).** Summary: `createOnlineStream()`/`_transcribeOnline()`/
`_warmUpOnline()` in full, every `runtime === "online"`/`modelRuntime === "online"` branch across
`getWsBinaryPath()`/`isCudaBinaryAvailable()`/`_doStart()`/`transcribe()`/`hasAnyWsBinary()`, the
constants/imports left with no remaining consumer (`TAIL_SILENCE`, `ONLINE_CHUNK_BYTES`,
`ONLINE_FINISH_TIMEOUT_MS`, the `createOnlineAccumulator` import and its export in
`parakeetWsResult.js`), `parakeet.js`'s `supportsOnlineStreaming()`, and the `sherpa-onnx-online-ws-`
fragment in `sidecarReaper.js`'s `EXPECTED_BINARY_FRAGMENTS.parakeet` array. Confirmed via Grep:
Dictation, Meeting, and Upload all call the same `ParakeetWsServer.transcribe()` entry point — there
is no other caller of the online-path primitives anywhere in the app, so this removal is safe and
complete, not partial.

**Migration mechanics (Requirement 10):** a `REMOVED_PARAKEET_MODEL_IDS` constant (the three IDs
above) is checked in both places a model ID can be persisted, per CLAUDE.md's "two sources of
truth" pattern:
- **Main process**: `environment.js`, before `parakeetManager`/server init reads the persisted
  `PARAKEET_MODEL` `.env` value — if it matches one of the removed IDs, rewrite it to
  `parakeet-tdt-0.6b-v3` before anything else reads it.
- **Renderer**: `settingsStore.ts`'s `initializeSettings()` (or equivalent startup hydration path)
  — if any of `parakeetModel`/`meetingParakeetModel`/`uploadParakeetModel` in `localStorage` match a
  removed ID, rewrite to `parakeet-tdt-0.6b-v3`.
- Both checks are simple, idempotent, side-effect-free besides the value swap — no transcription
  history, notes, dictionary, or other user data is touched, satisfying CLAUDE.md's Migration
  Safety premise. Run as a cheap check on every launch (not a one-time sentinel file like
  `postMigrationDetector.js`'s bundle-ID migration) — an array-membership rewrite has no drift risk
  from being re-checked repeatedly, unlike a one-time event that must not re-fire.
- Target default is explicit: `parakeet-tdt-0.6b-v3`, the same offline model already named as the
  default elsewhere in this spec.

## Validation Plan

### Automated

- **`test/utils/transcriptionQualityHeuristics.test.js`** (new): pure-function unit tests —
  `computeTextCompressionRatio()` returns a low ratio for varied natural text and a high ratio for
  a repeated-phrase string; `isHallucinatedText()` behavior is unchanged from its existing coverage
  (moved, not rewritten — re-run its existing assertions against the new module location);
  `isWhisperSegmentLowQuality()`/`isParakeetSegmentLowQuality()` each return true/false for known
  good/bad `quality` fixtures (e.g. `avg_logprob` below/above `-1.0`, `compression_ratio`
  above/below `2.4`, empty text, hallucinated text).
- **`test/helpers/dictationBatchingSession.test.js`** (renamed from
  `whisperStreamingSession.test.js`, existing assertions preserved and passing unmodified under the
  new import names) plus new cases:
  - **(a)** VAD chunk-boundary detection: feeding a synthetic PCM stream with two clearly
    silence-separated speech bursts produces exactly two committed segments at expected
    boundaries (extends the existing "commits one segment per silence-delimited utterance" case
    with an assertion on segment count/order for a slightly more complex, multi-gap fixture).
  - **(b)** A single low-confidence chunk (mock `transcribe` returns low `quality` once) triggers
    exactly one merge-with-previous-and-retry (assert `transcribe` was called again with the
    combined buffer, and the retry cap (`maxMerges`) is respected — assert a chunk that stays
    low-quality forever is committed best-effort after exactly `maxMerges` merge attempts, never
    looping past that).
  - **New: `TAIL_FINALIZE_BUDGET_MS` behavior** — using `t.mock.timers` (mirroring the pattern
    already used in `test/helpers/openaiRealtimeStreaming.test.js`), assert that when `finish()`'s
    elapsed time exceeds the budget while a low-confidence tail is pending merge, the tail is
    committed immediately (not deferred further) and the full-audio-fallback signal
    (`lowQualityRatio`/`coverageRatio`) is *not* itself forced to the "fallback" state purely
    because of the budget expiry — i.e., prove the two triggers (tail-budget vs. session-wide
    quality gate) are independent, per Design §4.
  - **(c)** Full-audio-fallback trigger: a session whose committed chunks are mostly low-confidence
    (`lowQualityRatio` above `MAX_STREAM_LOW_QUALITY_RATIO`) or under-covered
    (`coverageRatio` below `MIN_STREAM_COVERAGE_RATIO`) returns `quality` values that a caller-side
    check (mirroring `stop-dictation-preview`'s existing logic) correctly resolves to "fall back to
    full audio" — extend/adapt the existing inline gate assertions already implicit in
    `ipcHandlers.js` into an explicit, directly-testable case here or in a small
    `dictationBatchFinalize.test.js` helper if the gate logic is extracted to its own function
    during implementation (spec-executor's call, as long as it's covered).
  - **(d)** Instantiate the shared session twice in the same test file — once with Whisper-shaped
    callbacks (`isWhisperSegmentLowQuality`), once with Parakeet-shaped callbacks
    (`isParakeetSegmentLowQuality`) — and assert both go through identical commit/merge/finish
    control flow (same assertions, parameterized over the two callback sets), proving no
    per-engine special-casing exists in the shared session itself.
- **[New, per resolved Option A decision] `test/helpers/parakeetModelMigration.test.js`** (or
  nearest existing convention): asserts (a) a persisted value equal to one of the three removed
  model IDs is rewritten to `parakeet-tdt-0.6b-v3` on init, in both the main-process env-var path
  (`environment.js`) and the renderer `localStorage` path (`settingsStore.ts`); (b) already-valid
  model IDs are left untouched; (c) running the check twice (idempotency) doesn't change anything on
  the second pass.
- **[New, per resolved Option A decision] Registry regression guard**: assert
  `modelRegistryData.json` contains zero `runtime: "online"` entries (guards against accidental
  reintroduction of a streaming-only model), and assert `start-dictation-preview` for Parakeet
  *always* creates a batching session unconditionally — replacing the old bullet below, which
  tested a model class that no longer exists.
  - ~~Extend `test/helpers/ipcHandlers`-style coverage... assert that for a Parakeet model with
    `runtime: "online"`, no batching session is created... proving Design §6's exclusion is
    enforced~~ — superseded: Design §6 is retired (§13 replaces it), and there is no longer any
    `runtime: "online"` model to exercise this case against.
- **[New, per resolved Option A decision] Manual grep-verification step, not just automated test
  coverage**: per Requirement 9, after removing the online-runtime primitives from
  `parakeetWsServer.js`/`parakeetWsResult.js`, grep both files for `online`/`Online` and confirm every
  remaining hit is a deliberate remnant (e.g. the generic `modelRuntime` field) rather than an
  orphaned method/constant the removal list missed. This is called out explicitly because standard
  lint/typecheck does not flag unused class methods — an orphaned `_warmUpOnline()`-style leftover
  would otherwise pass `npm run lint`/`npm run typecheck` silently. `pr-reviewer` should treat a
  remaining non-deliberate hit as a FAIL, not an advisory note, same as any other incomplete-removal
  finding.
- **`npm test`** run in full to confirm no regressions in existing suites. **Note (per resolved
  Option A decision)**: `test/helpers/parakeetWsServer.test.js` will need its online-routing-specific
  test cases removed/updated as part of *this* spec's implementation (not left stale), since that
  code path (`createOnlineStream()`/`_transcribeOnline()`) is being removed as dead code, not merely
  left "unaffected" as originally assumed. Also check
  `test/helpers/whisperWakeRewarm.test.js`/`transcriptionEnginePinning.test.js` if the (superseded)
  lifecycle spec's descendant work has landed by the time this one is implemented.

### Manual

1. With Whisper `base` selected and `showTranscriptionPreview` **off**, dictate a 15-20 second
   sentence and release the hotkey. Enable debug logging (`--log-level=debug`) beforehand and
   confirm log lines show multiple VAD-segmented chunk transcriptions occurring *during* the
   recording (not just one call at release), and that the paste happens near-instantly after
   release (no visible caption overlay should appear, confirming the overlay stays off while the
   mechanism still runs).
2. Repeat with `showTranscriptionPreview` **on** — confirm the live caption overlay now appears and
   updates progressively during the same recording, with the same fast release-time paste.
3. Select an offline-runtime Parakeet model (`parakeet-tdt-0.6b-v3` or
   `parakeet-unified-en-0.6b`); repeat steps 1-2, confirming Parakeet now also shows progressive
   VAD-chunked commits in debug logs (not the old fixed-3-second dumb re-transcription), with or
   without the overlay.
4. **[Replaces the old step 4, which tested selecting a now-removed `runtime: "online"` model]**
   Confirm the Parakeet model dropdown in Settings no longer lists `nemotron-speech-streaming-en-0.6b`,
   `nemotron-3.5-asr-streaming-0.6b`, or `nemotron-3.5-asr-streaming-0.6b-1120ms`, and no "beta
   streaming preview" toggle exists anywhere in Settings.
5. **[New]** Migration check: on a pre-upgrade build (or by manually editing `.env`'s
   `PARAKEET_MODEL` and/or `localStorage.parakeetModel` to one of the three removed IDs), launch the
   upgraded build and confirm it starts on `parakeet-tdt-0.6b-v3` instead — no crash, existing
   transcription history/notes untouched, confirmed via debug logs.
6. Speak a passage containing a known Whisper-mis-transcription-prone word/name; confirm the
   confidence-gate merge-retry is visible in debug logs (a chunk transcribed once, then merged with
   the next and re-sent) and that the eventual committed text is more correct than a naive single
   noisy chunk would have been.
7. Force a globally poor-confidence Dictation (e.g. mumble quietly or dictate over background
   noise) and confirm via debug logs that the aggregate `lowQualityRatio`/`coverageRatio` gate
   correctly falls back to a full-clip re-transcription rather than pasting a low-confidence
   progressive result, for both Whisper and offline-runtime Parakeet.
8. Confirm CPU usage during an active dictation with the mechanism running is not dramatically
   different from today's already-shipped Whisper-preview-on baseline (informal spot-check via Task
   Manager/Activity Monitor — this is the same code path, now always-on instead of opt-in, so no
   surprises are expected, but confirm before/after).

### Docs

- **CLAUDE.md**: update the "Local Whisper Models"/"NVIDIA Parakeet Integration" sections (or add a
  new numbered subsection under "Key Implementation Details," following the existing 1-17
  numbering) to document the progressive VAD-batching mechanism as the default Dictation behavior
  and the confidence-gate/merge-retry policy and its bounds, and the full-audio-fallback trigger.
  Remove/update any remaining references to `parakeetStreamingBeta`. **Note (per resolved Option A
  decision)**: do **not** document a Speed-premise exception for `runtime: "online"` Parakeet
  models — that exception no longer exists, since those models are removed from the product
  entirely. (Already verified via Grep: CLAUDE.md's existing "NVIDIA Parakeet Integration" →
  "Available Models" list only names the two offline models, `parakeet-tdt-0.6b-v3` and
  `parakeet-unified-en-0.6b` — no correction needed there beyond what's already planned above.)
- **docs/RECREATION_SPEC.md §2.6** ("Preview de ditação" / §2.6.1-2.6.3): this section currently
  documents the *preview-only, opt-in* nature of this mechanism and the true-streaming Parakeet
  beta path — both need rewriting once implemented to describe the new always-on, unified
  mechanism and the retirement of the streaming-beta Dictation call site. **Note (per resolved
  Option A decision)**: the rewrite should state plainly that there is no remaining streaming-beta
  path or online-runtime model exception at all (not just that the preview becomes always-on) —
  the three models and the beta flag are gone, not merely excluded. §2.10's settings summary must
  drop `parakeetStreamingBeta` from the persisted-settings list.
- **docs/specs/transcription-engine-lifecycle.md**: no edit required by this spec (per the
  ground rule against touching other specs). **Strengthened note (per resolved Option A
  decision)**: this is no longer just a caller-narrowing concern for `createOnlineStream()` — per
  Requirement 9, that primitive is proposed for full removal, so whoever next touches
  `transcription-engine-lifecycle.md` (or its superseding doc,
  `docs/specs/on-demand-model-lifecycle.md`) needs an actual edit reflecting the primitive's
  removal, not a footnote about a narrower caller. (That spec's own header already marks it
  "Superseded... never implemented," so this note is for the historical record / superseding doc,
  not a live dependency of this spec.)

## Open Questions

1. **[RESOLVED — 2026-07-20] Scope of decision #1 versus the three `runtime: "online"` Parakeet
   models.** Design §11 confirmed, with file/line evidence, that `nemotron-speech-streaming-en-0.6b`,
   `nemotron-3.5-asr-streaming-0.6b`, and `nemotron-3.5-asr-streaming-0.6b-1120ms` genuinely have no
   offline/batch sherpa-onnx execution path available — verified against the actual vendored
   binaries, model registry, and sherpa-onnx routing code, not assumed. Design §12 laid out three
   options (A: drop the models, B: keep as a documented exception, C: run them chunked anyway with
   untested accuracy risk).

   **Resolved by the project owner in conversation, 2026-07-20: Option A.** In their own words:
   *"vamos usar somente modelos que suportem obrigatoriamente batch e offline... remova os
   demais... remova a flag beta stream... vamos manter uma unica logica que é a que esta aplicada
   para os modelos openAI"* — remove the three models entirely, remove the `parakeetStreamingBeta`
   flag, and keep exactly one unified batching/quality mechanism across all local engines. See
   Requirement 9/10 and Design §13 for the implementation design this decision drives.

No other open questions remain blocking. This spec is ready for the project owner to review and
flip `Status` to `Approved` — that decision is the project owner's alone, not something this
revision makes on their behalf.

**Resolved during this refinement pass** (minor, non-blocking items — reasoning kept inline in the
Design section where each applies; noted here for traceability against the prior draft):

- ~~`TAIL_FINALIZE_BUDGET_MS = 300ms`~~ (was Open Question #2): adopted as the working default. It
  already had a concrete justification in Design §4 (headroom under the 500ms Speed-premise budget
  alongside the existing 120ms post-stop flush wait and IPC round-trip cost), and 300ms is a small,
  easily-tunable constant with no migration or compatibility implications — not the kind of decision
  that benefits from staying open. Revisit only if real-world telemetry-free manual testing (Manual
  step 1-3) shows the tail is being cut off or committed too eagerly in practice.
- ~~Reusing Whisper's `compression_ratio > 2.4` ceiling for Parakeet~~ (was Open Question #3):
  adopted as the starting value, per the reasoning already in Design §3 — the metric is textual, not
  decoder-internal, so it transfers mechanically; there is no Parakeet-specific usage data to derive
  a better number from yet, and blocking this spec on gathering that data first would delay the whole
  mechanism for a threshold that's cheap to retune later in one place (`transcriptionQualityHeuristics.js`).
- ~~UX copy for the reworded `showTranscriptionPreview` toggle~~ (was Open Question #4): resolved
  yes — the reworded label (Design §8) should include a short explanatory note that Dictation speed
  no longer depends on this toggle. Rationale: this toggle's visible behavior is changing (it used to
  gate a mechanism that noticeably affected release-time latency; after this spec it only gates a
  cosmetic overlay), and CLAUDE.md's i18n rules already require every new/changed user-facing string
  to go through the standard translation-key process regardless — so adding one more short sentence
  to an already-being-edited string costs nothing extra and prevents a support/confusion cost that
  would otherwise land on every user who remembers the old behavior. Exact wording is
  spec-executor's implementation call, coordinated through the normal i18n process (all locale
  files), not a new open question.
