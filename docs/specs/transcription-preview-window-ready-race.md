# Fix Live Transcription Preview overlay silently missing its first update (renderer-not-ready race)

## Status
Implemented

## TL;DR
The "Live Transcription Preview" overlay (Settings toggle `showTranscriptionPreview`) intermittently
shows nothing during dictation because `windowManager.js` sends the very first `preview-text` IPC
event to the overlay's `BrowserWindow` right after `loadFile`/`loadURL` resolves — but that promise
resolves at `did-finish-load`, which fires *before* the React overlay (`TranscriptionPreviewOverlay.tsx`)
has mounted and registered its `onPreviewText` listener in preload. The event is sent into a window
with no listener yet and is lost forever; nothing else re-sends it, so the overlay stays invisible for
the entire dictation. This only bites the first dictation after the preview window is freshly created
(app launch, or after the window was destroyed/closed) — every subsequent dictation in the same
session usually works because the window/React app is already loaded — which matches the "recurring,
seems fixed then breaks again" complaint (it reproduces reliably on every fresh app start, the most
common state for a background-launched app).

- What's changing: `windowManager.js` gets an explicit renderer-ready handshake for the transcription
  preview window instead of assuming `loadFile`/`loadURL` resolving means the React app is ready to
  receive IPC events; the overlay tells main process at end of first mount.
- Decisions made:
  - Add a new one-way IPC message, `transcription-preview-ready`, sent by
    `TranscriptionPreviewOverlay.tsx` from its mount effect (after its `onPreviewText`/etc. listeners
    are registered), and a matching `notifyTranscriptionPreviewReady` exposed on `window.electronAPI`
    via `preload.js`.
  - `windowManager.js` tracks per-window readiness and buffers/queues `showTranscriptionPreview`/
    `appendTranscriptionPreview`/etc. calls made before the ready signal arrives, flushing them in
    order once it lands, instead of sending into a void.
  - A bounded timeout (e.g. 3s) prevents an indefinitely stuck preview if the renderer never signals
    ready (e.g. load failure) — falls back to sending anyway so behavior degrades to "as bad as today,"
    never worse.
  - Readiness resets whenever the window is recreated (new `BrowserWindow`, `loadFile`/`loadURL`
    called again).
- No blocking open question — this is a self-contained, verifiable timing fix in first-party code.
- Practical impact: the preview overlay should now reliably show and update text on the very first
  dictation after each app launch, not just on subsequent ones within the same session.

## Problem / Goal

`docs/specs` context gathered this session confirms the wiring (window creation, IPC channels, preload
bridge, `TranscriptionPreviewOverlay.tsx` listeners) is intact end-to-end, yet the project owner reports
the overlay is recurrently not showing/updating live text — and says this isn't the first time.

Root cause found by reading current code (`src/helpers/windowManager.js`):

```
async ensureTranscriptionPreviewWindow() {
  if (this.transcriptionPreviewWindow && !this.transcriptionPreviewWindow.isDestroyed()) return;
  this.transcriptionPreviewWindow = new BrowserWindow(TRANSCRIPTION_PREVIEW_CONFIG);
  ...
  await this.transcriptionPreviewWindow.loadFile(...) // or loadURL(...)
}

async showTranscriptionPreview(text) {
  await this.ensureTranscriptionPreviewWindow();
  ...
  this.transcriptionPreviewWindow.webContents.send("preview-text", text);
  this.transcriptionPreviewWindow.showInactive();
  ...
}
```

`ipcHandlers.js`'s `start-dictation-preview` handler calls `this.windowManager.showTranscriptionPreview("")`
as its very first action, before any transcription audio has even been processed. On a cold preview
window (first dictation since app launch, or any time the window was previously closed/destroyed),
this is the *first* time `ensureTranscriptionPreviewWindow()` creates the `BrowserWindow` and awaits its
`loadFile`/`loadURL` promise. That promise resolves once Electron's `did-finish-load` fires — which only
guarantees the HTML document and its immediate resources have loaded, not that the bundled React app
has executed, mounted `TranscriptionPreviewOverlay`, and its `useEffect` has run
`window.electronAPI?.onPreviewText?.(...)` to register the IPC listener in the renderer. `webContents.send`
delivers the message immediately with no listener attached in the renderer at that moment, and
Electron does not queue or replay `ipcRenderer` messages sent before a listener subscribes — the event
is simply lost. Since nothing re-sends the initial state and every subsequent call in that recording
(`appendTranscriptionPreview`, `holdTranscriptionPreview`, ...) also just does a bare
`webContents.send` with the same "hope a listener is already there" assumption, the entire dictation's
live preview is silently dark, with **no error, no warning, no log line** anywhere — it just doesn't
work, and it looks identical to the feature toggle being broken.

This uniquely explains the "recurring" character of the bug: it reproduces reliably right after a fresh
`BrowserWindow` is created (most commonly the first dictation after each app launch — the common case
for a background-launched app the user restarts often), while dictations later in the same session,
where the window/React app is already loaded, aren't affected — so the bug appears to "come and go."

**Secondary hardening candidate investigated and ruled out as primary cause, but worth closing while
here**: `audioManager.js` wraps the shared gate-context setup (`_gateCtx`/`_gateSource`/`_gainNode`,
used for both the unrelated silence/speech-gate feature and the preview's audio worklet) in a
try/catch (`startRecording()`, ~line 647-681) that on failure only logs
`logger.warn("Audio level gate setup failed, skipping", ...)` and silently leaves `_gateCtx`/`_gainNode`
falsy — which flows into the `showTranscriptionPreview && useLocalWhisper && this._gateCtx && this._gainNode
&& this._gateWorkletLoaded` gate (line ~832) evaluating false with zero user-facing signal. This is a
second silent-failure path for the same user-visible symptom ("preview toggle is on, nothing shows"),
just triggered by a different condition (AudioContext/audio-graph setup failing) rather than the
IPC-timing race above. It's included in this spec's regression test coverage (see Validation Plan) as a
targeted assertion, but the fix itself is scoped to the confirmed, reproducible IPC race — turning that
failure into something more visible than a debug-level log line is listed as an Open Question rather
than a decided design, since making it "louder" (e.g., a toast) risks being noisy for a purely
best-effort speech-gate feature that has its own long-standing silent-catch precedent elsewhere in this
file.

## Requirements

- The very first `preview-text` (and any other `preview-*`) event sent to a freshly created/loaded
  transcription preview `BrowserWindow` must reach a renderer that has already registered its IPC
  listeners — no event may be sent into a window before its renderer is ready to receive it.
- The fix must not introduce an arbitrary fixed `setTimeout` sleep as the readiness signal — it must be
  a real handshake (renderer explicitly tells main it's ready) with a bounded timeout fallback so a
  broken/slow renderer degrades to at-worst today's behavior, never a hang.
- Readiness state must be scoped per window instance — recreating the `BrowserWindow` (new instance
  after `closed`, or a fresh `loadFile`/`loadURL` call) must reset readiness; a stale "ready" flag from
  a previous window instance must never let events skip the handshake for a new one.
- No change to the existing IPC channel names/payloads for `preview-text`, `preview-append`,
  `preview-hold`, `preview-result`, `preview-cleanup-update`, `preview-hide` — only the *timing* of when
  `windowManager.js` is allowed to call `webContents.send` for them changes.
- The fix must not add any new settings key, localStorage key, or persisted schema (this is a pure
  timing/race fix, not a feature change) — Non-Negotiable Product Premise §6 (migration safety) is
  N/A here.
- No new network calls, no new listener bound to anything other loopback — N/A here since this only
  touches an existing in-process Electron IPC path (Non-Negotiable Product Premise §1).
- Must not regress the sub-500ms raw-transcription budget (Non-Negotiable Product Premise §3): the
  preview overlay is a display-only side effect of dictation, not on the raw-transcript critical path,
  and the fix must keep it that way — the handshake buffering must be async/non-blocking with respect
  to `whisperManager`/`parakeetManager` transcription calls, never awaited by the transcription pipeline
  itself.

## Non-goals

- Not attempting to fix or harden every other silent-catch pattern in `audioManager.js` unrelated to
  this specific overlay symptom.
- Not changing the overlay's visual design, animation, or `TARGET_WIDTH`/position logic.
- Not adding a general "renderer window ready" abstraction reused by other overlay windows
  (agent overlay, meeting notification window) — scoped to the transcription preview window only. A
  shared abstraction can be a follow-up spec if the same race is later found elsewhere.
- Not changing `start-dictation-preview`'s decision of *when* to call `showTranscriptionPreview("")` —
  only how `windowManager.js` guarantees that call is deliverable.

## Design

### 1. Renderer: signal readiness after listeners are registered

In `src/components/TranscriptionPreviewOverlay.tsx`, inside the existing `useEffect` that registers
`onPreviewText`/`onPreviewAppend`/`onPreviewHold`/`onPreviewResult`/`onPreviewCleanupUpdate`/`onPreviewHide`
(the effect with the empty-ish dependency array around line 120-204), after all six listeners are
registered, call a new bridge method — e.g. `window.electronAPI?.notifyTranscriptionPreviewReady?.()` —
exactly once. This must happen synchronously within that effect body (not in a nested async callback or
`requestAnimationFrame`), so it fires as soon as React has committed the mount and the effect runs — no
artificial delay is being introduced here, just an explicit truthful signal instead of assuming
`did-finish-load` implies it.

### 2. Preload: expose the new one-way channel

In `preload.js`, alongside the existing `onPreviewText`/etc. entries (~line 671-697), add:

```
notifyTranscriptionPreviewReady: () => ipcRenderer.send("transcription-preview-ready"),
```

(exact placement/style to match the existing `sendDictationPreviewAudio` fire-and-forget pattern
immediately below it).

### 3. Main process: track readiness per window instance, buffer, flush, timeout

In `src/helpers/windowManager.js`:

- Add two new pieces of instance state alongside `this.transcriptionPreviewWindow`:
  `this._transcriptionPreviewReady` (boolean, reset to `false` every time a new `BrowserWindow` is
  constructed in `ensureTranscriptionPreviewWindow()`) and `this._transcriptionPreviewPendingSends`
  (an ordered queue of `{ channel, payload }` — or simply closures — captured before readiness).
- Register `ipcMain.on("transcription-preview-ready", (event) => { ... })` once (e.g. in the
  constructor or an init method already run once at startup, matching how other one-time
  `ipcMain.on`/`ipcMain.handle` registrations are wired in this codebase's `ipcHandlers.js`/`main.js` —
  the handler must confirm `event.sender === this.transcriptionPreviewWindow?.webContents` before
  accepting the signal, so a stale message from an already-destroyed prior window instance can never
  mark the *current* window ready). On acceptance: set `_transcriptionPreviewReady = true`, clear any
  pending timeout fallback timer, and flush `_transcriptionPreviewPendingSends` in FIFO order via the
  window's real `webContents.send`, then empty the queue.
- Introduce a small private helper, e.g. `_sendToPreviewWindow(channel, payload)`, used by
  `showTranscriptionPreview`, `appendTranscriptionPreview`, `holdTranscriptionPreview`,
  `updateCleanupPreview`, `completeTranscriptionPreview`, and `hideTranscriptionPreview` instead of
  their current direct `this.transcriptionPreviewWindow.webContents.send(...)` calls: if
  `_transcriptionPreviewReady` is true, send immediately (today's behavior, unchanged cost); if false,
  push `{channel, payload}` onto `_transcriptionPreviewPendingSends` instead of sending.
- In `ensureTranscriptionPreviewWindow()`, when a new `BrowserWindow` is created: reset
  `_transcriptionPreviewReady = false`, clear any leftover pending-sends queue from a prior instance,
  and start a bounded fallback timer (e.g. 3000ms, named constant
  `TRANSCRIPTION_PREVIEW_READY_TIMEOUT_MS`) that, if it fires before the ready signal arrives, sets
  `_transcriptionPreviewReady = true` and flushes the queue anyway — this bounds the worst case to
  "identical to today's occasionally-broken behavior," never a permanent hang, and covers any renderer
  bundle that fails to load its i18n/UI dependencies in dev vs. prod builds.
- `showInactive()`/`WindowPositionUtil.setupAlwaysOnTop(...)` calls that currently sit right next to the
  `webContents.send` in `showTranscriptionPreview`/`completeTranscriptionPreview` are display-window
  operations, not IPC — they are safe to run immediately (making the window visible early is harmless;
  it will just show its default "listening" empty state per `TranscriptionPreviewOverlay.tsx`'s own
  `isVisible`/`phase` initial state until the buffered `preview-text` event lands) and should stay
  unbuffered/immediate, only the `webContents.send(...)` calls route through the new buffering helper.
- On the window's existing `"closed"` handler (`this.transcriptionPreviewWindow.on("closed", ...)`),
  also reset `_transcriptionPreviewReady = false` and clear the pending queue, so a subsequent
  `ensureTranscriptionPreviewWindow()` call starts clean (defensive; the constructor-time reset already
  covers the main path, but this avoids any window between `closed` firing and the next
  `ensureTranscriptionPreviewWindow()` call where stale state could theoretically be read).

### 4. Files touched

- `src/components/TranscriptionPreviewOverlay.tsx` — call the new ready-notify bridge method once per
  mount, inside the existing listener-registration effect.
- `preload.js` — add `notifyTranscriptionPreviewReady`.
- `src/helpers/windowManager.js` — readiness state, buffering helper, timeout fallback, `closed`-handler
  reset; route all six `preview-*` `webContents.send` call sites through the new helper.
- No IPC channel additions in `ipcHandlers.js` are required — the new `transcription-preview-ready`
  channel is owned/registered directly by `windowManager.js` since it's purely about that window's
  readiness, not part of the existing dictation-preview session state machine `ipcHandlers.js` already
  owns.

## Validation Plan

### Automated

1. **New: `test/helpers/transcriptionPreviewWindowReady.test.js`** (Node's built-in `node --test`,
   matching this repo's existing `test/helpers/*.test.js` style — see `whisperStreamingSession.test.js`
   for the mocking convention). This is the primary regression test and must demonstrably fail against
   today's code and pass after the fix:
   - Build a minimal fake `BrowserWindow`/`webContents` double (a plain object with a `send` spy, an
     `on` method to capture the `"closed"` listener, `isDestroyed()` returning `false`, `loadFile`/
     `loadURL` returning a `Promise` the test controls the resolution timing of) and a fake `ipcMain`
     double (capturing the handler registered for `"transcription-preview-ready"`).
   - Require `windowManager.js` with these doubles injected the same way existing helper tests inject
     fakes (check `test/helpers/*.test.js` for the established Electron-mocking pattern used in this
     repo, e.g. via `Module._cache`/dependency injection or a constructor-injected `deps` object — match
     whatever convention already exists rather than inventing a new one).
   - **Test A (reproduces the bug)**: call `showTranscriptionPreview("hello")` before invoking the
     fake `"transcription-preview-ready"` handler (simulating `loadFile` resolving before the renderer
     mounts) and assert `webContents.send` was **not** called with `"preview-text"` yet (i.e., it's
     queued, not lost) — then invoke the ready handler and assert `webContents.send("preview-text",
     "hello")` fires exactly once, in order, after readiness. Against today's unfixed code (no
     buffering), this test must fail because `send` fires immediately/unconditionally regardless of
     readiness (there is no ready gate to hold it back) — confirming the test would have caught the
     original race.
   - **Test B (ordering)**: call `showTranscriptionPreview("a")`, `appendTranscriptionPreview("b")`,
     `holdTranscriptionPreview({showCleanup: false})` all before ready, then fire ready — assert all
     three sends flush in the same order they were queued.
   - **Test C (timeout fallback)**: using a fake/mock timer (Node's `node:test` supports
     `context.mock.timers`, or a manually injectable clock), assert that if the ready signal never
     arrives, the queued sends are flushed anyway after `TRANSCRIPTION_PREVIEW_READY_TIMEOUT_MS`.
   - **Test D (stale-window guard)**: simulate a `"transcription-preview-ready"` message whose
     `event.sender` does not match the *current* `transcriptionPreviewWindow.webContents` (i.e., from a
     previously destroyed window instance) and assert it does NOT mark the current window ready /
     does NOT flush the current queue.
   - **Test E (per-instance reset)**: after Test A's window is marked ready and then "closed" (fire the
     captured `closed` listener), call `ensureTranscriptionPreviewWindow()` again (new fake window) and
     assert the new instance starts unready (a `showTranscriptionPreview` call queues again rather than
     sending immediately) — i.e. readiness doesn't leak across window instances.

2. **New: `test/components/TranscriptionPreviewOverlay.test.jsx`** (React Testing Library, run under
   `node --test` — this is a new test category for the repo; see "Docs" below for the accompanying
   `package.json`/test-runner changes required). Scope: exercise the actual gating/mounting behavior
   described in the root cause, not a trivial existence check.

   **DOM shim decision (resolved — project owner approved RTL now, jsdom deferred)**: use
   `@happy-dom/global-registrator` rather than `jsdom` directly. Justification: it is purpose-built for
   exactly this scenario (registering `window`/`document`/etc. as Node globals for a non-jsdom-aware test
   runner like `node --test`, via a single `GlobalRegistrator.register()` call at the top of a setup
   file, and `GlobalRegistrator.unregister()` in an `after()` hook), is materially lighter/faster to
   install and run than `jsdom` (smaller dependency tree, no native bindings), and is sufficient for
   RTL's `render()`/`fireEvent`/`screen` APIs, which is all this test needs. This keeps the "minimal DOM
   shim only as needed to make RTL's render() work" framing from the project owner's decision — it is
   not a full jsdom-based component-testing environment adoption. A fuller jsdom-based setup (e.g. if
   future component tests need broader DOM API fidelity — canvas, more exotic layout/events — that
   happy-dom doesn't cover) is noted here as a documented future option, not built now.

   - Add exactly three new devDependencies: `@testing-library/react`, `@testing-library/dom`, and
     `@happy-dom/global-registrator`. (`esbuild` is not added as a new direct devDependency — see next
     bullet — since it is already resolvable as a transitive dependency of Vite; the loader script
     requires it directly at its installed transitive version rather than pinning a new top-level entry,
     consistent with keeping this infra addition as small as possible.)
   - Since this repo's `test` script runs `node --test` directly against `.js`/`.test.js` files with no
     TSX transform configured, add a small esbuild-based transform step so `node --test` can execute a
     `.tsx` test file — a thin loader/register script (`test/setup/tsxRegister.js`) using
     `esbuild.transformSync` with `loader: "tsx"`, `jsx: "automatic"` to compile
     `TranscriptionPreviewOverlay.tsx` and its test file to CJS on the fly. This same setup file calls
     `GlobalRegistrator.register()` before any React/ReactDOM import (happy-dom must own the globals
     first) and registers an `after()` hook that calls `GlobalRegistrator.unregister()` so it never leaks
     into other `node --test` files run in the same process/suite. This mirrors how this repo already has
     no Jest/Vitest and intentionally stays on `node --test` (do not introduce Jest/Vitest as a parallel
     runner).
   - Update `package.json`'s `"test"` script to also include `"test/components/*.test.jsx"` (or
     `.test.js` if the test file itself is plain JS driving a required-and-transformed `.tsx` — whichever
     the loader setup makes simplest) in the glob list, invoked with `--import ./test/setup/tsxRegister.js`
     (or equivalent `node --test` loader flag) so the shim/transform is active only for that file, not
     globally for every existing `test/helpers/*.test.js` file (avoids any risk of happy-dom globals
     leaking into or altering behavior of the existing non-DOM Node-side tests).
   - Test body: render `<TranscriptionPreviewOverlay />` with `window.electronAPI` mocked so
     `onPreviewText` (and friends) capture the registered callback instead of doing nothing, per RTL
     conventions (`render()`, then act as if main process fired the event by invoking the captured
     callback, then assert the DOM shows the expected `activeText`/`phase`). Cases:
     - Asserts `window.electronAPI.notifyTranscriptionPreviewReady` is called exactly once after mount
       (this is the concrete, testable proof the renderer performs its half of the handshake — this
       assertion is the one that would fail if a future refactor accidentally removes/reorders the
       ready call relative to listener registration).
     - Asserts that firing the captured `onPreviewText` callback after mount updates the visible text
       (`"live"` phase, correct `activeText`) — the existing "does the wiring work once delivered"
       baseline, still worth locking in since nothing in the repo currently does this for this
       component.
   - This test intentionally does NOT attempt to simulate Electron's real `did-finish-load`-vs-mount
     race (that's `windowManager.js`'s job in Test A above) — its job is to prove the renderer half of
     the handshake contract is upheld.

3. **Existing test files unaffected** — `test/helpers/whisperStreamingSession.test.js`,
   `test/helpers/openaiRealtimeStreaming.test.js`, and the rest of `test/helpers/*.test.js` /
   `test/utils/*.test.js` / `test/models/*.test.js` should all continue to pass unmodified; this change
   does not alter their subject matter.

### Manual

1. Enable Settings → General/Privacy (wherever `showTranscriptionPreview` toggle currently lives) →
   "Live Transcription Preview."
2. Fully quit the app (not just close the window) to guarantee the preview `BrowserWindow` does not
   exist yet.
3. Relaunch the app, then immediately trigger dictation (hotkey) and speak a short phrase.
4. Confirm the overlay appears and updates with live partial text during this very first dictation of
   the session — before the fix, this specific first-after-launch case is the one most likely to show
   nothing.
5. Repeat steps 3-4 for a second, third dictation in the same app session (window now warm) to confirm
   no regression to the already-working case.
6. Toggle the preview overlay's "X" (dismiss) mid-dictation, then start a new dictation, to confirm the
   window-closed/reset path (`_transcriptionPreviewReady` reset) doesn't leave the next dictation's
   preview stuck queued forever (bounded by the same manual observation as step 3-4, since dismissal
   hides rather than destroys the window in today's `hideTranscriptionPreview()` — confirm this still
   works if `dismissDictationPreview` also ends up destroying the window via any code path touched by
   this change).

### Docs

- `CLAUDE.md`: no architectural section currently documents the transcription preview window's IPC
  lifecycle in detail; none of its Helper Modules descriptions need updating since `windowManager.js`'s
  responsibilities remain summarized at the same level of detail as today (it does not currently
  mention `preview-*` channels at all). No changes required.
- `docs/RECREATION_SPEC.md`: check whether it documents `showTranscriptionPreview`/the preview overlay
  IPC flow anywhere (search for `preview-text`/`transcriptionPreviewWindow`); if so, update to describe
  the new ready-handshake/buffering behavior so the doc doesn't describe the old immediate-send
  assumption once this ships. `spec-executor` must grep for this before marking the spec Implemented.
- `docs/README.md`: no index changes needed — this is a bugfix to existing documented functionality, not
  a new doc.

## Open Questions

- Should the secondary silent-catch path in `audioManager.js` (gate-context setup failure silently
  disabling preview with only a debug-level log, described in Problem/Goal) get a more visible
  diagnostic (e.g., a one-time toast, or at minimum a `logger.warn` promoted to something surfaced in
  Settings/debug UI) as a follow-up? This spec's regression test suite documents the condition but does
  not change its behavior — left to the project owner to decide if it merits its own spec, since making
  a best-effort/graceful-degradation path noisier is a product-taste call, not a pure bugfix.

**Resolved — test infra for the component test (previously open)**: the project owner decided to proceed
now with React Testing Library for `test/components/TranscriptionPreviewOverlay.test.jsx`, using the
lightest DOM shim that makes RTL's `render()` work under `node --test` rather than adopting a full
jsdom-based component-testing environment. Per the DOM-shim decision above, that shim is
`@happy-dom/global-registrator` (not `jsdom`) — see the Validation Plan §2 for the exact registration/
teardown mechanics and the three new devDependencies this introduces
(`@testing-library/react`, `@testing-library/dom`, `@happy-dom/global-registrator`). A fuller jsdom-based
component-testing environment (broader DOM API fidelity for future component tests) is noted here as a
possible future follow-up, explicitly not in scope for this spec.
