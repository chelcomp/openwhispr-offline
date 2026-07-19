# Transcription Engine Lifecycle (Pinning, Idle-Timeout, Crash Respawn)

## Status
Draft

## Problem / Goal

EktosWhispr has two local transcription engines — whisper-server (`src/helpers/whisper.js` +
`src/helpers/whisperServer.js`) and Parakeet/sherpa-onnx (`src/helpers/parakeet.js` +
`src/helpers/parakeetServer.js` + `src/helpers/parakeetWsServer.js`) — shared as **singletons**
across all four surfaces that can trigger local transcription: Dictation (the hotkey), Meeting
transcription, Note Recording (identical code path to Meeting, just with a `noteId` attached —
confirmed via `src/stores/meetingRecordingStore.ts` and the `meeting-transcription-*` IPC
channels in `src/helpers/ipcHandlers.js`), and Audio Upload (`transcribe-audio-file` only — its
BYOK/cloud sibling `transcribe-audio-file-byok` never touches the local server lifecycle).

Today, lifecycle management is inconsistent and has three concrete gaps:

1. **Same-provider model changes are lazy, not immediate.** Switching Dictation's *provider*
   (Whisper ↔ Parakeet ↔ cloud) already proactively stops the now-unused engine
   (`sync-startup-preferences` in `ipcHandlers.js:3622-3717`). But switching Dictation's *model*
   within the same provider (e.g. Whisper `base` → `tiny`) does not: `WhisperServerManager.start()`
   (`whisperServer.js:377-411`) and `ParakeetServerManager._ensureServerStarted()`
   (`parakeetServer.js:82-90`) only swap the loaded model the next time a transcription request
   arrives, so the old model sits loaded and unused until then.
2. **No idle-timeout exists for local transcription servers.** Once started, `WhisperServerManager`
   and `ParakeetWsServer` run indefinitely, whether or not the engine is the one Dictation is
   actually configured to use. This wastes RAM/VRAM for engines only occasionally used by Meeting,
   Note Recording, or Upload, and violates the Performance premise (CLAUDE.md §2: idle budget
   ≤300 MB RAM / <2% CPU).
3. **Crash handling is silent and non-proactive.** An unexpected process exit
   (`whisperServer.js:500-513`, `parakeetWsServer.js:212-226`) just flips `ready=false`/
   `process=null` with no log line distinguishing it from an intentional stop, and no attempt to
   recover until the next transcription request happens to trigger the existing idempotent
   start-before-every-transcription guard. This risks Dictation silently missing the sub-500ms
   Speed premise (CLAUDE.md §3) right after a crash, with no diagnostic trail.

There is also a real, user-configurable conflict this spec must resolve: Meeting and Upload each
have their **own independent** transcription provider/model settings
(`meetingWhisperModel`/`meetingParakeetModel` in `src/stores/settingsStore.ts`, surfaced in
`src/components/settings/MeetingSettings.tsx`; `uploadWhisperModel`/`uploadParakeetModel`,
surfaced in `src/components/settings/UploadSettings.tsx`), which fall back to Dictation's model
only when left unset. A user can deliberately configure Meeting to use a different Whisper model
size than Dictation. Since each engine is a **single shared process that can only run one model
at a time**, this is a genuine resource conflict, not a hypothetical one, and this spec must state
exactly how it's resolved (see Design §8).

## Requirements

- **R1 — Pinning definition.** An engine (Whisper or Parakeet) is "pinned" if and only if
  Dictation is currently configured to use it (`useLocalWhisper === true` and
  `localTranscriptionProvider` matches). Whether Meeting, Note Recording, or Upload are configured
  to use the same or a different engine/model has no bearing on pin status. At most one local
  engine is pinned at a time; in cloud mode neither is pinned.
- **R2 — Pinned engines pre-warm at startup and stay warm indefinitely.** This already exists for
  the happy path (`WhisperManager.initializeAtStartup`, `ParakeetManager.initializeAtStartup`);
  this spec makes pin bookkeeping (not just the one-shot pre-warm attempt) authoritative from
  process start, so later logic (crash respawn, idle-timeout, wake-from-sleep) can rely on it even
  when the initial pre-warm itself was skipped (e.g. model not yet downloaded at boot).
- **R3 — Provider switch away from an engine unloads it immediately.** Already true today; this
  spec additionally keeps pin bookkeeping (`pinned`/`pinnedModel`/`pinnedUseCuda`) in sync with
  every such switch, in the same `sync-startup-preferences` handler that already performs the
  immediate stop.
- **R4 — Same-provider model change unloads the old model immediately, not lazily**, and loads the
  new model right away (fire-and-forget, non-blocking to the settings-change IPC call) so the
  pinned guarantee holds continuously. This must not corrupt or hang a transcription that is
  actively in-flight against the old model at the moment of the change — the old server process is
  only actually terminated after in-flight requests against it finish, bounded by a drain timeout
  (see Design §5) so a wedged request can't block a legitimate engine/model change forever, and so
  the renderer/main process never blocks/freezes waiting on it.
- **R5 — Crash of a pinned engine is logged and proactively respawned with backoff**, mirroring the
  shape of `src/helpers/onnxWorkerClient.js` (crash counter, exponential backoff schedule, capped
  attempts, reset-on-success), adapted from utility-process/MessagePort semantics to
  child_process/HTTP-or-WS semantics. Giving up after the attempt cap pauses only the *proactive*
  respawn loop — the existing lazy on-demand start-on-next-request path remains available, so the
  engine can still recover without an app restart once whatever was crashing it is fixed.
- **R6 — Crash of a non-pinned engine keeps today's lazy respawn-on-next-request behavior**, with
  the previously-missing log line added (distinguishing an unexpected exit from an intentional
  stop), but no proactive respawn scheduling.
- **R7 — Non-pinned usage keeps the engine warm for 5 minutes after last use, then auto-stops it**,
  mirroring `src/helpers/llamaServer.js`'s `resetIdleTimer`/`clearIdleTimer`/
  `IDLE_TIMEOUT_MS = 5 * 60 * 1000` pattern exactly. The window resets on every use. A pinned
  engine never runs this timer.
- **R8 — Explicit, tested resolution of the pinned-vs-differing-non-pinned-model conflict**
  (Design §8): non-pinned surfaces keep their own configured model (never silently overridden);
  displacement of the pinned model is logged distinctly, proactively reversed the moment the
  non-pinned activity ends, and self-healed by the idle-timeout machinery as a safety net if the
  explicit hook is ever missed.
- **R9 — Wake-from-sleep CUDA rewarm targets the pinned model**, not "whatever happens to be
  loaded," so a transient non-pinned displacement active at sleep time doesn't cause the wrong
  model to be reloaded on wake.
- **R10 — All new timers/backoff state are cleared on intentional stop** (including app shutdown
  via the existing `sidecarRegistry` stop functions), so nothing fires after shutdown or after a
  deliberate provider/model switch-away.

## Non-goals

- No support for running two processes of the *same* engine concurrently (e.g. two whisper-server
  instances) to let a pinned and a differing non-pinned request be served truly concurrently. This
  is a materially bigger change (extra port, extra idle RAM/VRAM budget) and is out of scope; the
  narrow, logged cold-swap cost described in Design §8 is the accepted tradeoff instead.
- No change to cloud/BYOK/self-hosted (`lan`) transcription lifecycle, and no change to
  `transcribe-audio-file-byok` (confirmed out of scope — it never touches the local server
  lifecycle).
- No change to `llama-server`'s (cleanup/dictation-agent reasoning) own lifecycle — it already has
  its own idle-timeout and is referenced here only as the pattern to mirror for R7.
- No change to `DiarizationManager`'s lifecycle — it's a separate manager (speaker-embedding ONNX
  model via the ONNX worker process), not one of the two engines in scope here.
- No new persisted settings key and no new user-facing UI/toggle. "Pinned" is fully derived at
  runtime from Dictation's existing `useLocalWhisper`/`localTranscriptionProvider`/`whisperModel`/
  `parakeetModel` settings — nothing new is written to `localStorage` or `.env`, so no migration
  path is needed (CLAUDE.md §6 does not apply).
- No new wake-from-sleep rewarm mechanism for Parakeet (none exists today, and CLAUDE.md already
  documents Parakeet's CUDA behavior as always-on/no-toggle). Only Whisper's existing CUDA
  wake-rewarm is retargeted per R9; the asymmetry itself is left as-is.
- No new user-facing notification/toast when a pinned engine's crash-respawn "gives up" — logged
  only (flagged as an explicit Open Question below in case the project owner wants this).

## Design

### 1. Concepts

- **Pinned**: the engine Dictation is currently configured to use (R1). At most one of
  {Whisper, Parakeet} is pinned; in cloud mode, neither.
- **Non-pinned use**: any transcription request against an engine that isn't pinned, or a
  same-engine request for a *different model* than the pinned one (from Meeting/Note
  Recording/Upload, which have independent model settings — see Problem/Goal).
- **Displaced**: a pinned engine's shared process is currently loaded with a model other than its
  pinned model, because a non-pinned request for a different model temporarily won the shared
  single-process/single-model resource. This can only happen between two requests for the *same
  engine* (Whisper vs. Whisper, or Parakeet vs. Parakeet) — if Meeting/Upload use a *different
  engine* than Dictation's pinned one, there's no shared-process contention at all (each engine is
  an independent singleton/process), so "displacement" never applies cross-engine.

### 2. Shared pure decision logic — new file `src/helpers/transcriptionEnginePinning.js`

Following the existing precedent of extracting cross-cutting decision logic into small, pure,
independently-unit-testable functions (`src/helpers/dictationRouting.js`,
`shouldRewarmOnWake` in `whisper.js`), add a new module exporting:

- `resolvePinnedEngines({ useLocalWhisper, localTranscriptionProvider })` → 
  `{ whisperPinned: boolean, parakeetPinned: boolean }`. Centralizes R1's rule in one tested place
  instead of duplicating the boolean logic across `ipcHandlers.js`, `whisper.js`, and `parakeet.js`.
- `isEngineDisplaced({ pinned, pinnedModelKey, currentModelKey })` → `boolean`. `modelKey` is
  whatever uniquely identifies the loaded model for that engine (a resolved file path for Whisper,
  a model name for Parakeet) — true when `pinned` is true and the two keys differ. Used both by the
  low-level idle-timer safety net (Design §8) and by the explicit restore hooks in `ipcHandlers.js`.

This module has no I/O and no Electron dependency, so it's trivially covered by `node --test`
without mocking anything (see Validation Plan).

### 3. New state on the low-level server managers

Both `WhisperServerManager` (`whisperServer.js`) and `ParakeetWsServer` (`parakeetWsServer.js`)
gain the same shape of new instance state (Parakeet's `ParakeetServerManager` in
`parakeetServer.js` is a thin forwarding layer in between, mirroring its existing
`startServer`/`stopServer`/`getServerStatus` forwarding pattern — it gets a new `setPinnedTarget`
forwarding method but no state of its own):

- `pinned` (boolean), `pinnedModelPath`/`pinnedModelName` (whichever key that engine already uses
  internally — `modelPath` for Whisper, `modelName` for Parakeet), and (Whisper only)
  `pinnedUseCuda` (boolean). Parakeet needs no `pinnedUseCuda` equivalent — its CUDA selection is
  always auto-resolved fresh inside `start()` via the existing `_syncCudaSelection()`/
  `_isCudaEligible()`, independent of any caller-supplied pin state, per CLAUDE.md's documented
  Parakeet-always-attempts-CUDA behavior.
- A single setter, `setPinnedTarget({ pinned, modelKey, useCuda })` (Whisper) /
  `setPinnedTarget({ pinned, modelName, modelDir })` (Parakeet), that atomically updates all of the
  above so the fields never drift relative to each other. When `pinned` transitions false → true:
  immediately `clearIdleTimer()` (a newly-pinned engine must never auto-stop from a stale
  non-pinned-era timer) and reset `crashCount = 0; gaveUp = false;` (a fresh pin commitment
  shouldn't inherit give-up state from a previous, unrelated pin session).
- `activeRequestCount` (number) — incremented when a request begins, decremented when it settles.
  For Whisper this wraps `transcribe()`. For Parakeet it wraps both `_transcribeOffline()` and the
  full lifetime of a `createOnlineStream()` handle (from creation until its existing internal
  `settle()` closure fires) — `createOnlineStream` is used directly for realtime dictation preview
  (`ipcHandlers.js:6521`) and can legitimately stay open for as long as the user is dictating, so it
  must count as in-flight for the whole stream, not just per chunk.
- `idleTimer`, `IDLE_TIMEOUT_MS = 5 * 60 * 1000`, `resetIdleTimer()`, `clearIdleTimer()` — mirrors
  `llamaServer.js:19,333-349` exactly, including the "clear at request-entry, reset in a `finally`
  after the request settles" double-touch (`llamaServer.js:356,436`) that closes the race between a
  request starting and the idle timer firing at nearly the same instant.
- `crashCount`, `respawnTimer`, `gaveUp`, `RESPAWN_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000]`,
  `MAX_RESPAWN_ATTEMPTS = 5` — mirrors `onnxWorkerClient.js`'s shape exactly (same backoff values,
  same cap), reset to 0/false on any successful start.
- `_intentionalStop` (boolean) — set `true` at the top of `stop()`, reset `false` once `stop()`
  resolves. Distinguishes "we killed it on purpose" (settings change, provider switch, idle-timeout,
  app shutdown) from "it exited unexpectedly" in the existing `process.on("close", ...)` handler,
  which today cannot tell the two apart.
- `DRAIN_TIMEOUT_MS = 15000` — bounded wait, inside `stop()`, for `activeRequestCount` to reach 0
  before actually killing the process (applies to Whisper's `transcribe()` and Parakeet's
  `_transcribeOffline()`, both bounded request/response operations). For Parakeet's
  `createOnlineStream()` handles specifically, use a much longer ceiling,
  `STREAMING_DRAIN_TIMEOUT_MS = 300000` (5 minutes — matching the existing
  `TRANSCRIPTION_TIMEOUT_MS` already defined in `parakeetWsServer.js` and CLAUDE.md's documented
  "Process timeout protection (5 minutes)"), since a live dictation stream is open-ended by design
  and a short fixed timeout would risk killing a real, still-actively-recording dictation rather
  than only a genuinely wedged one. Either ceiling is a safety valve for the pathological case, not
  the expected path — the expected path is the in-flight work finishing well before the ceiling.

### 4. Concurrency: serialize start()/stop() per engine

`start()` already has a `startupPromise` guard against concurrent starts, but concurrent
`start()`/`stop()` calls that both decide a swap is needed (e.g. two settings changes in quick
succession) can race today. Generalize the existing `startupPromise` into a single per-manager
transition lock that both `start()` and `stop()` chain through, so any overlapping callers
(Dictation transcription, a non-pinned transcription, a settings-triggered restart, a GPU-mode
change, the idle-timeout firing, a crash respawn) are serialized FIFO rather than racing, and
concurrent callers await the same in-flight transition instead of starting a second one. This
directly protects R4's "don't corrupt or hang" requirement across every caller, present and future,
without duplicating the safeguard at each call site.

### 5. `ipcHandlers.js` — `sync-startup-preferences` (R3, R4)

Extend the existing handler (`ipcHandlers.js:3622-3717`):

- Whenever it runs, compute `{ whisperPinned, parakeetPinned }` via
  `resolvePinnedEngines({ useLocalWhisper: prefs.useLocalWhisper, localTranscriptionProvider:
  prefs.localTranscriptionProvider })` and call `whisperManager.setPinned(whisperPinned, ...)` /
  `parakeetManager.setPinned(parakeetPinned, ...)` (new methods on `WhisperManager`/
  `ParakeetManager`, forwarding to the server managers' `setPinnedTarget`) — every time, not just on
  a provider switch, so pin bookkeeping never goes stale.
- **New**: in the branch where the provider stays the same but `prefs.model` differs from the
  currently-loaded model of that engine (today: sets `LOCAL_WHISPER_MODEL`/`PARAKEET_MODEL` for the
  *next* launch but does nothing to the already-running process), also immediately call
  `whisperManager.stopServer()` (fire-and-forget, `.catch()`-logged, matching the existing
  convention already used two branches above) followed by kicking off
  `whisperManager.startServer(prefs.model, { useCuda: this._resolveWhisperUseCuda() })` — same
  fire-and-forget convention. `stop()`'s new drain-wait (Design §3) already guarantees this doesn't
  corrupt/hang an in-flight transcription on the old model. Symmetric for Parakeet
  (`startServer(prefs.model)`, no `useCuda` option needed).

### 6. `ipcHandlers.js` — GPU-mode/device-index handlers

`set-whisper-gpu-mode` (`:2423-2438`) and `set-gpu-device-index` (`:2451-2507`) already stop+restart
whisper-server with the new GPU settings. Extend both to also refresh the stored `pinnedUseCuda` via
`whisperManager.setPinned(true, currentModel, newUseCuda)` right after the restart, so the pinned
descriptor doesn't go stale relative to the GPU mode the user just picked (this matters for the
restore paths in Design §8, which reuse the stored `pinnedUseCuda`).

### 7. Crash detection and respawn (R5, R6)

In each manager's `process.on("close", ...)` handler: if `_intentionalStop` is true, do nothing
extra (existing cleanup only). If false (unexpected exit):

- Log distinctly at `error` level (e.g. `"whisper-server crashed unexpectedly"` /
  `"parakeet-ws crashed unexpectedly"`, including exit code/signal) — this alone satisfies R6 for a
  non-pinned engine, with no further action.
- If `pinned` is true (R5): increment `crashCount`; if `crashCount > MAX_RESPAWN_ATTEMPTS`, set
  `gaveUp = true` and log at `error` ("giving up on proactive respawn; on-demand start on next
  request remains available") — this deliberately diverges from `onnxWorkerClient.js`'s harsher
  `gaveUp` semantics (which permanently rejects all future requests): here, `gaveUp` only pauses the
  *proactive* loop, since these two servers are the literal core dictation path and a permanent
  lockout would contradict CLAUDE.md §5 Graceful degradation far more than in the ONNX worker's
  background-feature context. Otherwise, schedule a respawn via `setTimeout` at
  `RESPAWN_BACKOFF_MS[min(crashCount - 1, length - 1)]`; at fire time, re-check `pinned` (it may
  have changed during the backoff window — e.g. the user switched engines while waiting) and skip
  the respawn if no longer pinned, logging that it was skipped. On the respawn's success, reset
  `crashCount = 0`.
- Any pending respawn timer is cleared whenever `setPinnedTarget` unpins the engine or `stop()` is
  called intentionally (R10), so a stale backoff timer never revives an engine nobody wants anymore.

### 8. Idle-timeout (R7) and the pinned-vs-displaced conflict (R8)

`resetIdleTimer()` (called at the end of every request, mirroring `llamaServer.js`) behaves as:

- If `pinned` and the currently-loaded model matches `pinnedModelPath`/`pinnedModelName`: do
  nothing (no timer — a correctly-pinned, correctly-loaded engine never needs one, satisfying R7's
  "pinned = no idle-timeout").
- Otherwise (not pinned, **or** pinned-but-displaced — see Design §1) schedule a timer for
  `IDLE_TIMEOUT_MS`. On fire:
  - If still not pinned: `stop()` (existing R7 behavior).
  - If pinned (meaning: still displaced after 5 idle minutes — this is the safety-net path,
    since `setPinnedTarget(true, ...)` clears the timer immediately, so the only way this branch is
    reached is a *displaced* pinned engine whose explicit end-of-session restore, below, never ran)
    call `restorePinned()` instead of `stop()`, logged distinctly as a self-heal. `restorePinned()`
    starts the pinned model with a reduced option set (model + `pinnedUseCuda` only, no VAD/thread
    signature) — a deliberate, documented simplification: this safety-net path can't cheaply reach
    the "dictation" VAD-option resolver that lives in `ipcHandlers.js`, so it accepts a small chance
    of one extra reload if the very next real Dictation request also needs a different VAD
    signature. This is a rare path in practice (see below) so the minor inefficiency is accepted
    rather than engineered away.

**The fast path — explicit restore hooks (primary mechanism, not the 5-minute fallback).** Add a
new private helper on `IPCHandlers`, `_restorePinnedTranscriptionEnginesIfDisplaced()`, that for
each engine checks `isEngineDisplaced(...)` and, if true, fires (non-blocking, `.catch()`-logged) a
full-fidelity restore: `whisperManager.startServer(pinnedModel, { useCuda:
this._resolveWhisperUseCuda(), ...this._resolveWhisperVadOptions("dictation") })` /
`parakeetManager.startServer(pinnedModel)`. Call this:

- At the end of the `meeting-transcription-stop` handler (`ipcHandlers.js`, right after
  `resetMeetingLocalState()` runs, on both the success and error paths) — covers Meeting and Note
  Recording identically, since they're the same code path.
- After `transcribe-audio-file`'s transcription attempt settles (success or failure) — covers
  Upload.

In the overwhelming common case this restores the pinned model within moments of the non-pinned
session ending — well before the 5-minute safety net would ever fire. While a differing-model
non-pinned session is still active, a genuine Dictation request pays a normal cold-swap cost (the
same lazy swap-on-mismatch mechanism that already exists today), clearly logged so it's
diagnosable; this narrow, accepted degradation only manifests when the user has explicitly
configured Meeting/Upload to use a *different model of the same engine* Dictation is pinned to —
different-engine configurations (e.g. pinned Whisper + Meeting on Parakeet) never contend at all,
since each engine is an independent process (Design §1).

### 9. Wake-from-sleep retargeting (R9)

Add a new pure function alongside `shouldRewarmOnWake` in `whisper.js`:
`resolveWakeRewarmTarget({ pinned, pinnedModel, pinnedUseCuda })` → `{ modelName, useCuda } | null`
(null when not pinned). `WhisperManager.onWakeFromSleep()` calls this first; if it returns null, the
method is a no-op (matches R1: only pinned engines get proactive lifecycle treatment). Otherwise it
proceeds exactly as today (`shouldRewarmOnWake` gate, `stopServer()` + `startServer()` replay) but
using the resolved `{ modelName, useCuda }` instead of `this.currentServerModel`/
`this.serverManager.useCuda` — so a transient non-pinned displacement active at the moment of sleep
doesn't get reloaded on wake in place of Dictation's actual pinned model. `shouldRewarmOnWake`'s own
signature and existing tests (`test/helpers/whisperWakeRewarm.test.js`) are unaffected.

### 10. Diagnostics

`getStatus()` on both `WhisperServerManager` and `ParakeetWsServer` (surfaced today via the
existing `whisper-server-status`/`parakeet-server-status` IPC channels) gains one new field,
`pinned: boolean`, for debug-log completeness and manual validation — no new UI.

### 11. Startup and shutdown wiring

- `WhisperManager.initializeAtStartup(settings)` / `ParakeetManager.initializeAtStartup(settings)`
  call `setPinned(...)` with the resolved pin state **regardless** of whether the pre-warm attempt
  itself runs or succeeds (e.g. model not downloaded yet), so pin bookkeeping is correct from the
  first tick even before any server has actually started. `main.js`'s existing
  `whisperSettings`/`parakeetSettings` objects (`main.js:550-566`) already carry everything needed
  (`localTranscriptionProvider`, `whisperModel`/`parakeetModel`, `useCuda`) — no signature changes
  needed there.
- `stop()` clears both `idleTimer` and any pending `respawnTimer` before returning (R10), so the
  existing `sidecarRegistry.register("whisper"/"parakeet", () => manager.stop())` shutdown path
  (already wired) fully quiesces this new state too. `sidecarRegistry.shutdownAll()`'s existing
  8-second outer deadline (`sidecarRegistry.js:3`) already bounds total shutdown time regardless of
  how long an individual `stop()`'s drain-wait takes, so no change is needed there.

## Validation Plan

### Automated

- **New `test/helpers/transcriptionEnginePinning.test.js`** — pure-function unit tests for
  `resolvePinnedEngines` and `isEngineDisplaced` (no mocking needed): asserts pin state for every
  combination of `useLocalWhisper`/`localTranscriptionProvider`/cloud mode, and displacement
  true/false for matching/mismatched model keys while pinned/not pinned.
- **New `test/helpers/whisperServer.test.js`** — mirrors `test/helpers/llamaServer.test.js`'s
  `Module._load` mocking of `child_process.spawn` and `../utils/serverUtils`:
  - (b) non-pinned engine schedules a 5-minute idle-stop after use; a second use before the window
    elapses resets the timer — via `t.mock.timers.enable({ apis: ["setTimeout"] })` +
    `t.mock.timers.tick(...)`, mirroring the existing pattern in
    `test/helpers/openaiRealtimeStreaming.test.js:176,190,193`. Also assert a **pinned** engine
    never schedules this timer (tick well past 5 minutes, assert `stop()`/kill was never called).
  - (a) pinned engine survives a simulated crash (fake process emits an unexpected `"close"`) and
    respawns after the first backoff delay without the next Dictation-shaped `start()` call paying
    a cold-start penalty beyond the scheduled respawn; asserts `crashCount` resets to 0 on the
    respawn's success; asserts that after `MAX_RESPAWN_ATTEMPTS` consecutive crashes, `gaveUp`
    becomes true, no further respawn is scheduled, but an explicit subsequent `start()` call (the
    lazy on-demand path) still proceeds normally rather than being permanently rejected.
  - Crash while **not** pinned: asserts a distinct `debugLogger.error`/`warn` call fires
    (spy/stub `debugLogger`) and asserts no respawn timer is scheduled.
  - (d) same-provider model change: `start()` with a different model than currently loaded, while
    pinned, stops the old process and starts the new one; a fake `transcribe()` promise left
    pending at the moment `start()` is called for a different model must still resolve
    successfully (not rejected/killed), and the old process's kill must not happen until that fake
    in-flight promise settles — proving the drain-before-stop behavior. Include a case where the
    in-flight promise never settles, asserting the `DRAIN_TIMEOUT_MS` ceiling eventually forces the
    swap anyway with a logged warning.
  - (e) a **pinned** engine is not evicted by a lower-priority non-pinned request for the *same*
    model (no-op swap) and — when the non-pinned request is for a *different* model — is displaced,
    then restored via `restorePinned()`/the explicit restore hook, per the resolution in Design §8.
  - `setPinnedTarget` transitioning `false → true` clears any pending idle timer and resets
    `crashCount`/`gaveUp`.
- **Extend `test/helpers/parakeetWsServer.test.js`** (already has the `Module._load` mocking
  scaffold for `../utils/serverUtils` and GPU detection) with the same set of assertions as above,
  plus: a live `createOnlineStream()` handle counts as in-flight for its whole lifetime, and a
  concurrent `start()` for a different model waits for that handle's `finish()`/`abort()` to settle
  (or the longer `STREAMING_DRAIN_TIMEOUT_MS` ceiling) before swapping — proving a live realtime
  dictation stream isn't corrupted by a concurrent settings change.
- **Extend `test/helpers/whisperWakeRewarm.test.js`** — new tests for
  `resolveWakeRewarmTarget({ pinned, pinnedModel, pinnedUseCuda })`: returns `null` when not pinned
  even if some model happens to be loaded; returns `{ modelName: pinnedModel, useCuda:
  pinnedUseCuda }` when pinned. Existing `shouldRewarmOnWake` tests are unaffected (signature
  unchanged) and must still pass unmodified.
- All new/updated tests run via the existing `npm test` (`node --test "test/helpers/*.test.js"
  "test/utils/*.test.js"`) — no new test runner/config needed.

### Manual

1. Set Dictation → Whisper `base`; relaunch the app. Check debug logs show "Pre-warming
   whisper-server" / "whisper-server pre-warmed successfully" and confirm **no** "Pre-warming
   parakeet server" log appears.
2. In Settings, change Dictation's model from `base` to `tiny` while idle (no recording in
   progress). Check debug logs show the whisper-server stopping and a fresh pre-warm completing for
   `tiny` within a few seconds — without waiting for a subsequent dictation to trigger the swap.
3. Start a longer dictation (push-to-talk, speak for several seconds); the instant it completes,
   switch the Whisper model in Settings. Verify the just-completed transcription pasted correctly
   (not corrupted/hung), and the model swap happens right after — confirming the drain-before-stop
   behavior doesn't interfere with a request that only just finished.
4. Configure Meeting's transcription model (Settings → Meeting) to a different Whisper model size
   than Dictation's. Start a Meeting recording; check debug logs show the shared whisper-server
   swapping to Meeting's model. Stop the recording; check debug logs show a proactive restore back
   to Dictation's pinned model within moments (not 5 minutes). Then press the Dictation hotkey and
   confirm normal (warm) response time.
5. Repeat step 4's setup, but simulate a missed cleanup (e.g. force-quit the control panel's
   webContents instead of using the Stop button) and wait 5+ minutes; verify the idle-timeout
   safety net eventually restores the pinned model (check logs for the self-heal restore line).
6. Configure Upload Audio with a different model than Dictation; run an Upload transcription;
   verify the same proactive restore-after-completion as step 4.
7. Kill the whisper-server process manually while Dictation is pinned to Whisper. Verify debug logs
   show a detected crash and a scheduled respawn with backoff, and that it comes back online within
   the expected window with no user action; verify the next Dictation hotkey press works normally
   once respawned.
8. Repeat step 7 five-plus times in a row to trigger "giving up." Verify the give-up log line
   appears, then verify a subsequent Dictation hotkey press still attempts a normal start (and
   succeeds once the underlying disruption — e.g. repeatedly killing it — stops), rather than being
   permanently broken.
9. Switch Dictation to cloud (BYOK) mode; verify both whisper-server and Parakeet are stopped and
   neither is pinned; verify a subsequent Meeting/Upload use of either engine now gets the 5-minute
   idle-stop instead of staying warm indefinitely.
10. Put the machine to sleep and wake it while Dictation is pinned to a CUDA Whisper model and a
    Meeting session had left a *different* model loaded at sleep time. Verify the wake-rewarm log
    shows the **pinned** model being reloaded, not whatever was loaded at sleep time.

### Docs

- **CLAUDE.md**: add a new numbered subsection under "Key Implementation Details" (following the
  existing 1–17 numbering, e.g. "18. Transcription Engine Lifecycle") documenting pinning, the
  5-minute idle-timeout for non-pinned use, and crash-respawn-with-backoff for pinned engines —
  cross-referencing this spec. Update the "whisper.cpp Integration" and "NVIDIA Parakeet
  Integration" sections' bullet lists to mention pinning/idle-timeout where they currently describe
  only startup pre-warming.
- **docs/RECREATION_SPEC.md §2** (Pipeline de Áudio e Transcrição): the existing description of
  same-provider model swaps as lazy-only (around the `serverManager.start()`/no-op-guard text) and
  of crash handling as silent must be updated to describe the new immediate-swap, idle-timeout, and
  crash-respawn behavior once implemented — otherwise RECREATION_SPEC.md becomes stale relative to
  its own stated purpose as the authoritative "current behavior" record.
- **docs/README.md**: no change needed (already indexes `docs/specs/` generically).

## Open Questions

1. Should "giving up" on proactive respawn for a pinned engine (R5, after `MAX_RESPAWN_ATTEMPTS`
   consecutive crashes) surface a user-visible notification/toast, or remain silent-but-logged as
   currently scoped? Adding a notification is a distinct, larger scope commitment (new i18n strings
   across all 9 languages, new UI wiring) that this spec currently excludes as a Non-goal — please
   confirm that's acceptable, or ask for it to be added.
2. The proposed constants (`DRAIN_TIMEOUT_MS = 15000`, `STREAMING_DRAIN_TIMEOUT_MS = 300000`,
   `RESPAWN_BACKOFF_MS`/`MAX_RESPAWN_ATTEMPTS` mirrored from `onnxWorkerClient.js`,
   `IDLE_TIMEOUT_MS` mirrored from `llamaServer.js`) are concrete proposals grounded in existing
   codebase conventions rather than the project owner's explicit input — flag if any should differ
   from what's proposed here before implementation.
