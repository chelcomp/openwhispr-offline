# On-Demand Model Lifecycle (Whisper / Parakeet / llama-server — unified, no pinning, no pre-warm)

## Status
Draft

## TL;DR

This spec **supersedes `docs/specs/transcription-engine-lifecycle.md`** (Approved, unimplemented —
confirmed via `git log` / absence of `transcriptionEnginePinning.js`, no code was ever written
against it). The project owner gave new requirements that invert several of that spec's core
decisions. That file's `Status` is being changed to `Superseded` with a pointer here; nothing in it
should be implemented.

**What's changing, in one sentence**: every local model — Whisper, Parakeet, *and now also
llama-server* (new scope vs. the old spec, which explicitly excluded it) — becomes purely
on-demand: nothing loads at app startup, loading is kicked off the moment the user starts an
action that will need it (hotkey-down for Dictation/Meeting/Note Recording, file-selection for
Upload), and every model unloads after a single, user-configurable idle timeout counted from its
last use — with no permanent "pinned/always-warm" engine and no proactive crash-respawn.

**What's kept from the old spec** (still applies, unmodified in spirit):
- Immediate unload the instant a model/provider is switched in Settings (old R3, same behavior).
- The `IDLE_TIMEOUT_MS`/`resetIdleTimer`/`clearIdleTimer` *shape* already in `llamaServer.js` —
  reused as the pattern for Whisper/Parakeet, and now made configurable.
- Drain-before-stop for in-flight requests (old Design §3's `DRAIN_TIMEOUT_MS`) — still needed so an
  idle-timeout or crash-adjacent stop never corrupts a request that's actually in flight.
- `resolvePinnedEngines`-style pure-function extraction pattern (small, dependency-free, unit
  tested) — reused for the new, much simpler decision logic (see Design §1), just not for pinning.

**What's reversed/discarded from the old spec**:
- ❌ **Pre-warm at startup** (old R2) — gone. Nothing loads until first needed (new R1).
- ❌ **"Pinned" engine concept** (old R1, R8, R9, entire Displacement/Restore machinery in Design
  §1/§7/§8) — gone. There is no permanent "always warm, never times out" engine anymore; every
  engine, every surface, behaves identically (new R5). The four-surface resource-contention problem
  the old spec solved via pinning/displacement is now moot — see Design §1 for why.
- ❌ **Immediate reload after a model switch** (old R4's "loads the new model right away,
  fire-and-forget") — reversed. Reload is now always lazy (new R4), never proactive.
- ❌ **Proactive crash respawn with backoff** (old R5/R6, mirroring `onnxWorkerClient.js`) — gone.
  A crash is logged distinctly and nothing else; the engine only comes back via the same on-demand
  trigger as any other cold start (new R7).
- ❌ **"No change to llama-server's own lifecycle" Non-goal** — reversed; llama-server is now in
  scope and gets the same policy (configurable idle timeout, no pre-warm, no proactive respawn).
  Its existing hardcoded `IDLE_TIMEOUT_MS = 5 * 60 * 1000` becomes the shared default that the new
  setting overrides.

**New, this spec**:
- A pre-recording/pre-selection **warm-up trigger**: Dictation hotkey-down fires (fire-and-forget,
  non-blocking) transcription-engine warm-up first, then LLM warm-up second; Meeting/Note Recording
  hotkey-down and Upload file-selection both fire transcription-engine warm-up only (confirmed via
  code search that Meeting/Note Recording transcripts never route through the cleanup/agent LLM
  pass, same as Upload — so both get the same single-warm-up treatment).
- A single, shared, user-facing **Settings → idle-timeout duration** control applying uniformly to
  Whisper, Parakeet, and llama-server (one setting, not per-engine — see Design §5 and the
  non-blocking dissenting consideration flagged below).
- Removal of the entire pinning/displacement/proactive-respawn machinery, replaced by one small,
  shared idle-timeout+lazy-load policy applied identically to all three engines.
- **Wake-from-sleep is revised, not simply deleted**: the existing proactive CUDA-rewarm-on-resume
  handler can't just be removed, because sleep leaves the whisper-server *process* running with a
  now-dead CUDA context (unlike an idle-timeout eviction, which cleanly stops the process) — deleting
  the handler outright risks a silently broken first post-wake transcription, not merely a slower
  one. Instead, on resume the handler now proactively **unloads** (stops) the engine instead of
  reloading it — genuinely equivalent to an idle-timeout eviction, and consistent with "no proactive
  loading, only proactive unloading is allowed."

**Non-blocking, flagged-for-visibility question** (this draft proceeds with a default answer;
implementation is not gated on a reply):
- **Is a single shared idle-timeout setting really correct, or should Whisper/Parakeet (fast,
  \<500ms-budget engines) have a *different* default/range than llama-server (already a
  separately-budgeted, slower LLM pass)?** The Portuguese phrasing ("o tempo de Idle antes de
  descarregar os modelos") reads as one shared concept, and per the task's own guidance this draft
  implements it as one shared setting/value — but the two engine families have different cost
  profiles (STT: cheap+fast to reload, tight 500ms budget when cold; LLM: already several seconds to
  reload, its own separate budget). If a per-engine split is wanted, it's a small, non-blocking
  follow-up change (two settings instead of one, different UI/IPC surface) — flag it, but Draft
  approval doesn't need to wait on this.

**Practical impact for the user**: the app now truly does nothing at idle (satisfying CLAUDE.md
§2's idle budget directly, for both STT and LLM) — no engine of any kind is loaded until the user
starts using it. The first hotkey press after a long idle period no longer waits until *after*
release to start loading the transcription model — that load now starts *the moment the hotkey
goes down*, racing the user's own speech, so it's usually already warm by release. If a user
does a very short dictation (release before the engine finishes loading), transcription simply
waits for that load to finish before proceeding — the 500ms budget is measured recording-stop to
transcript-ready in the already-warm case, and this edge case is an explicit, documented exception
to it (see Design §4). Users get a new Settings control to tune how long any of these engines stay
warm before auto-unloading (default 5 minutes, matching today's llama-server behavior).

## Problem / Goal

Today, lifecycle management for local models is inconsistent, pre-warms indiscriminately, and (per
the old spec's Approved-but-unimplemented design) was heading toward a permanent "pinned engine"
concept that the project owner has now explicitly rejected in favor of a simpler, fully lazy model:

1. **Whisper and Parakeet pre-warm unconditionally at app startup** (`main.js:552,560` →
   `WhisperManager.initializeAtStartup` / `ParakeetManager.initializeAtStartup`), regardless of
   whether the user will use Dictation in this session at all. This directly costs idle RAM/CPU
   from the moment the app launches, in tension with CLAUDE.md §2.
2. **llama-server also conditionally pre-warms at startup** (`main.js:567-585`, gated on
   `CLEANUP_PROVIDER === "local"` / `DICTATION_AGENT_PROVIDER === "local"`) — same problem, and
   until now was explicitly out of scope for any lifecycle rework (old spec's Non-goals). The
   project owner's new requirement #1 explicitly reverses that exclusion.
3. **No engine has a *configurable* idle-timeout.** llama-server has a hardcoded 5-minute
   `IDLE_TIMEOUT_MS` (`llamaServer.js:19`); Whisper/Parakeet have none at all (they run indefinitely
   once started). Neither is user-adjustable.
4. **Model swap unloads immediately but (per the old, now-superseded spec) would have reloaded
   immediately too** — the project owner's requirement #4 clarifies this should stay lazy on
   reload, only actually loading again when genuinely needed (which, per requirement #3, is
   "hotkey-press," not "first transcription request" — see Design §1 for why these aren't in
   tension).
5. **Crash handling has no distinct log line today, and the old (unimplemented) spec would have
   added proactive respawn-with-backoff for pinned engines** — the project owner's requirement #7
   rules this out entirely; a crash should just be logged, with recovery left to the ordinary
   on-demand path.
6. **No "pinned" engine concept should exist at all** — the old spec's entire premise (Dictation's
   configured engine stays permanently warm, displacing/restoring around occasional
   Meeting/Upload use of a different model) is rejected outright by requirement #2 (nothing
   pre-warms, ever) and requirement #5 (idle-timeout applies universally, no exemption for any
   engine). See Design §1 for why this also resolves the old spec's four-surface resource-contention
   problem without needing displacement/restore machinery.

## Requirements

- **R1 — Nothing pre-warms at app startup.** Remove the `main.js:552,560` calls to
  `whisperManager.initializeAtStartup()` / `parakeetManager.initializeAtStartup()`, and the
  `main.js:567-585` conditional `modelManager.prewarmServer(...)` calls for `cleanupLocalModel` /
  `LOCAL_DICTATION_AGENT_MODEL`. Startup does no model-loading work of any kind, for any of the
  three engines. (The `powerMonitor.on("resume", ...)` wake-rewarm callback at `main.js:534-544` is
  addressed separately — see R9.)
- **R2 — Trigger: transcription engine loads on hotkey-down, before the LLM engine.** The instant
  a Dictation/Meeting/Note-Recording recording starts (hotkey pressed or the equivalent UI action),
  fire a non-blocking warm-up call for the transcription engine currently configured for that
  surface (Whisper or Parakeet, whichever `useLocalWhisper`/`localTranscriptionProvider` resolves
  to for that surface), immediately followed by (not blocked on) a non-blocking warm-up call for the
  cleanup/dictation-agent LLM scope relevant to that surface, in that order (transcription first,
  then LLM) — the transcription call must be *issued* first, but must not be awaited before issuing
  the LLM call (both proceed concurrently in practice; the ordering requirement is about issue
  order, matching the literal ask, not about serializing one behind the other's completion).
- **R3 — Upload triggers transcription-engine warm-up on file selection, no LLM warm-up.** The
  moment a file is selected for Upload transcription (before the user confirms/starts the actual
  transcription, if there's a separate confirm step — otherwise on the earliest available "file
  chosen" event), fire the same non-blocking transcription-engine warm-up as R2. Upload has no
  equivalent LLM warm-up trigger, since Upload's transcript does not route through the
  cleanup/dictation-agent LLM pass the way Dictation's does.
- **R4 — Model/provider switch unloads immediately, reloads only lazily.** Confirmed unchanged from
  today's behavior for *unload* (switching Dictation's provider or same-provider model stops the
  now-stale process immediately, non-blocking) — but reload must NOT be immediate/proactive.
  The next load only happens via the ordinary on-demand triggers: R2/R3's warm-up-on-action-start,
  or an actual transcription/inference request arriving with no engine loaded. This explicitly
  reconciles with R2: R2's hotkey-press warm-up call *is* the "next actual use" trigger, just fired
  slightly ahead of the literal first token/request, in parallel with the user's speech — not a
  proactive background reload independent of any real usage.
- **R5 — Universal, single idle-timeout policy, no pinning.** Every engine (Whisper, Parakeet,
  llama-server) unloads after a single configurable idle-timeout duration counted from its last
  use, with the timer reset on every use (mirroring `llamaServer.js`'s existing
  `resetIdleTimer`/`clearIdleTimer` shape exactly). No engine is ever permanently exempt from this
  timeout ("pinned") — every surface (Dictation, Meeting, Note Recording, Upload) is treated
  identically regardless of which model each is independently configured to use.
- **R6 — New Settings control for the idle-timeout duration.** A single, shared, persisted setting
  controls the idle-timeout duration applied to all three engines (see Design §5 for the
  single-vs-per-engine judgment call, flagged as the one blocking Open Question above). Default:
  5 minutes (300000ms), matching today's llama-server hardcoded value — so existing users see no
  behavior change on upgrade for llama-server's timeout, and Whisper/Parakeet gain the same
  previously-nonexistent timeout at the same default. Minimum: 30 seconds (prevents thrashing from
  an accidentally-tiny value causing constant reload churn during normal pauses in dictation use).
  Maximum: 60 minutes (a sane upper bound — beyond this, a user who wants "never expire" should be
  told that's not offered, per R5's "no permanent exemption" rule; this is a deliberate product
  choice, not an oversight — see Non-goals).
- **R7 — No proactive crash-respawn, for any engine.** An unexpected process exit is logged
  distinctly (`error` level, includes exit code/signal, and text identifying it as unexpected vs.
  an intentional stop) and nothing else happens automatically. The engine only comes back via the
  same on-demand triggers as any other cold start (R2/R3, or a real transcription/inference
  request). This applies uniformly — there is no "pinned engine gets proactive respawn" exception,
  since R5 removes the pinned concept entirely.
- **R8 — Drain-before-stop preserved.** Any stop (idle-timeout firing, intentional switch-away,
  crash-adjacent cleanup) must not corrupt or hang a request that is actively in-flight against the
  engine at that moment — reuse the old spec's `DRAIN_TIMEOUT_MS`/`activeRequestCount` shape
  (Design §2) for Whisper/Parakeet; llama-server's existing request-in-flight handling (it already
  guards its own HTTP round-trip lifecycle) is confirmed sufficient and untouched beyond adding the
  configurable timeout.
- **R9 — Wake-from-sleep proactively unloads (does not reload) the transcription engine.** The old
  spec's R9 ("retarget wake-rewarm to the pinned model") assumed a pinned engine exists to
  *reload*. That reload behavior is removed (no engine is pinned anymore, and R1/R7 forbid
  proactive loading) — but the existing `main.js:534-544` `powerMonitor.on("resume", ...)` handler
  cannot simply be deleted outright, because sleep does not behave like an ordinary idle-timeout
  eviction: an idle-timeout fires `stop()`, leaving a clean "no process" state that the next
  on-demand `start()` cold-starts correctly. Sleep does **not** stop the process — the existing
  comment at `main.js:536` ("Sleep evicts the local GPU model from VRAM; reload it once the driver
  settles") reflects that the whisper-server *process* keeps running post-wake with a now-dead CUDA
  context, which the idempotent "start-before-transcription" guard would likely treat as "already
  running" and skip re-initializing — silently corrupting the first post-wake transcription rather
  than merely delaying it. **Reconciled design**: on `resume`, proactively call `stop()` (not
  `start()`) on whichever local transcription engine is currently running with CUDA enabled — this
  genuinely makes wake-from-sleep equivalent to an idle-timeout eviction (clean "no process" state)
  rather than leaving a broken warm process behind, fully consistent with R7's "no proactive
  loading, only proactive/immediate unloading is allowed" policy. The next Dictation hotkey press
  after wake then triggers a normal on-demand cold start via R2, same as any other cold-engine case
  — momentarily slower than before, but correct, whereas the naive "just delete the handler" option
  risks a silently broken transcription instead.
- **R10 — All new timers/state cleared on intentional stop and app shutdown**, reusing the existing
  `sidecarRegistry` stop-function wiring for Whisper/Parakeet and the existing shutdown path for
  llama-server — unchanged in spirit from the old spec's R10, just without any pin-related state to
  clear (there is none left).

## Non-goals

- No support for running two processes of the same engine concurrently to serve a differently-
  configured Meeting/Upload request without contending for the shared process — same accepted
  tradeoff as the old spec's Non-goals, now simplified further: since nothing is pinned, a
  differing-model request from any surface simply cold-swaps the shared engine on demand (today's
  existing lazy swap-on-mismatch behavior, unchanged), with no "displacement" bookkeeping needed
  because there's no privileged pinned state to protect or restore.
- No "never expire" / infinite-idle-timeout option — R6's 60-minute maximum is a deliberate ceiling;
  a user who never wants a model to unload is out of scope for this spec (would reintroduce the
  pinning-equivalent problem R5 explicitly removes).
- No change to cloud/BYOK/self-hosted (`lan`) transcription or reasoning lifecycle.
- No change to `DiarizationManager`'s (speaker-embedding ONNX) lifecycle — separate manager, not one
  of the three engines in scope.
- No per-scope (`dictationCleanup`/`dictationAgent`/`noteFormatting`/`chatIntelligence`) distinction
  in the idle-timeout policy — llama-server remains a single shared process/timeout regardless of
  which scope's request last used it, consistent with `llama-server-vram-tuning.md`'s existing
  single-shared-server model (Non-goal there too).
- No user-visible notification/toast on crash or on idle-unload — logged only, consistent with R7's
  "just log it" simplicity and the old spec's already-accepted precedent of no crash notification.
- Not reworking `llamaBackends.js`'s GPU/CPU backend selection, `--ctx-size` doubling
  (`llama-server-vram-tuning.md`), or `--ctx-size` argument construction
  (`llama-server-ctx-size-fix.md`) — this spec only adds/adjusts the idle-timeout duration and
  startup pre-warm removal around that already-implemented, unrelated machinery.

## Design

### 1. Why pinning/displacement is now unnecessary (resolving the old spec's Problem/Goal concern)

The old spec's core tension was: Dictation, Meeting, Note Recording, and Upload each have
independent model settings for the same shared-singleton engine process, so a permanently-warm
"pinned" engine could get transiently "displaced" by a differently-configured surface's use, and
needed explicit restore-after-use hooks plus a safety-net idle-timeout to reverse that.

That tension only existed because of requirement R2 in the *old* spec — "pinned engines stay warm
indefinitely." Once nothing is ever permanently warm (new R1/R5), there is no privileged state to
protect or restore: every surface's use is now symmetric. A Dictation request for model A and a
later Meeting request for model B both just cold-swap the shared process on demand, exactly like
today's existing "lazy swap on mismatch" logic already does (`whisperServer.js`'s
`start()`/`_ensureServerStarted()` no-op guard) — no new displacement-tracking or restore-hook
machinery is needed at all. The cost of a genuine same-engine, different-model conflict between
surfaces (e.g. pinned-equivalent: Dictation configured for Whisper `base`, Meeting configured for
Whisper `small`) is simply "the next request from either surface pays a cold-swap if the other
surface's model was last loaded" — an accepted, logged tradeoff, same conceptually as the old
spec's Design §8 accepted tradeoff, just without any code to protect a "pinned" state, because none
exists.

This means the entire old-spec Design §1 (`transcriptionEnginePinning.js`), §7 (crash respawn
machinery), and §8 (restore hooks) are **not ported forward** — deleted from scope, not adapted.

### 2. Shared per-engine state (Whisper, Parakeet) — reused from old spec, minus pin fields

`WhisperServerManager` (`whisperServer.js`) and `ParakeetWsServer` (`parakeetWsServer.js`) gain:

- `activeRequestCount`, `DRAIN_TIMEOUT_MS = 15000` (Whisper / bounded Parakeet offline requests),
  `STREAMING_DRAIN_TIMEOUT_MS = 300000` (Parakeet `createOnlineStream()` handles) — identical in
  shape to the old spec's Design §3, reused verbatim; this is orthogonal to pinning and still
  needed so an idle-timeout-triggered `stop()` never kills a request that's actually in flight.
- `idleTimer`, `resetIdleTimer()`, `clearIdleTimer()` — same shape as `llamaServer.js`'s existing
  implementation, but `IDLE_TIMEOUT_MS` becomes a **read from the new shared setting** (see Design
  §5) instead of a hardcoded constant, for all three engines including llama-server itself.
- `_intentionalStop` boolean — same as old spec, needed so the `process.on("close", ...)` handler
  can log "crashed unexpectedly" (R7) vs. "stopped intentionally" without extra work.
- **Not ported**: `pinned`, `pinnedModelPath`/`pinnedModelName`, `pinnedUseCuda`,
  `setPinnedTarget()`, `crashCount`, `respawnTimer`, `gaveUp`, `RESPAWN_BACKOFF_MS`,
  `MAX_RESPAWN_ATTEMPTS` — all removed from scope; no proactive respawn exists anywhere now (R7).
- A single per-manager transition lock (old spec's Design §4, generalizing `startupPromise`) is
  still needed and still ported forward unchanged — concurrent `start()`/`stop()` calls (idle-timer
  firing, a warm-up call, a settings-triggered restart, an actual transcription request) must still
  serialize FIFO regardless of the pinning simplification; this is a pure concurrency-safety concern
  independent of pinning.

`LlamaServerManager` (`llamaServer.js`) keeps its existing `resetIdleTimer`/`clearIdleTimer`/timer
shape (`llamaServer.js:19,454-477`) essentially as-is; the only change is `IDLE_TIMEOUT_MS` becoming
a value read from the shared setting (via a small setter, e.g. `setIdleTimeoutMs(ms)`, called
whenever the setting changes, defaulting to 300000 if never set) instead of the current
module-level `const`.

### 3. Removing startup pre-warm (R1)

In `main.js`:

- Delete the `whisperManager.initializeAtStartup(whisperSettings)` call and the `whisperSettings`
  object (lines ~547-554), unless `initializeAtStartup` retains other necessary non-pre-warm setup
  (e.g. resolving paths) — in that case, split it into a `resolveStartupSettings()` step that still
  runs (cheap, I/O-light) and a separate `prewarmIfConfigured()` step that is deleted. Confirm via
  reading `WhisperManager.initializeAtStartup`'s actual body during implementation which parts are
  pure setup vs. an actual `startServer()` call, and only delete the latter.
- Delete `parakeetManager.initializeAtStartup(parakeetSettings)` the same way.
- Delete the `main.js:567-585` block that conditionally calls `modelManager.prewarmServer(...)` for
  `cleanupLocalModel` / `LOCAL_DICTATION_AGENT_MODEL`.
- Rewrite (not delete) the `powerMonitor.on("resume", ...)` block (`main.js:534-544`) per R9: replace
  the `whisperManager.onWakeFromSleep()` reload call with a proactive `whisperManager.stopServer()`
  (or an equivalent narrower "unload if currently CUDA-loaded" call) — same `wakeRewarmTimer`/
  `WHISPER_WAKE_REWARM_DELAY_MS` debounce shape, opposite action (unload instead of reload). Confirm
  during implementation whether `shouldRewarmOnWake`'s existing gating logic (only act if a CUDA
  model was actually loaded pre-sleep) is still the right gate for the unload decision too, or
  whether unloading unconditionally on every resume (cheap, since `stop()` on an already-stopped
  engine is a no-op) is simpler and just as correct — leaning toward the latter, since there's no
  "pinned" state left to check against.
- `WhisperManager.initializeAtStartup`/`ParakeetManager.initializeAtStartup` and
  `modelManagerBridge.prewarmServer()` themselves are **not deleted as functions** — they remain
  available (harmless, unused-at-startup) in case a future caller needs an explicit prewarm; only
  their startup call sites are removed. (`prewarmServer()` is in fact still useful as the
  implementation target for the new warm-up hooks in Design §4 below — same function, new caller.)

### 4. Warm-up hooks on recording-start / file-select (R2, R3)

**Renderer side — new symmetric warm-up call for transcription engines.**
`src/helpers/audioManager.js` already has `warmupReasoningServer()` (existing, called from
`useAudioRecording.js:42` inside `performStartRecording`, right where `setVoiceAgentRequested` is
set) and `warmupMicDriver()` (called separately from `handleStart`, `useAudioRecording.js:321`).
Add a new sibling method, `warmupTranscriptionEngine()`, structured the same way:

- Reads the effective transcription provider/model for the *surface* currently starting (Dictation
  today; Meeting/Note Recording reuse the same audioManager/`meeting-transcription-prepare` path —
  confirm during implementation whether they already funnel through `AudioManager` or a parallel
  path in `meetingRecordingStore.ts`, and add the equivalent call there if not).
- If local Whisper is configured: `window.electronAPI.whisperServerStart(model)` (existing IPC
  channel, already used for both explicit "start now" and lazy on-demand starts — same handler,
  new caller).
- If local Parakeet is configured: `window.electronAPI.parakeetServerStart(model)` (existing IPC
  channel, same reuse pattern).
- Fire-and-forget (`.catch(() => {})`), matching `warmupReasoningServer()`'s existing error-handling
  style — a failed warm-up must never block or fail the recording-start path itself (Graceful
  degradation, CLAUDE.md §5).
- No-op if the configured provider is cloud/BYOK (nothing to warm up locally).

**Call-site ordering** — `performStartRecording` (`useAudioRecording.js:29`) is the single
chokepoint every start path (toggle-mode `handleToggle` and push-to-talk `handleStart`) already
routes through before reaching `warmupReasoningServer()` at line 42 — confirmed by reading the
actual call graph (`handleStart` at line 320-323 calls `performStartRecording` directly). Add
`warmupTranscriptionEngine()` **once**, inside `performStartRecording`, immediately before the
existing `warmupReasoningServer()` call, without awaiting it — both remain fire-and-forget, issued
back-to-back synchronously, satisfying R2's "transcription first, then LLM" ordering (issue order,
not completion order — see R2's precise wording). Do **not** add a second call at `handleStart`
itself — that would double-fire the warm-up on every push-to-talk press (harmless given
`whisperServerStart`/`parakeetServerStart`'s existing idempotent-start guard, but redundant and
worth avoiding for log-noise/clarity).

**Meeting / Note Recording** — confirmed via grep against `src/` that no code path routes Meeting or
Note Recording transcripts through `dictationCleanup`/`dictationAgent` (no match for
`meeting`+`dictationCleanup`/`dictationAgent`/`resolveReasoningRoute` together) — Meeting/Note
Recording transcripts are never passed through the cleanup/agent LLM scopes the way Dictation's are.
Therefore Meeting/Note Recording gets **R3's treatment (transcription-engine warm-up only, no LLM
warm-up call)**, not R2's — this is now a settled design decision, not an open question. Add the
`warmupTranscriptionEngine()`-equivalent call at the earliest point equivalent to "hotkey-down"/
"recording start" for these two surfaces (confirm exact call site during implementation by reading
`meetingRecordingStore.ts` and the `meeting-transcription-prepare` IPC handler in `ipcHandlers.js` —
they share one backend per CLAUDE.md §16), using Meeting's own configured model
(`meetingWhisperModel`/`meetingParakeetModel`, falling back to Dictation's per existing
settings-resolution logic) rather than Dictation's.

**Upload** — the earliest "file selected" event in the Upload UI (confirm exact component/handler
during implementation, e.g. `UploadSettings.tsx` or wherever the file picker's `onChange`/drop
handler lives) fires `warmupTranscriptionEngine()`-equivalent using Upload's own configured model
(`uploadWhisperModel`/`uploadParakeetModel`, falling back to Dictation's), with no LLM warm-up call
(R3).

**Speed budget (CLAUDE.md §3) framing — the crux of this design.** Loading the transcription engine
starting at hotkey-down, in parallel with the user's own speech, means that for any recording long
enough to exceed the engine's cold-load time, the engine is already warm by the time the hotkey is
released — so the sub-500ms raw-transcription budget is measured **from recording-stop to
transcript-ready**, not from a cold process spawn, exactly as today's already-warm-engine case is
measured. **Explicit edge case**: for a very short recording (released before the engine finishes
loading), transcription must simply wait for the in-flight load to finish before the actual
transcribe call proceeds (the existing idempotent "start-before-every-transcription" guard already
present in `whisperServer.js`/`parakeetServer.js` naturally serializes this — a second `start()`/
`transcribe()` call while a `start()` is already in flight awaits the same promise rather than
racing it). In this edge case, the sub-500ms budget **is not met**, and this is an accepted,
explicitly documented exception (mirroring CLAUDE.md §3's existing carve-out for medium/large
Whisper models) rather than a silently-glossed-over regression — the Validation Plan includes a
manual check for exactly this case.

### 5. New Settings control (R6)

**Single shared setting** (pending resolution of the flagged Open Question):

- Store key: `modelIdleTimeoutMs` (renderer `localStorage`, via `useSettingsStore.ts`, following the
  exact pattern of `audioRetentionDays` — default value resolution, `get`/`set` action, and the
  `useSettingsStore.ts:191`-style key registration for persistence).
- Env var mirror for main-process consumption: `MODEL_IDLE_TIMEOUT_MS`, persisted via
  `saveAllKeysToEnvFile()` (mirrors the existing `AUDIO_RETENTION_DAYS` pattern referenced in
  CLAUDE.md's Settings Storage section) — needed because `WhisperServerManager`,
  `ParakeetWsServer`, and `LlamaServerManager` are all main-process singletons instantiated well
  before any renderer window/localStorage exists, exactly the same "two sources of truth" problem
  CLAUDE.md documents for `AUDIO_RETENTION_DAYS` (see project memory:
  `project_settings_two_sources_of_truth.md`) — reuse that exact startup-sync pattern
  (`get-model-idle-timeout-sync-state` IPC + a pure `resolveModelIdleTimeoutStartupSync()` helper in
  a new `src/helpers/modelIdleTimeoutSync.js`, mirroring `audioRetentionSync.js`) rather than
  inventing a new one.
- IPC handlers: `get-model-idle-timeout-ms` / `save-model-idle-timeout-ms` (mirrors
  `get-audio-retention-days`/`save-audio-retention-days` exactly), calling a new
  `setModelIdleTimeoutMs(ms)` on each of the three managers (or a small shared
  `modelIdleTimeoutRegistry.js` that all three managers register with, so a single settings-change
  event fans out to all three without `ipcHandlers.js` having to know about three separate setter
  calls individually — preferred, since it also gives a single point to clamp/validate the value
  once).
- UI: a new numeric/slider control in `SettingsPage.tsx`, placed near existing performance-adjacent
  settings (the same section `audioRetentionDays`'s "Storage Usage"/Privacy & Data control lives in,
  or a new "Local Model Performance" grouping if that reads better in context — executor's call
  during implementation, following existing section-heading conventions) — labeled per the i18n
  rules (new keys in both `en/translation.json` and `pt/translation.json`; do not hardcode text).
  Bounds enforced both in the UI (min 30s / max 60min, per R6) and defensively in the pure validation
  helper (`resolveModelIdleTimeoutMs(value)` in the same new helper file), mirroring
  `audioCleanupPolicy.js`'s existing pattern of a pure, independently-testable validation function.
- **Migration (CLAUDE.md §6)**: this is a brand-new setting with no prior value to migrate — an
  upgrading user who has never touched it gets the stated default (5 minutes / 300000ms), applied
  identically to all three engines. No existing data is at risk since nothing previously depended on
  this key.

### 6. Crash logging only (R7)

In each manager's `process.on("close", ...)` handler (Whisper, Parakeet, and confirm llama-server's
equivalent exit handler in `llamaServer.js` gets the same treatment if it doesn't have one already):
if `_intentionalStop` is false, log distinctly at `error` level (exit code/signal included) and do
nothing further — no counter, no backoff, no scheduled respawn. The very next on-demand trigger
(R2/R3 warm-up call, or a real transcription/inference request) naturally re-invokes `start()`,
which already handles "no process currently running" as its ordinary cold-start case — nothing new
needs to be built for the recovery path itself, only the removal of anything that used to schedule
a respawn (which, per the earlier confirmation the old spec was never implemented, means there is
literally nothing to remove in the *shipped* code today — this requirement mainly guards against
inventing R5/R6-style respawn machinery during this spec's own implementation, and mandates adding
the previously-missing distinct crash log line for all three engines).

### 7. Compliance with Non-Negotiable Product Premises

- **Performance / idle budget (§2)**: this spec is directly in service of this premise for both STT
  and LLM engines simultaneously — removing all startup pre-warming (R1) and adding a universal,
  no-exception idle-timeout (R5) means the app does zero background model-loading work while idle,
  for the first time covering all three engines uniformly. The only "always-on" thing introduced is
  a single `setTimeout`-based idle timer per *currently loaded* engine (not running unless something
  is actually loaded) — same cost shape as `llamaServer.js`'s existing, already-accepted timer.
- **Speed (§3)**: see Design §4's dedicated framing — hotkey-down-triggered background loading is
  specifically designed so the 500ms budget is measured from recording-stop, with the short-
  recording edge case explicitly acknowledged as an accepted, documented exception rather than
  glossed over.
- **Privacy (§1)**: no new network calls, no new listener/port — unchanged.
- **Single instance (§4 of the premises list)**: unaffected — no change to app startup/window
  creation/single-instance lock.
- **Graceful degradation (§5)**: warm-up calls are fire-and-forget/`.catch()`-swallowed everywhere
  (Design §4) so a failed or slow warm-up never blocks or breaks the recording-start/file-select UX;
  a crashed engine (R7) degrades to "next on-demand call does a normal cold start," never a hard
  failure of the record→transcribe→paste core function.
- **Migration safety (§6)**: the one new persisted setting (`modelIdleTimeoutMs` /
  `MODEL_IDLE_TIMEOUT_MS`) is brand-new with a stated default (5 minutes) and the standard
  renderer/main two-source-of-truth sync pattern reused from `audioRetentionDays` — no existing
  key is renamed or restructured.

## Validation Plan

### Automated

- **New `test/helpers/modelIdleTimeoutSync.test.js`** (mirrors `test/helpers/audioRetentionSync.test.js`
  if it exists, else follow `audioCleanupPolicy.test.js`'s pure-function-test convention): tests
  `resolveModelIdleTimeoutMs()`'s bounds-clamping (below 30s → clamped/rejected per chosen policy;
  above 60min → clamped/rejected; valid values pass through unchanged) and
  `resolveModelIdleTimeoutStartupSync()`'s renderer-wins-when-main-has-no-persisted-value /
  main-wins-when-genuinely-persisted logic, mirroring `audioRetentionSync.js`'s existing tests
  structurally.
- **Update `test/helpers/llamaServer.test.js`**: add a test asserting `IDLE_TIMEOUT_MS` is now
  sourced from `setIdleTimeoutMs(ms)` rather than the hardcoded module constant — e.g.
  `"resetIdleTimer schedules a stop after the currently configured idle timeout, not a hardcoded 5 minutes"`
  using `t.mock.timers` to assert a custom, non-default timeout value (e.g. 45000ms) is honored
  after calling `setIdleTimeoutMs(45000)`, and that the previous default (300000ms) is used when
  never explicitly set.
- **Update/rename `test/helpers/whisperServer.test.js` and `test/helpers/parakeetWsServer.test.js`**:
  - Remove/do-not-add any pinning-related test scenarios from the old spec's Validation Plan that
    were never implemented (nothing to delete in shipped code, but do not port these test cases
    forward from the old spec when writing new tests for this one).
  - New test: idle-timeout now applies universally (no "pinned, never times out" branch to test at
    all) — start the server, tick past the configured idle timeout, assert `stop()`/kill fires;
    tick past it again after a fresh use, assert the timer resets per-use, matching R5's
    "reset on every use" wording, mirroring the existing `llamaServer.test.js` idle-timeout test
    shape.
  - New test: idle-timeout duration is configurable — assert a custom
    `setIdleTimeoutMs(value)` changes the scheduled delay (via `t.mock.timers.tick`).
  - New test: drain-before-stop (`DRAIN_TIMEOUT_MS`/`activeRequestCount`) still holds when the idle
    timer (not a settings-change) is what triggers the stop — an in-flight fake
    `transcribe()`/`_transcribeOffline()` call must still settle successfully before the process is
    actually killed, and the `DRAIN_TIMEOUT_MS` ceiling still forces the stop if the in-flight call
    never settles.
  - New test: an unexpected process exit (`close` handler, `_intentionalStop === false`) logs a
    distinct error-level message and does **not** schedule any respawn timer, and a subsequent
    explicit `start()` call still proceeds normally (the "lazy on-demand recovery still works, no
    proactive scheduling exists" assertion replacing the old spec's respawn-backoff tests).
  - Remove any expectation of `pinned`/`setPinnedTarget`/`crashCount`/`gaveUp` fields existing on
    these managers — these must not exist in the shipped implementation; if a test file already
    references them (it shouldn't, since none of this was ever implemented per the confirmed
    `git log` check), that would itself indicate scope drift to catch in review.
- **New `test/helpers/audioManagerWarmup.test.js`** (or extend an existing `audioManager`-focused
  test file if one exists — check before creating): asserts `warmupTranscriptionEngine()` calls
  `window.electronAPI.whisperServerStart`/`parakeetServerStart` appropriately based on configured
  provider, is a no-op for cloud/BYOK providers, and never throws/rejects even if the underlying IPC
  call rejects (fire-and-forget contract). Asserts the call-site ordering in
  `useAudioRecording.js`'s `performStartRecording` issues `warmupTranscriptionEngine()` before
  `warmupReasoningServer()` (e.g. via call-order assertions on mocked functions), without awaiting
  the first before issuing the second.
- **Remove/do not add** `test/helpers/transcriptionEnginePinning.test.js` and any
  `whisperWakeRewarm.test.js` additions the old spec proposed (`resolveWakeRewarmTarget`) — confirm
  `whisperWakeRewarm.test.js`'s *existing* tests (pre-dating both specs) still pass unmodified, but
  do not extend it, since R9 removes the wake-rewarm feature entirely rather than retargeting it. If
  `main.js`'s wake-rewarm removal (Design §3) leaves `shouldRewarmOnWake`/`onWakeFromSleep` as
  dead code, confirm during implementation whether to delete them or leave them unused (leaning
  toward: leave `shouldRewarmOnWake` itself, since it's a small pure function with its own tests
  and no harm in keeping it importable, but remove the `main.js` call site and confirm
  `onWakeFromSleep` isn't called from anywhere else before deciding whether to delete it too).
- All new/updated tests run via the existing `npm test` (`node --test "test/helpers/*.test.js"
  "test/utils/*.test.js"`) — no new test runner/config needed.

### Manual

1. Fresh app launch (no prior recording in this session): with `EKTOSWHISPR_LOG_LEVEL=debug`, confirm
   **no** "pre-warm"/"initializeAtStartup" log lines for Whisper, Parakeet, or llama-server appear,
   and confirm via Task Manager/Activity Monitor that no whisper-server/parakeet/llama-server child
   process exists yet.
2. Press the Dictation hotkey and start speaking. Immediately (within the first second) check debug
   logs for a transcription-engine warm-up log line, followed shortly by an LLM warm-up log line (if
   cleanup/dictation-agent is configured locally) — confirm the transcription-engine log line
   appears first.
3. Do a normal-length dictation (several seconds); release the hotkey; confirm the transcript pastes
   promptly (already-warm case) and that the elapsed time from release to paste is consistent with
   the existing sub-500ms budget for a fast engine (Whisper `tiny`/`base` or Parakeet).
4. Do a deliberately very short dictation (tap hotkey and release almost immediately, especially
   right after a long idle period so the engine is cold); confirm the transcription still completes
   correctly, but observe/measure that it takes noticeably longer than 500ms in this case — confirm
   this is the accepted, documented exception from Design §4, not a hang or an error.
5. In Settings, change the new idle-timeout control to a short custom value (e.g. 30 seconds, the
   minimum). Do a dictation, then wait past that duration without doing another one; check debug
   logs confirm the transcription engine and (if locally configured) llama-server both unload after
   that shorter interval rather than the old hardcoded 5 minutes.
6. Attempt to set the idle-timeout control below 30 seconds or above 60 minutes via direct
   input/URL/devtools manipulation of the underlying store value; confirm the value is clamped/
   rejected rather than silently accepted out-of-bounds.
7. Switch Dictation's Whisper model from one size to another; confirm the old model's process stops
   immediately (existing behavior, unchanged) and confirm the new model does **not** load again
   until the next Dictation hotkey press (no immediate reload) — check debug logs show a gap with no
   process running in between.
8. Select a file for Upload transcription; confirm (via debug logs) the transcription engine begins
   warming up immediately on file selection, before the user explicitly starts the transcription
   itself, and confirm no LLM warm-up log line appears for this path.
9. Start a Meeting recording via the Meeting hotkey; confirm the transcription engine configured for
   Meeting (its own model setting, or Dictation's fallback) begins warming up at that same
   hotkey-press moment.
10. Kill the whisper-server process manually mid-session (simulating a crash) while it's the only
    thing running; confirm debug logs show a distinctly-logged unexpected-exit message and confirm
    **no** automatic respawn attempt occurs (no process reappears without a subsequent Dictation
    hotkey press or other real use); then press the Dictation hotkey again and confirm it recovers
    normally via a fresh cold start.
11. Put the machine to sleep and wake it while a local Whisper CUDA model was loaded (running,
    warm). Confirm debug logs show the engine being proactively **stopped** (not reloaded) shortly
    after resume; confirm no process for it remains running post-wake; then press the Dictation
    hotkey and confirm the transcription completes correctly via a normal on-demand cold start
    (momentarily slower than an already-warm case, but correct output) — this is the accepted,
    revised R9 tradeoff (unload-not-reload, to avoid the dead-CUDA-context risk of leaving the old
    process running post-wake).
12. Leave the app fully idle (no recording, no LLM use) for a duration well past the configured idle
    timeout; confirm via Task Manager/Activity Monitor and RAM measurement that idle RAM/CPU is at or
    below the CLAUDE.md §2 budget (≤300 MB RAM, <2% average CPU) with all three engines unloaded.

### Docs

- **CLAUDE.md**: replace/rewrite the (not-yet-added, since the old spec was never implemented)
  planned "18. Transcription Engine Lifecycle" subsection — add it now describing the on-demand,
  no-pinning, universal-idle-timeout model instead, cross-referencing this spec (not the superseded
  one). Update the "whisper.cpp Integration" and "NVIDIA Parakeet Integration" bullet lists to state
  they no longer pre-warm at startup and now warm up on hotkey-press/file-select instead. Add a note
  to the Model Registry Architecture section (§8) or a new small subsection documenting the shared
  `modelIdleTimeoutMs` setting and that it now also governs llama-server's previously-hardcoded
  `IDLE_TIMEOUT_MS`.
- **docs/RECREATION_SPEC.md**: update its transcription-pipeline section (§2, referenced by the old
  spec) to describe the new on-demand/idle-timeout behavior as current/actual once implemented,
  removing any description of startup pre-warming as today's behavior.
- **docs/specs/transcription-engine-lifecycle.md**: `Status` line changed to `Superseded` with a
  one-line pointer to this file (done as part of this planning pass, see below) — its Design/
  Validation content is retained in the file for historical record but must not be implemented.

## Open Questions

1. **(Non-blocking — this draft proceeds with a default reading; flag if you want it changed.)**
   This spec implements the idle-timeout as **one shared setting** for all three engines, per the
   literal singular Portuguese phrasing ("o tempo de Idle antes de descarregar os modelos") and per
   the task's own guidance to proceed with that reading unless a per-engine split is clearly
   better. Worth surfacing anyway: Whisper/Parakeet (fast STT, tight 500ms budget when cold) and
   llama-server (already separately-budgeted, several-second reload) have different cost profiles,
   so independently tunable timeouts/defaults could genuinely be nicer — but this is a "would be
   nice," not a blocker. Nothing in this spec is gated on the answer; implementation can proceed
   as drafted (single shared setting) unless told otherwise.
2. (Non-blocking) Whether `WhisperManager.initializeAtStartup`/`ParakeetManager.initializeAtStartup`
   contain any non-pre-warm setup work that must be preserved at startup even though the pre-warm
   call itself is removed — to be confirmed by reading their actual bodies during implementation
   (Design §3).
3. (Non-blocking) Whether wake-from-sleep's proactive unload (revised R9) should gate on
   `shouldRewarmOnWake`'s existing "was a CUDA model actually loaded pre-sleep" condition, or
   simply unload unconditionally on every resume (cheap no-op if nothing's loaded) — leaning toward
   the latter for simplicity, to be settled during implementation (Design §3).
