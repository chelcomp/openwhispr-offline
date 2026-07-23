# PCM Collector Stop-Flush Race Fix

## Status
Implemented

## TL;DR
- `AudioManager.stopRecording()` (`src/helpers/audioManager.js`) installs a temporary
  `onmessage` handler on `this._pcmCollector.port` to catch the AudioWorklet's async "done"
  sentinel, but the handler's closure re-reads `this._pcmCollector` when that message
  finally arrives — and several other code paths in the same class (`cleanup()`,
  `teardownSpeechGate()`, a failed `startRecording()` retry) can null or reassign
  `this._pcmCollector` before that async message lands, causing
  `TypeError: Cannot read properties of null (reading 'port')`.
- Worse than the visible crash: the throw happens *before* the closure calls `resolve()`,
  so `this._pcmFlushPromise` is left permanently unresolved whenever this fires on a flush
  a live `mediaRecorder.onstop` is still awaiting — a silent hang, not just a caught error.
- Fix: capture stable local references to the collector's `port` (and the in-flight
  `_pcmChunks` array) at the moment `stopRecording()` installs the handler, and operate
  only on those captured references inside the closure — never re-read `this._pcmCollector`
  or `this._pcmChunks` from inside the async callback. This makes the closure immune to any
  concurrent mutation of `this._pcmCollector` regardless of which code path causes it, so
  the fix is not gated on enumerating every racing caller exhaustively.
- No blocking open question — this is a self-contained robustness fix with no user-facing
  behavior change and no settings/schema/IPC surface change.
- Practical impact: no visible change in normal operation. The previously-possible
  console error and, in the affected recording's case, a silently-hung flush promise
  (which could leave that specific recording's transcription pipeline stalled) are both
  eliminated. There is no impact on the sub-500ms raw-transcription budget — this is
  entirely on the stop-recording/flush path, not the start/warm-up path.

## Problem / Goal

`AudioManager.stopRecording()` (`src/helpers/audioManager.js:1120-1148`) does the following
when a recording with an active AudioWorklet PCM collector is stopped:

1. Reads `this._pcmCollector.port.onmessage`'s current handler (the live streaming handler
   installed in `startRecording()`, `audioManager.js:1028-1037`).
2. Installs a temporary handler on `this._pcmCollector.port.onmessage` and stores a new
   `Promise` in `this._pcmFlushPromise`.
3. Posts `"stop"` to the worklet via `this._pcmCollector.port.postMessage("stop")`.
4. Calls `this.mediaRecorder.stop()`.

The worklet responds asynchronously with a stream of partial-chunk messages followed by a
`null`-data "done" sentinel. The installed handler distinguishes the two:

- Partial chunk (`event.data !== null`): pushes onto `this._pcmChunks`.
- Done sentinel (`event.data === null`): sets `this._pcmCollector.port.onmessage = null`
  (restoring/clearing the temporary handler) and calls `resolve()`.

Both branches re-read `this._pcmCollector` (and, for partial chunks, `this._pcmChunks`) from
`this` at the time the message arrives, not at the time the handler was installed. Between
installation and the async "done" message actually arriving, several other paths in the same
class can set `this._pcmCollector = null` or reassign it:

- `teardownSpeechGate()` (`audioManager.js:1161-1166`) — nulls `_pcmCollector` after
  disconnecting it. Called from the normal `mediaRecorder.onstop` handler
  (`audioManager.js:910`), but only *after* that handler's own
  `await this._pcmFlushPromise` (lines 905-908) — not racy in that single-recording,
  single-stop-call flow by itself. It is also called, however, from `cancelRecording()`'s
  own `onstop` replacement (`audioManager.js:1190-1191`) *without* awaiting
  `_pcmFlushPromise` at all.
- `cleanup()` (`audioManager.js:3620-3661`) — a fully synchronous method. When
  `this.mediaRecorder?.state === "recording"`, it calls `this.stopRecording()` (line 3627,
  which sets up the flush promise/handler described above) and then, still within the same
  synchronous call, unconditionally nulls `this._pcmCollector` directly at
  `audioManager.js:3651-3655` — with no await in between. Since the worklet's "done" message
  can only arrive on a later task/microtask (it crosses the Web Audio rendering thread), this
  ordering is a **guaranteed** race whenever `cleanup()` runs while a recording is in
  progress, not merely a rare timing coincidence. `cleanup()` is invoked from
  `useAudioRecording.js`'s `useEffect` cleanup (`src/hooks/useAudioRecording.js:377-387`) —
  fired on component unmount or whenever any of that effect's dependencies
  (`toast, onToggle, dismissToast, performStartRecording, performStopRecording, t`) change
  identity between renders, which can happen mid-recording.
- `startRecording()`'s own worklet-setup failure path (`audioManager.js:1039-1046`) — if a
  *new* recording's `AudioWorkletNode` construction throws, it sets `this._pcmCollector =
  null` for that new session. This only matters to an older, still-pending flush if that
  older flush's handler reads `this._pcmCollector` after this catch runs and before its own
  "done" message arrives — a narrower window than the `cleanup()` case above, but the same
  class of bug.

**Root-cause reconciliation with the observed report** ("transcription still completed
successfully" despite the crash): the crashing line (`this._pcmCollector.port.onmessage =
null`, `audioManager.js:1134`) throws *before* the adjacent `resolve()` call. If this fires on
the flush promise a *live, currently-awaited* `mediaRecorder.onstop` is blocked on, that
`onstop` would hang forever (never resolving `_pcmFlushPromise`), and that specific
recording's transcription would never complete — which contradicts the observation. The
consistent explanation, given `cleanup()` is the path that most directly and deterministically
produces `_pcmCollector === null` (as opposed to reassignment to a new object): the crash
occurred on an **abandoned** `AudioManager` instance — `cleanup()` ran (component
unmount/effect-dependency change) while that instance's recording was still stopping, its own
`onstop`'s flush hung silently and harmlessly since nothing was still awaiting that discarded
instance, while a **freshly-constructed** `AudioManager` instance (the same effect re-running)
handled the next/current recording and completed it normally. The visible console error and
the invisible hung promise are two symptoms of the same underlying bug on the old, torn-down
instance; the "successful transcription" the user saw came from the new instance, not the
crashing one. This matches the hypothesis in spirit (a stale `this._pcmCollector` read inside
an async closure, racing against another code path nulling it) but the dominant, most directly
reproducible trigger is `cleanup()` racing its own `stopRecording()` call — not the idle
"Persistent mic stream released after inactivity" timer path (`_scheduleStreamRelease()`,
`audioManager.js:817-827`), which was floated as something to investigate but does not touch
`_pcmCollector`/`_pcmFlushPromise`/`_pcmChunks` at all and is confirmed **not** implicated.

## Requirements

1. The handler `stopRecording()` installs on the PCM collector's port must never throw when
   invoked, regardless of what `this._pcmCollector` currently holds by the time the worklet's
   async messages arrive — it must operate on the specific collector/port instance that was
   live at the moment `stopRecording()` ran, not on whatever `this._pcmCollector` happens to
   be later.
2. The handler must always eventually call `resolve()` on its own flush promise once the
   "done" sentinel arrives — the fix must not leave `this._pcmFlushPromise` permanently
   unresolved under any of the racing conditions above. (This closes the latent hang
   described in Problem/Goal, not just the visible crash.)
3. Partial PCM chunks arriving on the captured port between "stop" being posted and "done"
   being received must be appended to the specific chunks array that was in use for that
   recording at the time `stopRecording()` ran — not to whatever `this._pcmChunks` happens to
   reference by the time the message arrives (which `startRecording()` may already have reset
   to a fresh empty array for a new, overlapping recording). This must be a no-op behavior
   change for the existing single-recording, non-overlapping flow: `onstop`
   (`audioManager.js:921`) reads `this._pcmChunks` after already awaiting the same flush
   promise, so in the ordinary case it is reading the identical array object either way.
4. No change to any public method's signature, IPC surface, settings key, or user-visible
   behavior. This is an internal robustness fix confined to `stopRecording()`'s closure.
5. No new blocking wait, timeout, or delay is introduced on the stop→transcribe handoff. The
   fix only changes *what* the existing closure reads/writes, not *when* it runs or what it
   waits on.

## Non-goals

- Auditing or restructuring every caller that can null/reassign `this._pcmCollector`
  (`teardownSpeechGate()`, `cleanup()`, `startRecording()`'s failure path, `cancelRecording()`)
  — the fix is deliberately path-agnostic (Requirement 1) precisely so this isn't necessary.
  None of those call sites need to change.
- Changing `useAudioRecording.js`'s `useEffect` dependency array or reducing how often its
  cleanup fires — that effect legitimately needs to reconstruct `AudioManager` when its
  dependencies change; the fix belongs in `AudioManager` being robust to that, not in
  preventing the effect from re-running.
- Any change to the confidence-gated VAD batching mechanism (§19 in CLAUDE.md), the WebM
  fallback path, or `processAudio()` — none of those are touched by or relevant to this race.
- Deduplicating or guarding against overlapping recordings at a higher level (e.g. preventing
  `startRecording()` from running while a previous recording's flush is still pending) — out
  of scope; the fix makes the existing overlap harmless rather than preventing the overlap
  itself.

## Design

### `src/helpers/audioManager.js` — `stopRecording()` (currently `audioManager.js:1120-1148`)

At the point where `stopRecording()` currently reads `this._pcmCollector` to install the
temporary flush handler, capture two local `const` references instead of repeatedly reading
`this` inside the closure:

- A reference to the collector's `port` object itself (the thing the temporary handler is
  actually installed on and later cleared).
- A reference to the `this._pcmChunks` array that is live at that exact moment (the same
  array `onstop` will later read once the flush resolves, in the ordinary non-overlapping
  case).

The closure installed on the captured port's `onmessage` must then:

- On a partial chunk (`event.data !== null`): push the decoded `Int16Array` onto the
  **captured** chunks array reference, not `this._pcmChunks`.
- On the "done" sentinel (`event.data === null`): clear the handler on the **captured** port
  reference (`port.onmessage = null`) and call `resolve()` — in that order, matching the
  existing code's intent, but operating only on locals that cannot have been invalidated by
  any other method in the class.

`this._pcmCollector.port.postMessage("stop")` (the outbound message that triggers this whole
flow) is likewise sent via the captured port reference, for the same reason.

No other line in `stopRecording()` changes: the outer `if (this._pcmCollector)` guard, the
`this.mediaRecorder.stop()` call, and the return value are unaffected.

Note on the existing `const orig = this._pcmCollector.port.onmessage;` line
(`audioManager.js:1130`): despite its name and the adjacent "restore normal handler" comment,
today's code never actually restores `orig` anywhere — the done-sentinel branch only ever
nulls the handler, it doesn't reassign it back to `orig`. This was already dead code before
this fix. The fix drops this capture entirely rather than preserving it — do not carry it
forward under the new local-reference scheme, and do not attempt to "fix" it into an actual
restore, since that would be a behavior change outside this spec's scope.

**Why "capture a stable reference" is preferred over a defensive `if (this._pcmCollector)`
null-check inside the closure (both were on the table):** a null-check alone would silence the
crash but not fix the actual defect, because it only guards the *exception*, not the
*correctness* of what `this._pcmCollector` points to. If a new recording has started and
reassigned `this._pcmCollector` to a brand-new `AudioWorkletNode` (rather than nulling it) by
the time the old "done" message arrives, a defensive null-check would still be truthy — and
the old closure would incorrectly clear the *new* recording's live streaming handler
(`onmessage = null`), silently breaking that new recording's PCM collection with no crash and
no log. Capturing the specific `port` instance at install time sidesteps this entirely: the
closure only ever touches the exact port object it was created for, so it is correct whether
`this._pcmCollector` later becomes `null`, gets reassigned to something else, or is untouched.
No additional defensive null-check is needed once the reference is stable.

### No other files change

This fix is confined to the body of `stopRecording()` in `src/helpers/audioManager.js`. No
IPC channel, settings key, preload surface, or UI component is touched.

## Validation Plan

- **Automated**: add a new test file, `test/helpers/audioManagerStopRace.test.js`, using the
  same esbuild-transform + happy-dom harness pattern already established in
  `test/helpers/audioManagerWarmup.test.js` (real, unmodified `src/helpers/audioManager.js`
  loaded via a CommonJS require hook; `Object.create(AudioManager.prototype)` to bypass the
  constructor; minimal manual stubbing of only the fields a given test touches).
  - Construct a manager instance with `screenContextCache: { recordRecordingStopped: () =>
    {} }` (stubbed, since `stopRecording()` calls it unconditionally), `mediaRecorder: {
    state: "recording", stop: () => {} }`, a mock `_pcmCollector` whose `port` is a plain
    object supporting `onmessage` assignment and a no-op `postMessage()`, and `_pcmChunks:
    []`.
  - Call `stopRecording()`. Capture the handler the mock port's `onmessage` was just set to.
  - Simulate the race: set `manager._pcmCollector = null` (mimicking `cleanup()`/
    `teardownSpeechGate()` having already torn it down) **before** invoking the captured
    handler.
  - Invoke the captured handler with `{ data: null }` (the "done" sentinel), wrapped in an
    assertion that this call does **not** throw. This first assertion must run and be
    evaluated **before** anything awaits `manager._pcmFlushPromise` — before the fix, the
    handler throws synchronously here (`Cannot read properties of null`), so the test fails
    cleanly at this assertion. Only after that assertion passes should the test proceed to
    `await manager._pcmFlushPromise` and assert it resolves. This ordering matters: if the
    "no throw" and "resolves" checks were combined into a single bare `await` on the promise
    without first isolating the synchronous-throw assertion, the before-fix run would hang the
    test runner instead of failing fast (since a promise that never rejects and never resolves
    just hangs `await`, it doesn't throw) — keep the two assertions sequential and distinct,
    in this order, for exactly that reason.
  - The `await manager._pcmFlushPromise` assertion directly exercises Requirement 2 (no
    permanent hang) — the more severe half of this bug, which the no-throw assertion alone
    would not catch (a defensive-only fix could suppress the exception while still never
    calling `resolve()`, still leaving the promise permanently pending).
  - Add a second case proving Requirement 3: install a partial-chunk message (`event.data !==
    null`, some `ArrayBuffer`) on the captured handler *after* `manager._pcmChunks` has been
    reset to a new, different array (simulating an overlapping `startRecording()` call reset),
    then send the "done" sentinel; assert the partial chunk landed in the *original* captured
    array (captured at `stopRecording()`-time), not in the new `manager._pcmChunks` array —
    and that the original array is unaffected/uncorrupted in the overlap case.
  - This test file fails before the fix (synchronous throw on the first case) and passes
    after — satisfying the mandatory pre-fix-fails/post-fix-passes regression-test rule.
  - Run via the existing `npm test` (node's built-in test runner); no `package.json` changes
    needed.
- **Manual**:
  1. Enable debug mode (`--log-level=debug` or `EKTOSWHISPR_LOG_LEVEL=debug`).
  2. Perform several back-to-back Dictation recordings in quick succession (start, stop
     immediately, start again before the previous one's transcript has necessarily finished
     rendering), including at least one case where the control panel or overlay window is
     closed/reopened immediately after a stop (to encourage the `useAudioRecording.js` effect
     to unmount/remount mid-flush).
  3. Watch the renderer devtools console throughout: confirm no `TypeError: Cannot read
     properties of null (reading 'port')` (or any related uncaught error from this closure)
     appears.
  4. Confirm every recording in the sequence still produces a pasted transcript (no recording
     silently hangs/never completes) — this specifically checks the "hang" failure mode
     (Requirement 2), not just the absence of the console error.
- **Docs**: this is an internal robustness fix with no externally observable behavior change
  and no new mechanism worth documenting in CLAUDE.md. `docs/RECREATION_SPEC.md`'s existing
  description of the `stopRecording()`/PCM-collector flow (§2.2, around the "AudioWorklet PCM
  collector" paragraph) does not describe this closure's internals today and does not need a
  correction — no update required there either. If, once implemented, `spec-executor` judges
  the closure's hardening worth a one-line mention for future maintainers, that is at their
  discretion but is not required by this spec.

## Open Questions

None — this fix is self-contained, has no BYOK/UI/settings surface, and no design ambiguity
remains after the investigation above.
