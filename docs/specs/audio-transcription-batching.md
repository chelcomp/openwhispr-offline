# Dictation Audio Transcription: Progressive VAD Batching with Confidence-Gated Retry

## Status
Draft

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
support for them from the product. That is a different, larger, and separate decision from "prefer
batching over streaming as the Dictation speed mechanism," and this spec does **not** make it
unilaterally — see Design §6 and Open Questions.

## Requirements

1. **A single shared batching/confidence mechanism for both engines.** Whisper and offline-runtime
   Parakeet dictation both go through the same VAD-segmentation → per-chunk transcribe →
   confidence-gate → commit-or-merge-and-retry pipeline, via one shared, engine-agnostic module.
   The only engine-specific code permitted is the confidence-signal-extraction (Requirement 3) and
   the raw `transcribe(pcmChunk)` call each engine already exposes.
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
   from the dictation-preview handlers) per decision #1 — see Design §6 for the precise, narrower
   scope of what's actually retired (the Dictation fast-path call site) versus what is explicitly
   *not* touched (the three online-runtime models' baseline, non-progressive transcription, which
   has no alternative implementation available).
8. **Regression tests proving, at minimum:**
   a. VAD-based chunk boundary detection produces reasonable segment splits on a sample audio
      fixture.
   b. A low-confidence chunk triggers exactly one merge-with-previous-and-retry, and the retry cap
      (`maxMerges`) is respected — it never loops forever.
   c. The full-audio fallback triggers correctly when the progressive mechanism can't reach
      acceptable confidence within budget (aggregate `lowQualityRatio`/`coverageRatio` gate).
   d. Both Whisper and offline-runtime Parakeet go through the identical batching module and
      code path — no per-engine special-casing beyond the confidence-signal-extraction functions.

## Non-goals

- **True streaming for the three `runtime: "online"` Parakeet models is not removed.** These
  models have no non-streaming sherpa-onnx execution path available in this codebase; removing
  `createOnlineStream()`/`_transcribeOnline()` from `ParakeetWsServer.transcribe()` entirely would
  drop product support for them, which is a separate, larger product decision this spec does not
  make. They are simply **excluded** from the new progressive-batching mechanism (no VAD chunking,
  no confidence gating, no committed fast-path text) and keep exactly today's one-shot-at-release
  behavior, same as before this spec. This is a new, explicit Speed-premise exception, the same
  class as CLAUDE.md §3's documented medium/large-Whisper exception — see Design §6 and Open
  Questions #1.
- **Removing the `sherpa-onnx-online-websocket-server` binary, its download-script entries, or
  `ParakeetWsServer.createOnlineStream()`/`_transcribeOnline()` as low-level primitives.** They stay
  in place because the three online-runtime models still need them for their baseline
  transcription (see above). Only the Dictation-preview call site
  (`ipcHandlers.js`'s `provider === "nvidia" && streamingBeta` branch) and the
  `parakeetStreamingBeta` setting are retired.
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
  (`WHISPER_LOGPROB_FLOOR = -1.0`, `WHISPER_COMPRESSION_CEIL = 2.4`).
- **New**: `isParakeetSegmentLowQuality(quality, ctx)` — low-quality when: `ctx.text` is empty;
  or `isHallucinatedText(ctx.text, language)`; or
  `computeTextCompressionRatio(ctx.text) > WHISPER_COMPRESSION_CEIL` (the same 2.4 ceiling reused
  across engines — flagged in Open Questions as a concrete proposal, not project-owner-confirmed,
  since it was tuned for Whisper's decode-failure behavior and may need its own Parakeet-specific
  value once real usage data exists).
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
`TAIL_FINALIZE_BUDGET_MS` (proposed concrete value: **300ms** — flagged as a concrete proposal for
confirmation, not an owner-specified number, chosen to leave headroom under the 500ms total budget
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
  with different callbacks (Requirement 1/8d). If the model is online-runtime, create **no**
  session at all (Design §6): the handler simply returns success with no batching state, so
  `stop-dictation-preview` later returns `streamingText: ""` and the renderer falls back to
  today's unchanged one-shot-at-release Parakeet behavior for that model.
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

### 6. Scope boundary for the three `runtime: "online"` Parakeet models

To make the boundary from Non-goals concrete and impossible to miss during implementation:
`ParakeetWsServer.transcribe()` keeps routing to `_transcribeOnline()`/`createOnlineStream()`
exactly as it does today whenever the loaded model's runtime is `"online"` — this code path is
**not modified by this spec** and continues to serve the final, one-shot, non-progressive
transcription for `nemotron-speech-streaming-en-0.6b`, `nemotron-3.5-asr-streaming-0.6b`, and
`nemotron-3.5-asr-streaming-0.6b-1120ms` (Meeting/Upload/Dictation all unaffected for these three
models). What changes is only that the **Dictation-preview/batching call site** never invokes it
(§5's model-runtime check), so these three models simply don't participate in progressive batching
— they keep today's exact behavior, full stop. `SettingsPage.tsx`'s
`selectedParakeetModelSupportsStreaming` check and its `parakeetStreamingBeta` auto-disable
`useEffect` are removed along with the setting itself (Requirement 7), since there is no longer a
beta toggle to auto-disable.

### 7. `audioManager.js` changes

- Decouple worklet/IPC startup from `showTranscriptionPreview`: the PCM-collector worklet and
  `startDictationPreview`/`sendDictationPreviewAudio` IPC now start whenever
  `useLocalWhisper && (localTranscriptionProvider !== "nvidia" || getModelRuntime(parakeetModel) !==
  "online")` (a small renderer-side helper mirrors `parakeetModelInfo.js`'s runtime lookup via the
  already-imported `ModelRegistry`/`PARAKEET_MODEL_INFO`), independent of
  `showTranscriptionPreview`. Pass `showOverlay: !!showTranscriptionPreview` through
  `startDictationPreview`'s options (§5).
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
  since after this spec, the speed mechanism is always on regardless of this toggle.

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
- **Extend `test/helpers/ipcHandlers`-style coverage** (or the smallest exercisable unit, following
  this repo's existing `Module._load`-mocking convention) for `start-dictation-preview`: assert that
  for a Parakeet model with `runtime: "online"`, no batching session is created (no calls to the
  mocked `transcribeLocalParakeet` outside of the eventual full-audio-fallback path) — proving
  Design §6's exclusion is enforced, not just documented.
- **`npm test`** run in full to confirm no regressions in existing suites, in particular
  `test/helpers/parakeetWsServer.test.js` (unaffected — the low-level online/offline routing itself
  is unchanged) and `test/helpers/whisperWakeRewarm.test.js`/`transcriptionEnginePinning.test.js` if
  the lifecycle spec has landed by the time this one is implemented.

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
4. Select one of the three `runtime: "online"` models (e.g.
   `nemotron-speech-streaming-en-0.6b`); confirm Settings no longer shows any
   "beta streaming preview" toggle, and confirm via debug logs that Dictation for this model still
   works exactly as before (one-shot transcription at release, using the online WS path
   internally) — no regression, no progressive batching attempted, no crash.
5. Speak a passage containing a known Whisper-mis-transcription-prone word/name; confirm the
   confidence-gate merge-retry is visible in debug logs (a chunk transcribed once, then merged with
   the next and re-sent) and that the eventual committed text is more correct than a naive single
   noisy chunk would have been.
6. Force a globally poor-confidence Dictation (e.g. mumble quietly or dictate over background
   noise) and confirm via debug logs that the aggregate `lowQualityRatio`/`coverageRatio` gate
   correctly falls back to a full-clip re-transcription rather than pasting a low-confidence
   progressive result, for both Whisper and offline-runtime Parakeet.
7. Confirm CPU usage during an active dictation with the mechanism running is not dramatically
   different from today's already-shipped Whisper-preview-on baseline (informal spot-check via Task
   Manager/Activity Monitor — this is the same code path, now always-on instead of opt-in, so no
   surprises are expected, but confirm before/after).

### Docs

- **CLAUDE.md**: update the "Local Whisper Models"/"NVIDIA Parakeet Integration" sections (or add a
  new numbered subsection under "Key Implementation Details," following the existing 1-17
  numbering) to document the progressive VAD-batching mechanism as the default Dictation behavior,
  the confidence-gate/merge-retry policy and its bounds, the full-audio-fallback trigger, and the
  explicit Speed-premise exception for `runtime: "online"` Parakeet models (mirroring how
  medium/large Whisper models are already documented as an exception in §3 of the Non-Negotiable
  Product Premises). Remove/update any remaining references to `parakeetStreamingBeta`.
- **docs/RECREATION_SPEC.md §2.6** ("Preview de ditação" / §2.6.1-2.6.3): this section currently
  documents the *preview-only, opt-in* nature of this mechanism and the true-streaming Parakeet
  beta path — both need rewriting once implemented to describe the new always-on, unified
  mechanism and the retirement of the streaming-beta Dictation call site, plus the new §2.6
  cross-reference to the `runtime: "online"` exclusion. §2.10's settings summary must drop
  `parakeetStreamingBeta` from the persisted-settings list.
- **docs/specs/transcription-engine-lifecycle.md**: no edit required by this spec (per the
  ground rule against touching other specs), but flag for whoever implements/re-reviews that spec
  that its Design §3 description of `createOnlineStream()` being "used directly for realtime
  dictation preview" will become stale once this spec's Requirement 7 lands, since the Dictation
  preview call site will no longer use it — the online-runtime models' baseline (non-preview) use
  remains, so the drain/pin bookkeeping for `createOnlineStream()` handles is still needed, just
  for a narrower caller than described there today.

## Open Questions

1. **Scope of decision #1 versus the three `runtime: "online"` Parakeet models (Design §6).** This
   is the single most consequential open item. This spec's proposed resolution: decision #1
   ("no true streaming, ever, for any engine") governs the *new Dictation batching mechanism being
   built*, and does not retroactively remove the three existing online-runtime models' baseline
   transcription support, since there is no alternative implementation available for them in
   sherpa-onnx and doing so would be a separate, larger product-scope decision. **Please confirm
   this reading is correct**, or state explicitly if the intent was in fact to drop support for
   these three models entirely (which would be a materially different, larger spec).
2. **`TAIL_FINALIZE_BUDGET_MS = 300ms`** (Design §4) is a concrete proposal grounded in leaving
   headroom under the 500ms total Speed-premise budget, not an owner-specified number — confirm or
   adjust before implementation.
3. **Reusing Whisper's `compression_ratio > 2.4` ceiling for Parakeet's text-derived heuristic**
   (Design §3) is a pragmatic starting point (the metric is textual, not decoder-specific, so the
   math transfers) but was tuned against Whisper's actual failure modes, not Parakeet's — confirm
   this is acceptable as a starting value, to be revisited once real Parakeet usage data exists,
   rather than blocking this spec on deriving a Parakeet-specific threshold empirically first.
4. Should the reworded `showTranscriptionPreview` Settings copy (Design §8) also gain a short note
   explaining that Dictation speed no longer depends on this toggle, to avoid user confusion from
   the visible behavior change (a toggle that used to noticeably affect release-time latency no
   longer does)? Proposed yes, but flagging since it's a copy/UX call, not a technical one.
