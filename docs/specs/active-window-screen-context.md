# Active-Window Screen Context for LLM Passes

## Status

Implemented

**Implementation notes (spec-executor)**: the pure-JS/backend layer (environment.js
getters, screenContextStorage.js, screenContextRetentionSync.js, tesseractOcrManager.js,
activeWindowCapture.js, activeWindowOcr.js, screenContextCache.js, the
shouldCaptureScreenContext gate, the database migration, and the full IPC/preload surface)
is implemented and covered by automated tests (all passing). Three deliberate,
disclosed deviations from the letter of the Design section:

1. The cheap "same app" identity check (Requirement 13) reuses the existing
   `activeAppCapture.detectAsync()`/`windows-fast-paste.exe --detect-only` path via a new
   `detect-active-app-for-screen-context` IPC channel, rather than adding a new
   `--identify-only` mode to `windows-active-window-info.exe` — the Design section explicitly
   left this choice to execution ("whichever is empirically fastest").
2. The Tesseract.js OCR fallback calls the `tesseract.js` npm package directly from
   `activeWindowOcr.js` rather than routing through the ONNX utility process's worker
   protocol — functionally equivalent (lazy, on-demand, gated on
   `tesseractOcrManager.isDownloaded()`), but not wired into `onnxWorker.js` as the Design
   section's reference implementation describes. Flagged as a mechanical follow-up (still
   open — only the missing-dependency defect from the first pr-reviewer pass was fixed, not
   this architectural deviation).
3. **Validated on real Windows hardware (updated after a live-testing pass)**:
   `windows-active-window-info.c` was originally broken C++-in-.c GDI+ usage (a `Bitmap`
   class instance and `using namespace Gdiplus`, neither of which compiles as C) and has
   been rewritten against GDI+'s flat C API (`GdipCreateBitmapFromHBITMAP`,
   `GdipSaveImageToStream`, `GdipDisposeImage`, `COBJMACROS`/`IStream_Release`). Compiles
   clean with MinGW/Clang and produces correct protocol output (the JSON metadata header
   followed by a valid PNG). A new local-compile-first build script,
   `scripts/build-windows-active-window-info.js`, mirrors `build-windows-key-listener.js`'s
   strategy (up-to-date check → compile locally → download-prebuilt fallback) and is now
   the primary path in `compile:native`; the original download-only script and CI workflow
   remain as the fallback. Separately, the native Windows OCR PowerShell bridge in
   `activeWindowOcr.js` was found to be silently non-functional end-to-end on real
   hardware — it called `.GetAwaiter().GetResult()` directly on a WinRT
   `IAsyncOperation<T>`, which PowerShell cannot invoke (WinRT operations have no
   `.GetAwaiter()` PowerShell can see), and never force-loaded the WinRT types via the
   `[Type,Contract,ContentType=WindowsRuntime]` accelerator syntax — so native OCR always
   returned null/empty despite every existing automated test passing, because those tests
   mock the PowerShell invocation entirely rather than inspecting the generated script.
   Fixed using the standard PowerShell WinRT-await workaround (reflectively invoking
   `System.WindowsRuntimeSystemExtensions.AsTask<T>` to project the WinRT operation to a
   real .NET `Task`, then blocking on that) and verified to extract real OCR text from a
   real screenshot. New regression tests assert on the generated script/source text itself
   (see the "Tests" list below) so a regression to either the broken C++-in-.c form or the
   broken direct-`.GetAwaiter()` form fails loudly instead of passing silently as before.

Renderer wiring: `warmupScreenContext()`, the OCR-reuse cache, the cleanup-and-agent prompt
threading (`appendScreenContextSuffix()` wired into both `ReasoningService.ts`'s cleanup
path via `BaseReasoningService.getSystemPrompt()` and the agent route's `systemPrompt`), and
the `screen_context_text` history write path (`AudioManager.saveTranscription()` →
`db-save-transcription` → `updateTranscriptionScreenContext()`) are all implemented and
threaded end-to-end.

**pr-reviewer follow-up pass (resolved)**: a first `pr-reviewer` pass found 5 must-fix gaps,
all now closed:

1. `tesseract.js` is now a real, declared `package.json` dependency (previously
   `activeWindowOcr.js` called `require("tesseract.js")` while the package was never
   installed — caught only by `activeWindowOcr.test.js`'s `Module._load` mock, which passed
   regardless of whether the real package existed). Added
   `test/helpers/tesseractJsDependency.test.js`, which requires the **real**, un-mocked
   package and asserts it resolves and exposes `recognize()`, so this class of regression
   fails loudly instead of silently degrading OCR.
2. **History UI resolved**: `TranscriptionItem.tsx` now renders a collapsed-by-default
   "Screen Context Used" expandable section (mirroring the existing "Raw Transcript"
   expand/collapse pattern), shown only when `screen_context_text` is non-null. New i18n
   keys `controlPanel.history.viewScreenContext`/`screenContextUsed` in both `en`/`pt`. New
   test: `test/components/transcriptionItemScreenContext.test.js`.
3. Added `test/helpers/audioManager.screenContext.test.js`, exercising the real
   `getScreenContextTextBounded()`/`warmupScreenContext()` implementation in `audioManager.js`
   (not just the pure-function `shouldCaptureScreenContext()` gate) — confirms the bounded
   wait proceeds with `null` when OCR hasn't resolved in time, and that `warmupScreenContext()`
   never awaits a slow/hung capture call before returning.
4. Added `test/components/screenContextSettingsSection.test.js` covering Requirements 6/9:
   `includeActiveWindowContext` defaults to `true` in the settings store, the entire
   `ScreenContextSettingsSection` (and therefore its OCR-engine control) is hidden on an
   unsupported platform, and its capture-related sub-controls only render when the master
   toggle is on.
5. `activeWindowCapture.js` now actually downscales the captured PNG via Electron's
   `nativeImage` (no new dependency — `createFromBuffer`/`resize`/`toPNG`, capped at
   `MAX_LONG_EDGE_PX`), guarded so it's a no-op when `nativeImage` is unavailable (e.g. under
   plain `node --test`, where `require("electron")` isn't the real API surface) or the image
   is empty/unparsable. Previously the constant was defined/exported but never actually
   applied, contradicting the module's own JSDoc. New tests cover resize, no-op-when-small,
   no-op-when-unavailable, and no-op-when-empty in `test/helpers/activeWindowCapture.test.js`.

All five were verified with `npm test`, `npm run typecheck`, `npm run lint`, `npm run
format:check` (362 files failing, down from the pre-existing 383-file repo-wide baseline —
i.e. this pass net-reduced, never increased, the baseline), and `npm run build:renderer`.

## TL;DR

On every dictation/agent invocation, EktosWhispr will (Windows only, for now)
capture a screenshot of the user's focused window, run OCR on it locally, and
feed the extracted text to whichever LLM pass actually runs (cleanup or
dictation agent — never the raw transcript step). Capture only fires when
that dictation would actually consume it (cleanup enabled, or agent route
applies) and is best-effort/non-blocking. This is the 5th revision; **all
four previously-open questions are now resolved and there are no remaining
blocking questions** — this spec is ready for `Draft` → `Approved`.

**5th-revision decisions (this update)**:

- **Default-ON confirmed.** Ships default-ON, an explicit, reviewed deviation
  from Premise #1's privacy-by-default stance — not overlooked, decided.
- **Retention now mirrors `audioRetentionDays` exactly**, not a fixed 30
  days: `screenContextRetentionDays` falls back to `0` (delete all persisted
  screenshots immediately) when never persisted, reusing
  `audioCleanupPolicy.js`'s `decideAudioCleanup()`/`shouldRunImmediateCleanup()`
  directly — same edge-value handling and startup-ordering safeguard, no
  duplicate function.
- **Unavailable OCR engine options are hidden**, not greyed out — "Native
  Windows OCR" disappears from Settings when it can't exist on the platform
  (only matters for a hypothetical future non-Windows build today).
- **Tesseract.js is not bundled.** A new `tesseractOcrManager.js`, modeled
  directly on `llamaCudaManager.js`, downloads its WASM+language-data assets
  on demand. Settings mirrors `GpuModeSelector.tsx`'s existing GPU-runtime
  download UX exactly: the option stays selectable before download; a
  "Download required" prompt/button/progress bar appears when needed; no
  download is ever silently triggered mid-dictation.

**Carried over from the 4th revision (unchanged)**: OCR-reuse cache for rapid
consecutive dictations (≤2s, same app); a new nullable `screen_context_text`
history column (additive migration, no data loss).

**Practical impact**: this ships on by default with no re-consent prompt;
turning on screenshot persistence starts at an aggressive 0-day ("delete
immediately") retention default, matching dictation-audio's own default,
until the user configures otherwise; using Tesseract OCR requires one
explicit Settings click before its small (tens-of-MB) asset download.

## Problem / Goal

Today, the LLM passes that see a dictation (cleanup, dictation agent, chat
agent) only ever see the transcript text itself (plus custom-dictionary
hints and an optional agent system prompt). They have no idea what's on the
user's screen — e.g. what document, email, or code editor is focused — so
they can't disambiguate references like "fix this" or "summarize the above."
Giving the LLM OCR'd text from the active window closes that gap without
sending any image data off-device by default.

## Requirements

1. On every dictation/agent-eligible recording start (the same trigger point
   as today's `warmupTranscriptionEngine()`/`warmupReasoningServer()` calls),
   the app captures the window focused at the exact moment the hotkey is
   pressed (Windows only) — explicitly excluding EktosWhispr's own windows
   (mirroring `windows-system-audio-helper.exe`'s existing self-exclusion of
   the app's own process tree) — and starts OCR asynchronously, in parallel
   with recording/transcription, so OCR is ready (or bounded-timed-out, per
   Requirement 3) by the time the cleanup/agent LLM request is assembled.
   This capture step is itself conditional on Requirement 1a below — it
   never fires unconditionally.
   1a. **Gating (new)**: before firing `warmupScreenContext()` (and therefore
   before spawning the capture helper at all), the app synchronously
   evaluates whether the current dictation would actually route through a
   pass that consumes screen context: either the cleanup LLM is enabled/
   configured for the `dictationCleanup` reasoning scope, or
   `resolveDictationRouteKind()` (`src/helpers/dictationRouting.js`)
   indicates the dictation-agent route applies (voice-agent hotkey, or
   wake-word-eligible agent routing). This check must use only
   settings/state already available synchronously at hotkey-down (the
   resolved reasoning-scope config, the dictation-agent enabled flag) —
   never an async call that would itself delay the capture-or-skip
   decision. If neither condition holds, capture is skipped entirely: no
   screenshot, no OCR invocation, no helper process spawned.
2. Screen-context capture and OCR must never block or delay the raw
   transcript path (hotkey-release → pasted raw text). It is consumed only
   by the optional cleanup/dictation-agent/chat-agent LLM step, which already
   has its own separate latency budget per Non-Negotiable Premise #3.
3. If OCR has not finished by the time the LLM pass is ready to send its
   request, the LLM pass proceeds without screen context rather than waiting
   — screen context is best-effort, never a blocking dependency.
4. OCR runs locally, per the user's `screenContextOcrEngine` preference
   (Requirement 15): `"auto"` (default) tries native Windows OCR first with
   local Tesseract.js fallback second; `"native"` and `"tesseract"` force a
   single strategy with no fallback. No image is sent to any cloud service
   at any point in this feature, regardless of which LLM provider the user
   has configured for cleanup/agent passes, and regardless of engine choice.
5. Only extracted **text** (never the image) is added to the LLM context
   already being sent — the existing cloud-LLM BYOK/opt-in exception
   (Premise #1) is unchanged: if the user configured a cloud cleanup/agent
   provider, that provider already receives their transcript today, and will
   now also receive this OCR text, exactly as opt-in as before.
6. A new Settings toggle, "Include active window text as context" (or
   similar; final copy owned by i18n keys below), defaults to **ON**,
   placed in Settings → Speech-to-Text → Dictation per Design's "Settings
   & IPC" subsection (final placement vs. Settings → AI Models is an
   explicit, non-blocking Open Question). Turning it off must take effect
   on the very next recording (no restart required).
7. The native screenshot/OCR helper(s) must never crash the app or block
   record→transcribe→paste if unavailable, erroring, or producing no text
   (Premise #5) — capture/OCR failure degrades to "no screen context," full
   stop.
8. By default (`persistActiveWindowScreenshots = false`, Requirement 16),
   no screenshot image or OCR'd text is persisted to disk beyond the
   in-memory/transient temp-file lifetime of a single capture-then-OCR
   cycle; any temp file used as an intermediate (e.g. handing a bitmap to a
   helper process via a file path) must be deleted immediately after OCR
   completes or fails (mirrors the audio pipeline's temp-file cleanup
   pattern) — this is transient/ephemeral data, not one of the "operational,
   never-auto-expunged" categories (notes, meeting audio, dictionary) in
   Premise #7. **Exception (new, 4th revision)**: when the user explicitly
   opts into `persistActiveWindowScreenshots`, the captured PNG is
   additionally written to a dedicated on-disk directory per Requirement 16
   — this is the one deliberate, opt-in departure from "never persisted,"
   and is itself subject to Requirement 17's retention/purge policy, not an
   unbounded accumulation.
9. Feature is Windows-only in this iteration. On macOS/Linux, the capture
   step is a no-op (feature absent, not erroring); the Settings toggle is
   hidden or disabled with an explanatory note on non-Windows platforms.
10. New i18n keys for any new UI strings (Settings toggle label/description,
    any permission-prompt copy) added to both `en` and `pt` translation
    files — no other locale.
11. The active-window screenshot/OCR helper process(es) are lazy-spawned
    on first actual use (first dictation with the setting on), never at app
    startup, consistent with Premise #2's idle-budget rule and the existing
    `QdrantManager`/ONNX-utility-process lazy-spawn pattern. They must also
    respect the same on-demand idle-unload spirit as §18's transcription/LLM
    engines — see Design for exact lifecycle.
12. Whatever Windows permission/consent screen-capture triggers (if any —
    Windows does not gate `desktopCapturer`-based screen capture behind a
    runtime permission prompt the way macOS does, but this must be verified
    during execution) must be honored; if capture silently returns nothing
    because of an OS-level restriction, that must be treated as capture
    failure (requirement 7), not a crash.
13. **OCR cache reuse across rapid consecutive dictations (new).** The app
    tracks the most recent captured screen-context result in memory as
    `{ appIdentifier, ocrText, capturedAtTimestamp }` (never persisted to
    disk). At the next hotkey-down, if Requirement 1a's gate says capture
    would normally be needed, the app first does a cheap, synchronous
    "is this still the same app?" check (see Design) before deciding to
    capture. If (a) the currently-focused window's app identifier matches
    the cached entry's `appIdentifier`, AND (b) the gap between the previous
    recording's _stop_ time and the current hotkey-down is `<= OCR_REUSE_WINDOW_MS`
    (a named constant, 2000ms), the cached `ocrText` is reused verbatim and
    no capture helper or OCR pass is invoked for this turn. Otherwise (app
    differs, gap exceeds the window, or no cached entry exists yet), a fresh
    capture+OCR cycle runs as designed in Requirements 1-4, and its result
    becomes the new cached entry. This is a pure latency/CPU optimization
    (Premise #2/#3) with no change to what data is sent to the LLM — it must
    never be observably different from re-running OCR fresh (i.e. the cache
    is not used across an app switch or a >2s idle gap between dictations).
14. **Screen context recorded in transcription history (new, schema
    change).** Whatever OCR'd screen-context text actually gets threaded
    into a given dictation's cleanup/agent LLM request (Requirement 1a/
    "Threading OCR text into the LLM context" in Design) — whether freshly
    captured or reused from cache per Requirement 13 — is also persisted
    into that transcription's row in the `transcriptions` table's new
    `screen_context_text` column (see Design's new "Database schema"
    subsection), so History can display it later. If no screen context was
    captured/used for a given turn (feature disabled, gated off by
    Requirement 1a, platform unsupported, or capture/OCR failed per
    Requirement 7), the column is `NULL` for that row — never an empty
    string standing in for "not applicable."
15. **OCR engine preference, user-selectable (new, 4th revision).** A new
    setting `screenContextOcrEngine: "auto" | "native" | "tesseract"`
    (default `"auto"`) lets the user pick which OCR strategy is used,
    reconciling with Requirement 4/Design's native-then-fallback chain:
    - `"auto"` (default): unchanged from prior revisions — native tried
      first, Tesseract.js as fallback on native failure/unavailability.
    - `"native"`: only native Windows OCR is attempted. If it fails or is
      unavailable, this is treated exactly like Requirement 7's "both
      failed" case (no context, debug-log only) — Tesseract is never
      invoked as a silent rescue, since the user explicitly chose native
      only.
    - `"tesseract"`: only Tesseract.js is attempted; native OCR is never
      invoked, even if available.
      Changing this setting takes effect on the very next capture, no restart
      required — same as Requirement 6's toggle.
    - **RESOLVED (5th revision), Settings UI**: the "Native Windows OCR"
      segmented-control option is hidden entirely (not shown disabled) when
      native OCR is known to be unavailable on the current build/platform —
      it literally cannot exist off Windows, so this only matters for a
      hypothetical future non-Windows build of this feature. The
      "Tesseract" option is never hidden merely because its assets aren't
      downloaded yet (Requirement 19 governs that case via an inline
      download affordance, not option-hiding) — mirroring how
      `GpuModeSelector.tsx` keeps "GPU NVIDIA" selectable before the CUDA
      binary is downloaded.
16. **Opt-in screenshot persistence to disk (new, 4th revision).** A new
    setting `persistActiveWindowScreenshots` (boolean, default `false`)
    lets the user opt into writing the captured screenshot PNG to disk
    under a dedicated directory (`userData/screen-context-captures/`, see
    Design). When `false` (default), behavior is unchanged from prior
    revisions — Requirement 8's "never persisted beyond a same-request
    temp file" guarantee holds exactly as before. When `true`, the PNG is
    written to that directory once OCR has completed (success or failure),
    named/timestamped so files don't collide, and is retained subject to
    Requirement 17's retention/purge policy — it does not affect the OCR
    pipeline itself (OCR still runs against the in-memory buffer or its own
    ephemeral temp file, independent of this persisted copy).
17. **Retention and automatic purge for persisted screenshots (new, 4th
    revision, Premise #7 compliance).** Screenshots persisted to disk under
    Requirement 16 are **collected/ephemeral data** (same category as
    dictation audio per CLAUDE.md §7), not operational data — so per Premise
    #7 they require both (a) a user-facing retention-window setting and (b)
    an automatic background purge honoring it, not just a manual button.
    - New setting `screenContextRetentionDays` (number), entirely
      independent of the existing `audioRetentionDays` — different artifact,
      own setting, no shared state, but **identical default/fallback
      semantics** to `audioRetentionDays` per the project owner's explicit
      instruction (5th revision — see TL;DR and Design). When
      `screenContextRetentionDays` has never been persisted, its resolved
      value is `0` — "delete all existing persisted screenshots
      immediately" — exactly mirroring CLAUDE.md's documented
      `AUDIO_RETENTION_DAYS` fallback-default reasoning (privacy-by-default;
      practical consequence: any install where the user never opens
      Settings → Privacy & Data will have persisted screen-context
      screenshots deleted starting from the first cleanup tick after
      `persistActiveWindowScreenshots` is turned on). This supersedes the
      4th revision's `30`-day default, which is no longer part of this
      spec.
    - An automatic periodic cleanup pass (new manager or extension of an
      existing storage-manager module, mirroring `_setupAudioCleanup()`'s
      shape exactly: run once immediately at startup subject to the same
      startup-ordering safeguard as `audioRetentionDays`, then every 6
      hours) deletes persisted screenshot files older than the configured
      window. Edge-value handling and the startup-ordering safeguard are
      not merely "mirrored" but **reused directly** from
      `audioCleanupPolicy.js`'s `decideAudioCleanup()`/
      `shouldRunImmediateCleanup()` (5th revision — see Design): `0` means
      "delete all existing persisted screenshots immediately" (a valid,
      deliberate value, not "disabled"); negative or non-finite
      (`NaN`/`Infinity`) values are invalid and skip that tick's deletion
      entirely, logged as a warning. No new pure function is introduced for
      this unless execution finds the two artifacts' policies must diverge
      for some reason not anticipated here.
    - A manual "Clear All Screen Context Screenshots" button in Settings →
      Privacy & Data, alongside the existing dictation-audio and
      meeting-audio "Clear All" buttons, deletes all persisted screenshot
      files immediately regardless of the configured retention window.
    - If `persistActiveWindowScreenshots` is later turned OFF after having
      been ON, previously persisted files are **not** auto-deleted by that
      toggle alone (toggling the setting off only stops new persistence) —
      they remain subject to the same retention/purge and manual-clear
      controls until removed by one of those paths. This mirrors how
      turning off other collection settings elsewhere in the app does not
      retroactively purge already-collected data.
18. All three settings introduced by Requirements 15-17, plus the existing
    `includeActiveWindowContext` master toggle, get: IPC get/save handlers
    mirroring the `get-audio-retention-days`/`save-audio-retention-days`
    pattern; renderer state wired into `useSettings.ts`/the settings store;
    Settings UI controls (placement per Design's "Settings & IPC"
    subsection); and `en`/`pt` i18n keys for every new label/description/
    button — no other locale, per project i18n rules.
19. **Tesseract.js is a downloadable, not bundled, asset — on-demand
    download via a Settings button, mirroring the llama-server GPU-runtime
    download pattern exactly (new, 5th revision).** Per the project owner's
    explicit instruction, the Tesseract.js WASM binary and its trained-data
    language file(s) must not ship inside the app installer/ASAR. Instead:
    - A new manager, `src/helpers/tesseractOcrManager.js`, modeled directly
      on `src/helpers/llamaCudaManager.js`'s shape (see Design's new
      "Tesseract OCR: on-demand download" subsection for the exact method
      surface to mirror: `isDownloaded()`, `download(onProgress)` guarded by
      an internal `_downloading` flag that rejects a second concurrent call,
      `cancelDownload()`, a disk-space pre-check via `downloadUtils.js`'s
      `checkDiskSpace` before any network call, and `cleanupStaleDownloads`
      for interrupted downloads) is the single source of truth for whether
      Tesseract assets are present on disk.
    - The assets are fetched only when: (a) the user explicitly clicks a
      "Download" button in Settings next to the OCR-engine control (the
      only download trigger this spec introduces), or (b) execution finds
      it strictly necessary to also auto-trigger the same `download()` call
      the first time `screenContextOcrEngine` actually needs Tesseract and
      it isn't present — but per this requirement's UX mirror (below), the
      default and primary path is the explicit button, not a silent
      first-use download, since that is what the referenced llama-server
      GPU-runtime pattern does (`GpuModeSelector.tsx`'s CUDA/Vulkan
      "Download required" prompts require an explicit click, they do not
      auto-download when the corresponding GPU mode is merely selected).
    - Until downloaded, the "Tesseract" (and, transitively, "Automatic")
      `screenContextOcrEngine` options remain selectable in the UI — per
      Requirement 15's resolved hiding rule, engine options are only hidden
      when structurally unavailable (e.g. "Native" on a non-Windows build),
      never merely because an asset hasn't been downloaded yet. Selecting
      an engine that needs Tesseract before it's downloaded surfaces an
      inline "Download required" prompt with a Download button and progress
      bar (`DownloadProgressBar`, reused unchanged), mirroring
      `GpuModeSelector.tsx`'s `needsCudaDownload`/`needsVulkanDownload`
      blocks 1:1.
    - If a dictation actually reaches the OCR step needing Tesseract and it
      still isn't downloaded (user never clicked Download), this is treated
      exactly like Requirement 7's "OCR unavailable" case — no context
      added, debug-log only, and critically **no download is silently
      kicked off mid-dictation** (a download-in-flight is not a bounded,
      sub-second operation and must never be raced against the LLM pass's
      own latency budget per Requirement 3).
    - New IPC channels (added to both `ipcHandlers.js` and `preload.js`),
      mirroring the CUDA/Vulkan channel names exactly:
      `get-tesseract-ocr-status` (`{ supported, downloaded, downloading }`),
      `download-tesseract-ocr-assets`, `cancel-tesseract-ocr-download`,
      `delete-tesseract-ocr-assets` (for a future "remove Tesseract" cleanup
      affordance, mirroring `delete-llama-cuda-binary`), and a progress
      event `tesseract-ocr-download-progress` mirroring
      `llama-cuda-download-progress`.
    - Downloaded assets are **not** subject to `screenContextRetentionDays`
      (Requirement 17) — they are an engine/runtime asset analogous to a
      downloaded Whisper model or the CUDA binary, not user-collected data,
      so they are never auto-purged by age; removal (if ever exposed in the
      UI) is manual/on-demand only, same as deleting a downloaded model.

## Non-goals

- macOS/Linux screen capture/OCR — explicitly out of scope for this spec;
  future work item, not a partial implementation here.
- OCR of anything other than the single focused/foreground window (no
  multi-monitor capture, no full-desktop capture, no capture of background
  windows).
- Structured/semantic understanding of the captured content (e.g. "this is
  a code editor, that's a function name") — this spec only produces raw OCR
  text, handed to the LLM as-is; any smarter parsing is a future iteration.
- A user-reviewable/searchable **gallery or history view** of persisted
  screenshots — when `persistActiveWindowScreenshots` is on (Requirement
  16), files land in `userData/screen-context-captures/` for manual/
  debugging inspection via the OS file browser only; this spec does not add
  any in-app UI to list, thumbnail, or search those files (only a file
  count/size readout and a "Clear All" button, per Design). Note this
  bullet is narrower than in prior revisions: OCR'd **text** (not the image)
  is deliberately surfaced in the transcription-history DB/UI per
  Requirement 14 — that remains in scope; only an in-app view of the raw
  screenshot **images** is out of scope here.
- A manual per-session capture toggle/hotkey (the trigger is automatic, per
  the user's stated requirement); a future spec could add a manual variant.
- Changing the existing `desktopCapturer` usage in `main.js` for meeting/note
  system-audio loopback (`setDisplayMediaRequestHandler`) — this is a
  separate, new use of `desktopCapturer`, filtered to the foreground window
  rather than a full screen source.
- Bundling Tesseract.js's WASM binary or trained-data language files inside
  the app installer/ASAR (new, 5th revision) — this spec deliberately makes
  Tesseract a downloadable, on-demand asset (Requirement 19), not a shipped
  one; a future spec could revisit bundling if download friction proves to
  be a real-world problem, but that is out of scope here.
- A generic/pluggable "download any missing local asset" framework shared
  across Whisper models, llama GPU runtimes, and Tesseract — Requirement 19
  reuses `downloadUtils.js`'s existing shared primitives and mirrors
  `llamaCudaManager.js`'s shape by convention, not by extracting a new
  common base class; a real shared abstraction is a larger refactor out of
  scope for this spec.

## Design

### Capture: identifying and grabbing the focused window (Windows only)

- New native helper binary, `windows-active-window-info.exe`, built from a
  small C source (`resources/windows-active-window-info.c`), following the
  existing pattern of `windows-key-listener.c`/`windows-system-audio-helper.c`.
  Invoked once per capture (short-lived, exits after one shot — not a
  long-running listener like the key/audio helpers), it:
  1. Resolves the foreground window via `GetForegroundWindow()`, walking up
     to the owning process and comparing it against EktosWhispr's own PID/
     process tree (same self-exclusion principle already implemented by
     `windows-system-audio-helper.exe`, which excludes EktosWhispr's own
     process tree from system-audio capture) — if the foreground window
     belongs to EktosWhispr itself (e.g. the always-on-top dictation
     overlay just grabbed focus), the helper reports "no eligible window"
     rather than capturing the app's own UI. This directly targets the
     failure mode where hotkey-press briefly focuses EktosWhispr's overlay
     instead of the user's actual target app.
  2. Captures that window's bitmap directly via `PrintWindow` (with the
     `PW_RENDERFULLCONTENT` flag for modern/GPU-composited apps) or a
     `BitBlt`-based fallback, by HWND — no Electron `desktopCapturer`
     involvement and no fuzzy title/process-name re-matching, since the
     helper already has the exact HWND in hand.
  3. Writes the captured bitmap as PNG bytes to stdout (binary-safe framing:
     a length-prefixed byte stream, not line-delimited JSON, since this
     payload is binary image data rather than the JSON event lines the
     key/audio helpers use) along with a small JSON metadata header (window
     title, process name, bounds) for logging/diagnostics.
- New helper module `src/helpers/activeWindowCapture.js` (Windows-only;
  no-ops with a clear "unsupported platform" return value elsewhere):
  1. Spawns `windows-active-window-info.exe` and reads its framed stdout
     output.
  2. Downscales the returned bitmap if needed (bounded, e.g. capped at
     1920px on the long edge, to keep OCR fast and memory low).
  3. Returns the PNG buffer (or `null` if the helper reports "no eligible
     window," is missing, or errors) to the caller. Never writes this
     buffer to disk unless the OCR engine used in a given run requires a
     file path as input (see OCR section) — and if so, writes to a
     per-request temp file under the OS temp dir, deleted in a `finally`
     block immediately after the OCR call returns or throws.
- Binary distribution: same pattern as `download-windows-key-listener.js` —
  `scripts/download-windows-active-window-info.js`, added to
  `prebuild:win` in `package.json`, prebuilt binary from a GitHub Actions
  workflow (`.github/workflows/build-windows-active-window-info.yml`,
  mirroring the key-listener workflow). Absence of the binary at runtime is
  requirement 7's failure mode, not a fatal error.

### OCR

- New helper module `src/helpers/activeWindowOcr.js` orchestrating two
  strategies, tried in order, each independently feature-detected once and
  cached for the process lifetime:
  1. **Native Windows OCR** (`Windows.Media.Ocr`): invoked via a short
     PowerShell script (spawned per-request, not a long-running process)
     that loads the WinRT projection, feeds the PNG bytes (via a temp file
     — WinRT's `SoftwareBitmap` decode path needs a `RandomAccessStream`,
     which is most reliably fed from a file in a PowerShell bridge), and
     prints extracted text as JSON to stdout. This mirrors this project's
     existing willingness to shell out to PowerShell for OS integration
     (`clipboard.js`'s PowerShell SendKeys path).
  2. **Local Tesseract.js fallback**: if the native path errors or is
     unavailable (pre-Windows-10 OCR language pack not installed, PowerShell
     execution policy blocking the script, etc.), run OCR via `tesseract.js`
     (WASM) inside the existing ONNX utility process
     (`src/workers/onnxWorker.js`), following the same lazy-spawn-on-first-use
     pattern already used there for embeddings — adds a new message type
     (e.g. `ocr-image`) to that worker's protocol rather than spawning a
     third process type. **Changed (5th revision)**: this path is only ever
     reachable once `tesseractOcrManager.isDownloaded()` is `true` — the
     WASM binary and trained-data file are a downloadable, opt-in asset
     (Requirement 19, new "Tesseract OCR: on-demand download" subsection
     below), not bundled in the app package. If Tesseract is the chosen/
     fallback strategy but its assets aren't downloaded yet, this strategy
     is treated as unavailable (falls straight to step 3), exactly like a
     missing native-OCR language pack — no download is triggered from
     inside this code path.
  3. If both fail (or the single forced strategy fails, per the engine
     preference below, or Tesseract's assets simply aren't downloaded yet),
     `activeWindowOcr.js` resolves to `null`/empty text. This is logged at
     debug level only, never surfaced to the user as an error (Premise #5)
     — the LLM pass just proceeds without screen context.

### OCR engine selection (`screenContextOcrEngine`, Requirement 15)

- `activeWindowOcr.js` reads the resolved `screenContextOcrEngine` setting
  (`"auto" | "native" | "tesseract"`, default `"auto"`) once per capture
  call and branches before attempting anything:
  - `"auto"`: unchanged behavior from prior revisions — strategy 1 (native)
    tried first, strategy 2 (Tesseract) attempted only if strategy 1 throws/
    resolves empty/is unavailable.
  - `"native"`: only strategy 1 is invoked. Its failure resolves straight to
    `null` (step 3 above) — strategy 2 is never reached, even though the
    code path exists and remains available for `"auto"`/`"tesseract"`. This
    is a deliberate no-fallback behavior the user opted into by forcing
    native, not a bug.
  - `"tesseract"`: only strategy 2 is invoked; the native PowerShell bridge
    is never spawned, and native's one-time feature-detection (Requirement
    4/Design) is skipped entirely for that call.
  - An unrecognized/corrupt persisted value falls back to `"auto"` (the
    default), following the same defensive-parsing convention as other
    enum-shaped settings in this codebase (e.g. `previewVadConfig.js`'s
    `sanitizePreviewVadConfig`).
- This setting lives alongside `includeActiveWindowContext` in Settings —
  see "Settings & IPC" below for exact IPC/UI wiring — and, like the master
  toggle, takes effect on the very next capture with no restart required.
- **RESOLVED (5th revision) — hiding unavailable options**: the Settings UI
  control for this setting hides the "Native Windows OCR" option entirely
  (not shown disabled/greyed) when native-OCR feature-detection has already
  determined it's unavailable on the current build/platform. Since this
  whole feature is Windows-only for now (Non-goals), this only matters for
  a hypothetical future non-Windows build — the option is always shown
  today. The "Tesseract" option is a different case: it is never hidden for
  not-yet-being-downloaded (see the new "Tesseract OCR: on-demand download"
  subsection below) — a not-yet-downloaded Tesseract surfaces an inline
  download affordance instead, mirroring how `GpuModeSelector.tsx` keeps a
  GPU mode selectable before its runtime binary is downloaded rather than
  hiding it.

### Tesseract OCR: on-demand download (Requirement 19, new — 5th revision)

- **Reference implementation to mirror**: `src/helpers/llamaCudaManager.js`
  (and its sibling `src/helpers/llamaVulkanManager.js`), which already
  implement exactly this "optional runtime, not bundled, downloaded on
  demand into `userData/`" pattern for llama-server's GPU acceleration
  libraries. The new manager copies this shape precisely rather than
  inventing a new one:
  - **New class, `TesseractOcrManager`, in `src/helpers/tesseractOcrManager.js`**:
    - Constructor state: `_assetDir = null` (lazily resolved, mirroring
      `LlamaCudaManager.binDir`'s getter pattern — `path.join(app.getPath("userData"), "tesseract-ocr")`,
      created via `mkdir({ recursive: true })` only inside `download()`,
      never at construction or app startup, per Premise #2), `_downloadSignal = null`,
      `_downloading = false`.
    - `isSupported()`: true whenever Tesseract.js's WASM runtime is viable
      for the current platform/arch — effectively always true (WASM is
      cross-platform, unlike CUDA's per-platform binary gating), but kept as
      a method for architectural symmetry with `LlamaCudaManager.isSupported()`
      and for forward-compatibility if this feature ever expands beyond
      Windows.
    - `getAssetPaths()` / `isDownloaded()`: mirrors `getBinaryPath()`/
      `isDownloaded()` — checks whether the required asset files (the
      Tesseract.js WASM core plus at least the English trained-data
      language file, e.g. `eng.traineddata`) already exist under
      `_assetDir`; `isDownloaded()` is `true` only when all required files
      are present.
    - `getStatus()`: mirrors `LlamaCudaManager.getStatus()`'s exact shape —
      `{ supported: boolean, downloaded: boolean, downloading: boolean }`.
    - `download(onProgress)`: mirrors `LlamaCudaManager.download()`'s
      control flow precisely — throws `"Download already in progress"` if
      `_downloading` is already `true` (same guard, same error message
      convention); creates the asset directory; calls
      `downloadUtils.js`'s `cleanupStaleDownloads()` for any interrupted
      prior download; fetches asset metadata (fixed, pinned URLs/version —
      following the same "pinned tag, overridable via env var" convention
      as `LLAMA_CPP_TAG`/`LLAMA_CPP_VERSION`, e.g. a `TESSERACT_JS_VERSION`
      env var, exact pin/source left to execution — official `tesseract.js`/
      `tesseract.js-core` CDN or GitHub release assets, whichever is more
      stable/mirrorable); runs `checkDiskSpace()` against the asset
      directory before starting any network call, throwing a clear
      "not enough disk space" error exactly like `LlamaCudaManager.download()`
      does (Tesseract's assets are far smaller than CUDA's — low tens of MB
      — but the same pre-check guard still applies unconditionally, per the
      mirrored pattern, not skipped just because the payload is small);
      downloads via `downloadUtils.js`'s `downloadFile()` with a
      `createDownloadSignal()`-based cancellation token exactly as
      `LlamaCudaManager` does; reports progress via the `onProgress`
      callback threaded up to the IPC handler exactly as CUDA/Vulkan do.
    - `cancelDownload()`: mirrors exactly (aborts `_downloadSignal`, returns
      `true`/`false`).
    - `deleteAssets()`: mirrors `deleteBinary()` — removes the downloaded
      asset files, returns a `{ success, deletedCount }`-shaped result. Not
      wired to any automatic retention/purge (see Requirement 19 — this is
      an engine/runtime asset, not user-collected data, same category as a
      downloaded Whisper model or the CUDA binary itself).
- **IPC** (added to both `ipcHandlers.js` and `preload.js`), mirroring the
  existing `get-llama-cuda-status`/`download-llama-cuda-binary`/
  `cancel-llama-cuda-download`/`delete-llama-cuda-binary`/
  `llama-cuda-download-progress` channel names and payload shapes exactly,
  substituting `tesseract-ocr` for `llama-cuda`:
  `get-tesseract-ocr-status`, `download-tesseract-ocr-assets`,
  `cancel-tesseract-ocr-download`, `delete-tesseract-ocr-assets`, and the
  progress event `tesseract-ocr-download-progress`.
- **UI**: the `screenContextOcrEngine` segmented control (Settings →
  Speech-to-Text → Dictation, see "Settings & IPC" below) gains a
  download-affordance block that is a structural 1:1 mirror of
  `src/components/ui/GpuModeSelector.tsx`'s CUDA/Vulkan prompts:
  - The three engine options ("Automatic"/"Native Windows OCR"/"Tesseract")
    remain eagerly selectable regardless of Tesseract's download state —
    exactly as `GpuModeSelector` keeps "GPU NVIDIA" clickable/selected
    before the CUDA binary exists (`resolveWhisperGpuMode`/
    `resolveLlamaGpuMode` in `src/utils/gpuModeResolver.js` resolve an
    explicitly-requested mode immediately, without gating on binary
    readiness — the readiness check only drives whether the download
    prompt renders, never whether the option itself is selectable). This
    resolves the task's open UX question in favor of "eagerly selectable,
    download prompt appears separately" rather than "gated until
    downloaded," since that is the codebase's one existing precedent for
    this exact kind of optional-runtime download.
  - When the resolved engine choice needs Tesseract (`"tesseract"`
    selected, or `"auto"` with native OCR unavailable/likely to fall
    through) and `get-tesseract-ocr-status` reports `downloaded: false`, an
    inline prompt renders below the segmented control — i18n'd descriptive
    text plus a "Download" button — mirroring `GpuModeSelector`'s
    `needsCudaDownload`/`needsVulkanDownload` conditional blocks exactly
    (same component structure: a bordered row with descriptive text and a
    small `Button`).
  - Clicking Download calls `download-tesseract-ocr-assets`, renders the
    existing `DownloadProgressBar` component driven by
    `tesseract-ocr-download-progress` events (mirroring
    `onLlamaCudaDownloadProgress`'s renderer-side listener pattern), and
    offers a Cancel action wired to `cancel-tesseract-ocr-download` —
    mirroring `GpuModeSelector`'s `handleDownloadCuda`/`handleCancelDownload`
    handlers structurally.
  - Once `isDownloaded()` is `true`, the prompt disappears and the selected
    engine behaves normally on the next capture — no restart required, same
    as the rest of this setting (Requirement 15).
- **Invocation-time behavior — no implicit/blocking download**: if a
  dictation actually reaches `activeWindowOcr.js`'s Tesseract strategy and
  `tesseractOcrManager.isDownloaded()` is still `false` (user never clicked
  Download), this is handled identically to Requirement 7's "OCR
  unavailable" case: resolves to `null`/empty, logged at debug level only,
  no download kicked off from inside the capture/OCR path. This mirrors the
  observed reality that `resolveWhisperGpuMode`/`resolveLlamaGpuMode` also
  never trigger a download at inference time — readiness gaps are handled
  by degrading gracefully (here: no screen context; for GPU mode, presumably
  a graceful runtime failure/fallback out of this spec's scope), never by
  synchronously blocking on a multi-second-to-multi-minute network
  download in the middle of a latency-sensitive request.
- **Not registered as a new sidecar/process** — `tesseractOcrManager.js` is a
  plain download/asset manager, not a spawned binary; the actual OCR
  _inference_ once assets are present still runs inside the existing,
  already-lazy-spawned ONNX utility process (per the "OCR" subsection
  above), so this introduces no new process type, only a new on-disk asset
  category.

### Screenshot persistence and retention (`persistActiveWindowScreenshots`, Requirements 16-17)

- **New storage-manager module, `src/helpers/screenContextStorage.js`**,
  deliberately structured as a close mirror of `src/helpers/audioStorage.js`
  (`AudioStorageManager`) rather than inventing a new shape — same
  constructor pattern (resolve+`mkdirSync recursive` a dedicated directory
  under `app.getPath("userData")`), same method surface adapted to PNGs
  instead of `.webm` files:
  - Directory: `path.join(app.getPath("userData"), "screen-context-captures")`
    (i.e. `userData/screen-context-captures/`), created lazily on first
    actual save, not at app startup (consistent with Premise #2 — this
    directory does not need to exist at all if the user never enables
    `persistActiveWindowScreenshots`).
  - `saveScreenshot(pngBuffer, timestamp)`: writes a timestamped PNG (same
    filename-safe timestamp formatting as `AudioStorageManager._buildFilename`,
    e.g. `EktosWhispr-{date}-{time}-{shortId}.png`), returns
    `{ success, path }`. Called from the `capture-active-window-context` IPC
    handler only when `persistActiveWindowScreenshots` is `true` for that
    request, after OCR has completed (success or failure) on the in-memory/
    ephemeral-temp-file buffer — persistence is strictly additional, never a
    substitute for or precondition of the existing OCR flow.
  - `cleanupExpiredScreenshots(retentionDays)`: mirrors
    `AudioStorageManager.cleanupExpiredAudio()`'s body almost verbatim
    (same `Number.isFinite(retentionDays) && retentionDays >= 0` validity
    check, same `Date.now() - retentionDays * 86400000` cutoff, same
    per-file `mtimeMs` comparison, same `{ deleted, kept }` return shape) —
    operating on `.png` files instead of `.webm`, and with no
    `databaseManager`/`clearAudioFlags` step (persisted screenshots have no
    corresponding DB row/flag to clear; they're independent files, not
    attached to a `transcriptions` row the way dictation audio is).
  - `deleteAllScreenshots()`: mirrors `AudioStorageManager.deleteAllAudio()`,
    for the manual "Clear All Screen Context Screenshots" button.
  - `getStorageUsage()`: mirrors `AudioStorageManager.getStorageUsage()`
    (`{ fileCount, totalBytes }`), for the Settings UI's storage-usage
    readout.
  - **DECIDED (5th revision, supersedes the 4th revision's "consider
    extracting")**: `decideAudioCleanup()` and `shouldRunImmediateCleanup()`
    in `src/helpers/audioCleanupPolicy.js` are reused **directly, unchanged,
    imported as-is** for screen-context cleanup — not duplicated, not
    wrapped in a second exported function. Both are already artifact-
    agnostic pure functions (one takes a plain `retentionDays: number`, the
    other a plain `hasBeenSetOnMain: boolean`); nothing about their
    signatures or bodies is audio-specific, so there is no genuine need for
    a `decideScreenContextCleanup` sibling. This is possible precisely
    because the project owner's 5th-revision instruction made
    `screenContextRetentionDays`'s semantics identical to
    `audioRetentionDays`'s (both default-fallback to `0`,
    both use the same edge-value rules) — the 4th revision's divergent `30`-
    day default would have made a shared function inappropriate, which is
    why that revision only "considered" sharing it. `pr-reviewer` should
    treat introducing a duplicate/near-duplicate function here as a defect,
    not a stylistic nit, given this explicit direction.
- **Automatic periodic purge**: a new `_setupScreenContextCleanup()` method
  on `ipcHandlers.js`'s handler-registration class (or a small dedicated
  manager class, execution's call), structurally identical to
  `_setupAudioCleanup()`:
  - Reads `environmentManager.getScreenContextRetentionDays()` fresh on
    every tick (never a value captured once at startup). Per Requirement 17
    (5th revision), this getter's fallback when never persisted is `0` —
    identical fallback semantics to `getAudioRetentionDays()`.
  - Calls `decideAudioCleanup()` **directly, imported unchanged** from
    `src/helpers/audioCleanupPolicy.js` (5th revision — see "Screenshot
    persistence and retention" above for why no sibling function is
    introduced) before calling
    `screenContextStorage.cleanupExpiredScreenshots(decision.retentionDays)`.
  - Same startup-ordering safeguard as `audioRetentionDays`, using
    `shouldRunImmediateCleanup()` **directly, imported unchanged** from the
    same module: the very first immediate pass at boot is skipped when
    `environmentManager.hasScreenContextRetentionDaysBeenSet()` is `false`,
    giving the renderer's new `screenContextRetentionSync.js` startup sync
    (mirroring `audioRetentionSync.js`) a chance to establish the real value
    first. Every subsequent tick (interval, or a later restart once a value
    has been persisted) runs unconditionally.
  - **Critical, easy-to-regress detail (spelled out explicitly per the
    `audioRetentionDays` precedent's own documented failure mode in
    CLAUDE.md's "Audio Retention Cleanup" section): main must NOT
    self-persist the `0` fallback to satisfy this safeguard.**
    `_setupScreenContextCleanup()` runs before any window (and therefore the
    renderer's `localStorage`) exists. If it were to call
    `saveScreenContextRetentionDays(0)` just to make
    `hasScreenContextRetentionDaysBeenSet()` return `true` going forward, it
    would permanently clobber a returning user's real, never-before-synced
    preference the very first time this feature ships to their install.
    Establishing the real value is exclusively the renderer's job, via
    `resolveScreenContextRetentionStartupSync()`/`initializeSettings()` —
    main only ever _reads_ `hasScreenContextRetentionDaysBeenSet()`, never
    writes to satisfy it.
  - **Do not rename or fork `audioCleanupPolicy.js`.** Since
    `decideAudioCleanup()`/`shouldRunImmediateCleanup()` are imported
    unchanged (see above), this file's name and exports stay exactly as
    they are today for the audio path — spec-executor must not rename it to
    something more "generic" (e.g. `cleanupPolicy.js`) as part of adding
    this second caller, since that would touch the already-shipped,
    already-tested audio-retention call sites and their imports for no
    behavioral reason.
  - Same six-hour interval (`SIX_HOURS_MS`) as the existing audio-cleanup
    interval — no new interval cadence introduced, reusing the established,
    already-justified-in-CLAUDE.md cadence rather than adding another
    magic number needing its own justification against Premise #2.
  - This purge only ever touches files under
    `userData/screen-context-captures/` — it must never be merged into or
    confused with `_setupAudioCleanup()`'s existing dictation-audio pass,
    since the two settings (`screenContextRetentionDays` vs.
    `audioRetentionDays`) are fully independent per Requirement 17 and the
    task's explicit instruction not to unify them absent a strong reason
    (none found — screenshots and dictation-audio recordings are different
    artifacts with different lifecycles and no shared consumer).
- **Manual clear button**: `delete-all-screen-context-screenshots` IPC
  handler calls `screenContextStorage.deleteAllScreenshots()` directly, no
  DB-side flag-clearing step needed (see above) — simpler than
  `delete-all-audio`'s handler, which does have to clear `has_audio` flags
  on affected transcription rows.
- **Toggling `persistActiveWindowScreenshots` off does not retroactively
  delete existing files** (Requirement 17's explicit non-goal here) — it
  only stops new saves from happening on future captures. Already-persisted
  files remain fully subject to the retention/purge pass above and the
  manual "Clear All" button until removed by one of those two paths, same
  as how disabling other collection features elsewhere in this codebase
  does not retroactively purge what was already collected.
- **Not registered as a new sidecar/process** — this is a plain filesystem
  storage manager, not a spawned binary, so none of the "New Sidecar
  Binary" conventions (PID files, `sidecarRegistry`, `sidecarReaper.js`)
  apply here; it's structurally identical to `AudioStorageManager`, which
  is likewise not a sidecar.

### Threading OCR text into the LLM context

- `audioManager.js`'s hotkey-down warm-up path gains a new fire-and-forget
  call, `warmupScreenContext()`, issued alongside (not blocking)
  `warmupTranscriptionEngine()`/`warmupReasoningServer()`. Before spawning
  anything, it runs a synchronous gate — new helper
  `shouldCaptureScreenContext(state)` (co-located with `dictationRouting.js`
  or `activeWindowCapture.js`, exact placement left to execution) that
  takes the same inputs `resolveDictationRouteKind()`/`resolveReasoningRoute()`
  already use (dictation-agent enabled flag, voice-agent-requested flag,
  resolved `dictationCleanup` scope config) and returns `true` only if the
  cleanup LLM is enabled/configured for `dictationCleanup` OR the
  dictation-agent route will apply. Only when this gate returns `true` does
  it kick off capture+OCR and store the in-flight `Promise<string|null>` on
  the `AudioManager` instance (e.g. `this.screenContextPromise`); it is also
  still gated on the settings toggle being enabled and the platform being
  Windows (Requirement 6/9), all three conditions ANDed together. When the
  gate returns `false`, `this.screenContextPromise` is left `null`/unset —
  no helper process is spawned, no PNG bitmap is captured, no OCR call is
  made.
- When `resolveReasoningRoute()`/`processTranscription()` reaches the point
  of actually building the cleanup or dictation-agent request (i.e. the
  route is `"cleanup"` or `"agent"`, never `"skip"`), it awaits
  `this.screenContextPromise` with a short bound (e.g. `Promise.race` against
  a timeout matching the "cleanup/agent LLM pass's own latency budget," not
  the 500ms raw-transcript budget — exact number decided at execution time,
  but must be justified against Premise #3's framing that this only affects
  the already-separate optional LLM-pass budget). If it hasn/t resolved by
  then, proceeds with no screen context (Requirement 3).
- New prompt-construction helper mirroring `appendDictionarySuffix()` in
  `src/config/prompts/index.ts`: `appendScreenContextSuffix(prompt, screenText, uiLanguage)`,
  appended after the dictionary suffix, wrapped in its own tagged block
  (e.g. `<screen_context>...</screen_context>`) analogous to
  `wrapCleanupTranscript()`'s `<transcript>` tags, with an i18n'd lead-in
  string explaining to the model what this text is (visible OCR'd text
  from the user's active window, may be noisy/incomplete). Called from both
  `resolveReasoningRoute()`'s `"agent"` branch (added to `resolvePrompt("dictationAgent", ...)`'s
  result) and wherever the `"cleanup"` branch's prompt is assembled.
  `ReasoningService.ts`'s existing provider-agnostic prompt/message
  construction is unchanged beyond receiving this longer system prompt —
  no new fields in the `InferenceProvider` interface are required.
- Chat agent parity (mentioned in the task) is out of scope for the initial
  cut of this spec unless execution finds it trivial to reuse the same
  `screenContextPromise`/suffix helper — if included, it must not introduce
  a second capture per turn; final call on scope left to spec-executor with
  a note in the PR description, not silently expanded without approval.

### OCR cache reuse across rapid consecutive dictations

- **Cheap "same app" identity check (the crux of this optimization)**: a new,
  separate, much cheaper native helper mode (or a lighter code path within
  `windows-active-window-info.exe` invoked with a `--identify-only` flag) that
  does _only_ step 1 of the existing capture helper — `GetForegroundWindow()`
  → owning process ID/executable name, with the same EktosWhispr self-exclusion
  — and returns immediately, skipping `PrintWindow`/BitBlt entirely and
  skipping any OCR call. This must be measurably cheaper (no bitmap capture,
  no OCR invocation) than the full capture+OCR path, or Requirement 13
  provides no savings. The `appIdentifier` used for comparison is the owning
  process's executable name/PID (whichever `windows-active-window-info.exe`
  already surfaces in its JSON metadata header per the existing Design/
  Requirement 1 capture step) — window title is deliberately not used alone,
  since the same app can retitle its window between two rapid dictations
  (e.g. an editor's title changes with cursor position) while still being
  "the same app" for this purpose.
- New helper module state (co-located with `activeWindowCapture.js` or a new
  small `screenContextCache.js`, execution's call): an in-memory (not
  persisted) `lastScreenContext: { appIdentifier, ocrText, capturedAtTimestamp } | null`,
  and a `lastRecordingStoppedAt: number | null` timestamp updated whenever a
  dictation recording actually stops (the existing stop-recording code path
  in `useAudioRecording.js`/`audioManager.js`, exact hook left to execution).
- `warmupScreenContext()`'s gate (Requirement 1a) is extended: if the gate
  says capture is needed, before spawning the full capture+OCR helper it
  first runs the cheap identity-only check above. If
  `currentAppIdentifier === lastScreenContext.appIdentifier` AND
  `(hotkeyDownTimestamp - lastRecordingStoppedAt) <= OCR_REUSE_WINDOW_MS`
  (new named constant `OCR_REUSE_WINDOW_MS = 2000`, co-located with other
  screen-context constants), it resolves `this.screenContextPromise`
  immediately with `lastScreenContext.ocrText` — no capture helper spawn, no
  OCR call. Otherwise it proceeds with the normal fresh capture+OCR flow and,
  on success, overwrites `lastScreenContext` with the new
  `{ appIdentifier, ocrText, capturedAtTimestamp: Date.now() }`. A failed/
  null fresh capture does not overwrite `lastScreenContext` with a null
  entry — it simply leaves the LLM pass with no context for that turn, per
  Requirement 7's existing failure semantics, while leaving any prior valid
  cache entry in place for a possible next-turn reuse (still subject to the
  same app-match + time-window check, so a stale cache is never resurrected
  after the app has changed or the window has elapsed).
- The cache is purely in-memory and process-lifetime only (cleared on app
  restart) — consistent with the existing "screenshots/OCR text are
  transient" stance in Data Retention below; it is never written to disk,
  and is distinct from the new persisted `screen_context_text` history
  column (Requirement 14), which stores what was _used_ for a given
  already-completed transcription, not a reusable cache entry.

### Database schema: `screen_context_text` column and migration

- `transcriptions` table gains one new nullable column:
  `screen_context_text TEXT` (nullable, no default — absent/NULL means "no
  screen context was captured or used for this transcription"), matching the
  existing naming style of `original_text`/`processed_text`.
- Migration: a standard additive `ALTER TABLE transcriptions ADD COLUMN
screen_context_text TEXT` in `database.js`'s existing schema-migration
  path (wherever prior additive column migrations for this table are
  applied — e.g. alongside how `processing_method`/`agent_name`/`error` were
  presumably added after the original schema, or `custom_dictionary`'s
  `learned_from` column per CLAUDE.md §13 as the most recent precedent).
  Runs once, is idempotent (checked via `PRAGMA table_info` or equivalent
  before applying, consistent with existing migration-check patterns in
  `database.js`), and never touches existing row data beyond the new column
  defaulting to `NULL`. No backfill is attempted or possible for historical
  rows (the screen context they may have used, if any, was never persisted
  before this change) — this is expected and acceptable, matching Premise
  #6's "existing data survives untouched" bar, not "existing data gets
  retroactively enriched."
- Write path: whichever code path in `ipcHandlers.js`/`audioManager.js`
  currently inserts a new row into `transcriptions` (original text, then
  updates it with processed text once cleanup/agent completes) is extended
  to also pass through whatever screen-context text string (or `null`)
  ended up threaded into that turn's LLM request per the "Threading OCR text
  into the LLM context" section above — including the cache-reuse case
  (Requirement 13), so a reused cached OCR text is stored identically to a
  freshly captured one. If the row is inserted before the LLM pass resolves
  and updated afterward (mirroring how `processed_text`/`is_processed`
  already appear to be set after the fact), `screen_context_text` follows
  the same two-phase write, set on the same update call as `processed_text`.
- `DatabaseManager`'s read-path methods (whatever already returns
  transcription rows to the renderer for History) are extended to include
  the new column in their `SELECT`, unchanged otherwise.

### History UI: displaying stored screen context

- The History list/detail component (the transcription-history view driven
  by the `transcriptions` table — confirm the exact component name during
  execution, e.g. within `ControlPanel.tsx`'s history tab or a dedicated
  `HistoryView`/`TranscriptionHistory` component) gains a new, collapsed-by-
  default expandable section per entry, following whatever existing pattern
  already toggles between/reveals original vs. processed text for a given
  entry (if such a pattern exists; otherwise a simple disclosure/accordion
  row, consistent with the component's existing visual style). Label:
  "Screen context used" (new i18n key). The section is omitted/hidden
  entirely for entries where `screen_context_text` is `NULL` — never shown
  as an empty box.
- New i18n keys (both `en` and `pt`, per project i18n rules), e.g.
  `history.screenContext.label` ("Screen context used") and
  `history.screenContext.empty`/hint copy if a placeholder string is needed
  anywhere (exact key names decided at execution time, grouped under
  `history.*` per existing key-grouping convention).

### Settings & IPC

- New setting key `includeActiveWindowContext` (renderer `useSettingsStore`/
  localStorage), default `true`, boolean. Mirrors the two-sources-of-truth
  pattern (see `project_settings_two_sources_of_truth` memory) only if a
  main-process-side `.env` mirror turns out to be necessary — this setting
  is read at the renderer/`audioManager.js` layer (which already runs in the
  renderer per this file's existing warm-up calls), so no main-process env
  mirror is anticipated; confirm during execution before adding one
  unnecessarily.
- New setting key `screenContextOcrEngine: "auto" | "native" | "tesseract"`
  (renderer `useSettingsStore`/localStorage), default `"auto"`. Same
  no-main-process-mirror reasoning as `includeActiveWindowContext` applies
  here — `activeWindowOcr.js` is invoked from the renderer-driven
  `warmupScreenContext()` path (via the `capture-active-window-context` IPC
  round-trip below), so the setting only needs to be readable at the point
  the IPC call is made/handled; confirm no main-process env mirror is
  needed before adding one.
- New setting key `persistActiveWindowScreenshots` (boolean), default
  `false`. Read on the main-process side inside the `capture-active-
window-context` IPC handler (the handler already runs in main, where the
  capture+OCR helper spawn happens) — passed through as part of that
  request's options (see below), not stored/duplicated in main-process
  `.env`, since it only affects behavior at the moment of a specific
  capture call, not something that needs to survive independent of the
  renderer's settings state.
- New setting key `screenContextRetentionDays` (number), own independent
  setting from `audioRetentionDays` (separate `.env` var, separate
  localStorage key, separate IPC channels — no shared persisted state), but
  with **identical default/fallback semantics**, per the project owner's
  explicit 5th-revision instruction. **Does** need a main-process-side
  mirror, following the exact `audioRetentionDays`/`environment.js`/
  `audioRetentionSync.js` two-sources-of-truth pattern, because the
  automatic cleanup pass (Requirement 17) runs on a `setInterval` inside
  main-process code that starts before any renderer window exists — the
  same reason `audioRetentionDays` needs one. New `.env` var
  `SCREEN_CONTEXT_RETENTION_DAYS`, new `environment.js` methods
  `getScreenContextRetentionDays()`/`saveScreenContextRetentionDays(days)`/
  `hasScreenContextRetentionDaysBeenSet()`, ported line-for-line from
  `getAudioRetentionDays()`/`saveAudioRetentionDays()`/
  `hasAudioRetentionDaysBeenSet()` with only the env-var name and internal
  key changed:
  - `getScreenContextRetentionDays()`: reads `SCREEN_CONTEXT_RETENTION_DAYS`;
    if never persisted (empty string) returns `0`; if the persisted value
    fails to parse as a finite, non-negative integer, also returns `0` —
    identical fallback logic to `getAudioRetentionDays()`'s
    `if (raw === "") return 0; ... if (!Number.isFinite(parsed) || parsed < 0) return 0;`.
  - `saveScreenContextRetentionDays(days)`: normalizes negative/non-finite
    input to `0` and floors fractional input, exactly mirroring
    `saveAudioRetentionDays()`'s
    `Number.isFinite(days) && days >= 0 ? Math.floor(days) : 0` normalization.
  - `hasScreenContextRetentionDaysBeenSet()`: `true` once
    `SCREEN_CONTEXT_RETENTION_DAYS` has been persisted at least once
    (including an explicit save of `0`, which still counts as "has been
    set" — distinct from "never configured"), mirroring
    `hasAudioRetentionDaysBeenSet()`'s exact semantics.
  - **Default value: `0`** (delete all existing persisted screenshots
    immediately when never configured) — this supersedes the 4th
    revision's `30`-day default entirely; there is no longer an Open
    Question here (see Open Questions section).
- New IPC channels (added to both `ipcHandlers.js` and `preload.js`):
  - `capture-active-window-context` (renderer → main → renderer): triggers
    capture+OCR for the current recording, returns `{ text: string | null }`.
    Invoked by `warmupScreenContext()`. Its request payload now also
    carries the resolved `screenContextOcrEngine` and
    `persistActiveWindowScreenshots` values (read by the renderer from its
    own settings store at call time) so the main-process handler knows
    which engine to force and whether to persist a copy.
  - `get-active-window-context-platform-support`: returns whether the
    current platform supports this feature at all (Windows check), used to
    hide/disable the Settings toggle on macOS/Linux.
  - `get-screen-context-retention-days` / `save-screen-context-retention-days`:
    mirror `get-audio-retention-days`/`save-audio-retention-days` exactly —
    read/write `environment.js`'s new getter/setter.
  - `get-screen-context-retention-sync-state`: mirrors
    `get-audio-retention-sync-state` (`{ hasBeenSet, days }`), consumed by a
    new `resolveScreenContextRetentionStartupSync()` pure helper (see below)
    the same way `resolveAudioRetentionStartupSync()` is consumed today.
  - `get-screen-context-storage-usage`: mirrors `get-audio-storage-usage`/
    `get-meeting-audio-storage-usage` (`{ fileCount, totalBytes }`) for the
    persisted-screenshots directory.
  - `delete-all-screen-context-screenshots`: mirrors `delete-all-audio` —
    deletes every file under `userData/screen-context-captures/`
    immediately, regardless of retention window. Powers the new manual
    "Clear All Screen Context Screenshots" button.
  - **New (5th revision)**: `get-tesseract-ocr-status`,
    `download-tesseract-ocr-assets`, `cancel-tesseract-ocr-download`,
    `delete-tesseract-ocr-assets`, and the `tesseract-ocr-download-progress`
    event — see the new "Tesseract OCR: on-demand download" Design
    subsection (Requirement 19) for their exact shapes, mirrored 1:1 from
    `get-llama-cuda-status`/`download-llama-cuda-binary`/
    `cancel-llama-cuda-download`/`delete-llama-cuda-binary`/
    `llama-cuda-download-progress`.
- New renderer helper `src/helpers/screenContextRetentionSync.js`, mirroring
  `audioRetentionSync.js`'s `resolveAudioRetentionStartupSync()` pure
  function precisely (same "main's persisted value wins if genuinely
  already set, otherwise renderer's current value wins and gets pushed up"
  logic), called from `initializeSettings()` in `settingsStore.ts`
  alongside the existing audio-retention sync call.
- Settings UI is split across two sections by function, not lumped into
  one, to keep each control next to its existing sibling controls (the
  functional/behavioral settings live where the user is already configuring
  dictation behavior; the storage/cleanup surface lives where every other
  storage/cleanup surface in the app already lives):
  - **Settings → Speech-to-Text → Dictation** (the same section that
    already hosts the Live/VAD tabs from §19) hosts the three
    behavior-affecting settings:
    - `includeActiveWindowContext` toggle (existing master toggle; final
      section placement is still an explicit Open Question below, but this
      revision leans toward here rather than AI Models, since it's a
      dictation-time capture behavior).
    - `screenContextOcrEngine` — a segmented control / select ("Automatic" /
      "Native Windows OCR" / "Tesseract"), shown only when
      `includeActiveWindowContext` is on. **RESOLVED (5th revision)**: the
      "Native Windows OCR" option is hidden entirely (not shown disabled)
      when native-OCR feature-detection reports it unavailable on this
      build/platform — "Automatic" and "Tesseract" are always shown
      regardless (see Requirement 15/Design's "OCR engine selection"). This
      control also hosts the Tesseract download-required prompt/progress
      bar (Requirement 19, new "Tesseract OCR: on-demand download"
      subsection) directly beneath it when applicable.
    - `persistActiveWindowScreenshots` toggle, with an i18n'd description
      warning that this writes screenshots of whatever app was focused to
      local disk — stronger, more sensitive exposure than OCR text alone,
      which is the reason this defaults OFF.
  - **Settings → Privacy & Data** hosts the storage/retention surface,
    consistent with where the existing dictation-audio and meeting-audio
    "Clear All"/storage-usage rows already live:
    - `screenContextRetentionDays` — a dropdown mirroring the existing
      `audioRetentionDays` dropdown's preset shape (e.g. 1/7/14/30/60/90
      days, plus "delete immediately" for 0), shown only when
      `persistActiveWindowScreenshots` is on.
    - A "Clear All Screen Context Screenshots" manual button, next to a
      storage-usage readout (file count + total size) fed by
      `get-screen-context-storage-usage`, mirroring the existing
      dictation-audio "Storage Usage" row's layout. Shown whenever
      `persistActiveWindowScreenshots` is on or has ever been on (i.e.
      don't hide it just because the user just turned the toggle off —
      leftover files from Requirement 17's "toggling off doesn't
      auto-delete" behavior still need a manual escape hatch).
      All controls in both sections are hidden (or shown disabled with an
      explanatory note) when `get-active-window-context-platform-support`
      reports unsupported — same as prior revisions' toggle-hiding behavior,
      now applied to the whole settings cluster regardless of which section it
      renders in.

### Lifecycle / idle-budget compliance

- No process from this feature exists at app startup or during idle.
  `windows-active-window-info.exe` is a short-lived, one-shot spawn per
  capture (not a persistent listener) — nothing to idle-unload. The
  PowerShell OCR bridge is likewise one-shot per OCR call. The Tesseract.js
  fallback path only spawns/uses the ONNX utility process, which is already
  lazy-spawned on first use and covered by its existing lifecycle — this
  feature simply becomes one more trigger for that same existing spawn,
  not a new always-on service.
- **Revised in this revision**: one new interval timer _is_ introduced —
  `_setupScreenContextCleanup()`'s six-hour purge tick (see "Screenshot
  persistence and retention" above), directly analogous to the existing
  `_setupAudioCleanup()` interval. This is justified against Premise #2 the
  same way the existing audio-cleanup interval already is: it reuses the
  established six-hour cadence (no new magic number), does a single
  `readdirSync`/`statSync` pass over a directory that is typically empty or
  small (only populated at all when `persistActiveWindowScreenshots` is
  explicitly opted into), and performs no work whatsoever when
  `screenContextRetentionDays` is unset/invalid for that tick. Idle CPU/RAM
  impact is the same order of magnitude as the existing, already-accepted
  dictation-audio cleanup tick.
- No other new timer/polling loop is introduced by this spec.

### Data retention

- Screenshots: by default (`persistActiveWindowScreenshots = false`),
  behavior is unchanged from prior revisions — never written to disk except
  as a same-request temp file when a given OCR strategy requires a file
  path (see Capture/OCR sections), and always deleted immediately after
  that OCR call resolves or rejects (`finally` block, mirroring the audio
  pipeline's temp-file cleanup). **New in this revision**: when the user
  explicitly opts into `persistActiveWindowScreenshots`, the captured PNG
  is additionally written to `userData/screen-context-captures/` (see
  "Screenshot persistence and retention" above) — this is deliberately
  **collected/ephemeral data** under CLAUDE.md Premise #7 (same category as
  dictation audio, not the "operational, never-auto-expunged" category
  notes/meeting-audio/dictionary fall under), and is therefore the one
  artifact in this feature that ships with its own user-facing retention
  setting (`screenContextRetentionDays`) and automatic background purge
  (`_setupScreenContextCleanup()`), plus a manual "Clear All" button —
  satisfying Premise #7's requirement that a manual button alone is
  insufficient for collected/ephemeral data.
- OCR'd text: held in memory (`this.screenContextPromise`'s resolved value,
  plus the short-lived `lastScreenContext` reuse cache from Requirement 13)
  for the duration of a single recording/LLM-pass cycle and the up-to-2-
  second reuse window that follows it, then superseded/discarded on the next
  capture or app switch — **with one deliberate exception introduced by this
  revision**: whatever screen-context text actually got threaded into a given
  transcription's LLM request is now also persisted into that transcription's
  `screen_context_text` column in the `transcriptions` table (Requirement 14).
  This is not a new retention category — it rides along with the rest of
  that row (`original_text`/`processed_text`) as part of the existing
  "SQLite transcription-history text," which CLAUDE.md §7 already classifies
  as **collected/ephemeral data** eligible for user-controlled retention +
  auto-purge (today, only a manual "Clear All", with age-based auto-expiry
  noted as an existing gap to fill — unchanged by this spec). No separate
  retention rule is introduced for just this column; it lives and dies with
  its parent row under whatever retention policy applies to that row. Debug
  logs continue to log only a short length/hash of OCR'd text, never the
  full extracted text, regardless of this DB persistence change.
- The Requirement 13 reuse cache (`lastScreenContext`) remains purely
  in-memory, process-lifetime-only, and is never persisted to disk under any
  circumstance — it is a distinct, transient object from the persisted
  history column above.

## Validation Plan

### Automated

- `test/helpers/activeWindowCapture.test.js` (new): mocks
  `desktopCapturer.getSources` and the native helper's stdout at the
  module boundary (spawn mocked, not the real binary); asserts:
  - Returns `null` gracefully when the native helper binary is missing/
    errors (never throws).
  - Returns a bounded/capped image buffer when both the helper and
    `desktopCapturer` succeed.
  - No temp file is left behind after a capture cycle completes (assert
    on the temp dir before/after, or that a delete/cleanup call was
    invoked) — covers Requirement 8.
- `test/helpers/activeWindowOcr.test.js` (new): mocks the PowerShell
  spawn (native OCR) and the ONNX-worker OCR message (Tesseract fallback)
  at the IPC/process boundary; asserts:
  - With `screenContextOcrEngine: "auto"`, falls back to Tesseract path when
    native OCR spawn errors/rejects.
  - Resolves to `null`/empty (not throwing) when both strategies fail under
    `"auto"` — covers Requirement 7.
  - **New (Requirement 15)**: with `screenContextOcrEngine: "native"` and
    the native OCR mock made to fail/reject, asserts the Tesseract
    mock/ONNX-worker OCR message is **never invoked** (call count zero) and
    the function resolves to `null`/empty rather than silently falling
    back — proving the no-fallback contract of the forced-native mode.
  - **New (Requirement 15)**: with `screenContextOcrEngine: "tesseract"`
    and a working native OCR mock available, asserts the native
    PowerShell-spawn mock is **never invoked** (call count zero) and only
    the Tesseract path runs — proving native is skipped entirely, not just
    deprioritized.
  - **New (Requirement 15)**: with an unrecognized/corrupt persisted
    `screenContextOcrEngine` value (e.g. `"bogus"`), asserts the function
    falls back to `"auto"` behavior (native tried first, Tesseract
    fallback available) rather than throwing or silently no-op'ing.
- `test/helpers/audioManager.screenContext.test.js` (new, or an addition
  to an existing `audioManager` test file if one exists — confirm during
  execution): asserts that when the screen-context promise has not
  resolved by the time the cleanup/agent request is assembled, the
  request proceeds without screen context rather than waiting past its
  bound — covers Requirements 2/3.
- **New test case (Requirement 1a)**, in the same
  `test/helpers/audioManager.screenContext.test.js` file (or
  `test/helpers/dictationRouting.test.js` if `shouldCaptureScreenContext()`
  ends up co-located there — confirm at execution time): with the cleanup
  LLM disabled/unconfigured for `dictationCleanup` and a plain,
  non-voice-agent, non-wake-word dictation (i.e. `resolveDictationRouteKind()`
  would return a non-agent route), assert that `warmupScreenContext()`
  never spawns the capture helper / never invokes
  `capture-active-window-context` — mock the spawn/IPC boundary and assert
  zero calls. Also assert the inverse: with the cleanup LLM enabled (or the
  agent route applying), the same gate returns `true` and the capture path
  is invoked as normal — covers Requirement 1a end-to-end (both the
  skip case and the fire case).
- `test/config/prompts.test.js` (new or extended): asserts
  `appendScreenContextSuffix()` correctly appends/wraps screen text, and
  is a no-op (returns the prompt unchanged) when screen text is
  null/empty — covers the prompt-threading design above.
- A settings-store/component test (React Testing Library, extending
  whatever pattern `SettingsPage.tsx` tests already use, or a new file if
  none exists) asserting: the toggle defaults to `true`; toggling it off
  and starting a recording does not invoke
  `capture-active-window-context`; the toggle is hidden/disabled when
  `get-active-window-context-platform-support` reports `false` — covers
  Requirements 6 and 9.
- `test/scripts/download-windows-active-window-info.test.js` is not
  required (no automated test exists for the other `download-*.js`
  scripts in this repo either — consistent with existing convention, not
  a gap introduced by this spec).
- **New: `test/helpers/screenContextCache.test.js`** (or extending
  `activeWindowCapture.test.js`, execution's call), covering Requirement 13
  by mocking the cheap identity-check helper and the full capture+OCR path
  separately so call counts can be asserted:
  - Same app, second hotkey-down fires ≤2000ms after the first recording's
    stop timestamp → full capture+OCR invoked exactly once across both
    turns; the second turn's resolved screen-context text equals the first
    turn's cached `ocrText`, and only the cheap identity check (not the full
    capture helper) is invoked on the second turn.
  - Same app, second hotkey-down fires >2000ms after the first recording's
    stop timestamp → full capture+OCR invoked twice (once per turn), with
    the identity check still run first each time (proving the gap-boundary
    condition, not just app identity, gates the decision).
  - Different app (identity check returns a different `appIdentifier`),
    second hotkey-down within the 2000ms window → full capture+OCR invoked
    twice (cache is not reused across an app switch even within the time
    window).
  - No prior cached entry (first-ever dictation, or app restart) → full
    capture+OCR invoked, no reuse attempted, and the identity-check result
    becomes the seed for `lastScreenContext`.
- **New: `test/helpers/database.migration.test.js`** (or extending whichever
  existing migration test file already exercises `database.js`'s additive-
  column migrations, e.g. alongside coverage for `custom_dictionary`'s
  `learned_from` column) covering Requirement 14's schema change and Premise
  #6's migration-safety bar:
  - Seed a temporary SQLite file with the **pre-migration** `transcriptions`
    schema (no `screen_context_text` column) and pre-existing rows
    (`original_text`, `processed_text`, etc. populated), then run
    `DatabaseManager`'s init/migration path against it and assert: the
    migration completes without error, all pre-existing rows are still
    present with their original column values unchanged, and each
    pre-existing row's new `screen_context_text` column reads `NULL`.
  - A freshly inserted row with a non-null screen-context string round-trips
    correctly through both the write path and the read path used by History.
  - Running the migration a second time against an already-migrated database
    is a no-op (idempotency — no duplicate-column error).
- A History-component test (React Testing Library, extending whichever
  pattern the existing history/transcription-list component tests already
  use, or a new file if none exists) asserting: an entry with a non-null
  `screen_context_text` renders the new expandable "Screen context used"
  section and reveals the text on expand; an entry with `screen_context_text
= null` renders no such section at all — covers Requirement 14's UI half.
- **New: `test/helpers/screenContextStorage.test.js`** (new, mirroring
  whatever test file already exists for `audioStorage.js`'s
  `AudioStorageManager` — reuse its fixture/temp-dir setup pattern),
  covering Requirements 16-17:
  - `saveScreenshot()` writes a PNG file to a temp `userData`-style
    directory and returns `{ success: true, path }`; the returned path
    actually exists on disk with non-zero size.
  - `cleanupExpiredScreenshots(retentionDays)` mirrors
    `cleanupExpiredAudio()`'s exact edge-value contract — port the same
    table-driven cases `test/helpers/audioStorage.test.js`'s dictation-audio
    coverage uses, applied to `.png` files instead of `.webm`:
    - `retentionDays = 0` deletes **all** existing screenshot files
      immediately (valid, deliberate "delete now," not "disabled") — even
      ones created moments ago.
    - `retentionDays = 7` (or another positive value) deletes only files
      older than the cutoff, keeps newer ones.
    - `retentionDays = -1` and `retentionDays = NaN`/`Infinity` are treated
      as invalid: the cleanup pass is skipped entirely for that tick (no
      files deleted), logged as a warning — never conflated with the valid
      `0` case.
  - `deleteAllScreenshots()` removes every file in the directory regardless
    of age, returns the count deleted — covers the manual "Clear All"
    button's underlying call.
  - `getStorageUsage()` returns accurate `{ fileCount, totalBytes }` for a
    directory seeded with a known set of files.
- **CHANGED (5th revision) — no new pure function needed**: the 4th
  revision's "extend `audioCleanupPolicy.test.js` if a
  `decideScreenContextCleanup` sibling is added" bullet no longer applies.
  Per the Design decision above, `decideAudioCleanup()`/
  `shouldRunImmediateCleanup()` are imported and called **unchanged** for
  screen-context cleanup, so `test/helpers/audioCleanupPolicy.test.js`
  itself needs no edits — its existing coverage already exercises the exact
  functions the new `_setupScreenContextCleanup()` calls. Instead:
  - **New: `test/helpers/screenContextRetentionSettings.test.js`**, ported
    line-for-line from `test/helpers/audioRetentionSettings.test.js`'s exact
    structure (same `electron`/keyring mock-via-`Module._load` setup, same
    temp-userData-dir fixture) but targeting the new
    `getScreenContextRetentionDays()`/`saveScreenContextRetentionDays()`/
    `hasScreenContextRetentionDaysBeenSet()` methods and
    `SCREEN_CONTEXT_RETENTION_DAYS` env var, asserting:
    - `getScreenContextRetentionDays()` falls back to `0` when never
      persisted (mirrors "getAudioRetentionDays falls back to 0 when never
      persisted").
    - `hasScreenContextRetentionDaysBeenSet()` is `false` until a value is
      saved, and an explicit save of `0` still counts as "has been set."
    - `saveScreenContextRetentionDays()` round-trips a configured value
      (e.g. `7`) and normalizes negative/non-finite input (`-5`, `NaN`) to
      `0`, and floors fractional input (e.g. `7.9` → `7`).
    - A malformed hand-edited `.env` value (e.g. `"not-a-number"`, `"-3"`)
      normalizes to the `0` fallback via `getScreenContextRetentionDays()`.
- **New: `test/helpers/ipcHandlers.screenContextCleanup.test.js`** — a
  genuinely new test file; there is no existing direct precedent testing
  `_setupAudioCleanup()`'s interval/startup-safeguard wiring itself at the
  `ipcHandlers.js` level today (only the pure-function policy and the
  storage-manager cleanup method are unit-tested independently), so this is
  new coverage for both artifacts' wiring pattern, not a mirror of an
  existing file. Asserts, for the new `_setupScreenContextCleanup()`:
  - The very first immediate cleanup pass at construction is skipped when
    `hasScreenContextRetentionDaysBeenSet()` returns `false` (startup-
    ordering safeguard, mirroring the audio-retention equivalent's
    documented behavior in CLAUDE.md's "Audio Retention Cleanup" section).
  - Once a value has been persisted, the immediate pass runs and the
    six-hour interval is scheduled (fake timers, assert `setInterval` is
    called with the same `SIX_HOURS_MS` constant already used for
    dictation-audio cleanup — no new interval cadence).
  - An invalid persisted value (negative/NaN) causes a tick to be skipped
    (no `cleanupExpiredScreenshots` call) without throwing or crashing the
    interval.
  - A spy/mock on `decideAudioCleanup`/`shouldRunImmediateCleanup` (module-
    level, e.g. via `Module._load`/dependency injection) confirms
    `_setupScreenContextCleanup()` actually calls the shared,
    already-tested functions rather than an inline reimplementation of the
    same logic — locking in the "no duplicate policy function" decision
    above against silent regression.
- **New (Requirement 16, "opt-in only" contract)**: a test (extending
  `activeWindowCapture.test.js` or a new
  `test/helpers/ipcHandlers.captureActiveWindowContext.test.js`) asserting,
  at the `capture-active-window-context` IPC-handler boundary with the
  screenshot-storage save call mocked:
  - With `persistActiveWindowScreenshots: false` (default), the save-to-disk
    call is **never** invoked, regardless of OCR success/failure — covers
    Requirement 8's default-unchanged guarantee.
  - With `persistActiveWindowScreenshots: true`, the save-to-disk call
    **is** invoked exactly once per capture, with the same PNG buffer that
    was handed to OCR, and this happens regardless of whether OCR itself
    succeeded or failed (persistence is independent of OCR outcome, per
    Design).
- A settings-store/component test (extending the existing toggle test from
  Requirements 6/9, or a new file) asserting: `screenContextOcrEngine`
  defaults to `"auto"`; `persistActiveWindowScreenshots` defaults to
  `false`; `screenContextRetentionDays` resolves to `0` and its dropdown
  defaults to the "delete immediately" preset when never configured
  (5th revision — covers Requirement 17's changed default); the
  `screenContextRetentionDays` dropdown and the "Clear All Screen Context
  Screenshots" button are hidden/disabled unless `persistActiveWindowScreenshots`
  is `true`; clicking "Clear All Screen Context Screenshots" invokes the
  `delete-all-screen-context-screenshots` IPC channel exactly once — covers
  Requirement 18's Settings-UI wiring and the manual-clear-button half of
  Requirement 17.
- **New: `test/helpers/tesseractOcrManager.test.js`** (new, 5th revision),
  structured identically to `test/helpers/llamaCudaManager.test.js` (same
  `Module._load`-based `electron` mock providing a temp `app.getPath("userData")`
  directory per test, same `setPlatformArch`-style fixtures only if
  `isSupported()` ends up platform-gated — otherwise omitted since Tesseract
  is expected to report `isSupported() === true` universally), covering
  Requirement 19:
  - `isDownloaded()` returns `false` before any asset files exist under the
    manager's asset directory, and `true` once the expected asset files
    (WASM core + trained-data language file) are written to disk — mirrors
    `llamaCudaManager.test.js`'s `getBinaryPath`/`isDownloaded` coverage.
  - `getStatus()` reflects `{ supported, downloaded, downloading }`
    correctly in each combination, mirroring the equivalent CUDA test
    exactly (including toggling `_downloading` directly and re-checking).
  - `download()` rejects with an "already in progress"-style error when
    `_downloading` is already `true`, without touching the filesystem or
    attempting a network call — mirrors `llamaCudaManager.test.js`'s
    "download() rejects when a download is already in progress" test.
  - `download()`'s disk-space pre-check: with `checkDiskSpace` mocked/
    stubbed to report insufficient space, asserts `download()` rejects with
    a clear, user-presentable error message before any `downloadFile()` call
    is attempted (assert the download-file mock has zero calls).
  - `cancelDownload()` returns `false` when nothing is downloading, and
    `true` (invoking the active signal's `abort()`) when a download is in
    progress, clearing the internal signal reference afterward — mirrors
    the CUDA manager's two `cancelDownload` tests exactly.
  - `deleteAssets()` removes the downloaded asset files and returns a
    `{ success, deletedCount }`-shaped result — mirrors `deleteBinary()`'s
    test.
- **New: a settings-component test** (React Testing Library, extending
  whatever component test already exists for `GpuModeSelector.tsx` if one
  does — otherwise a new file for the `screenContextOcrEngine` control),
  covering Requirement 15's resolved hiding behavior and Requirement 19's
  download-affordance UX, mocking `get-active-window-context-platform-support`/
  a native-OCR-availability signal and `get-tesseract-ocr-status`:
  - When native OCR is reported unavailable, the "Native Windows OCR"
    option is not rendered at all (not merely disabled) in the segmented
    control.
  - When `get-tesseract-ocr-status` reports `downloaded: false`, selecting
    (or already having selected) "Tesseract"/"Automatic" renders the inline
    "Download required" prompt with a visible Download button — mirroring
    `GpuModeSelector`'s `needsCudaDownload`/`needsVulkanDownload` prompt
    tests if any exist, or its component structure otherwise.
  - Clicking the Download button invokes `download-tesseract-ocr-assets`
    exactly once, renders a progress bar driven by
    `tesseract-ocr-download-progress` events, and the prompt disappears
    once a subsequent `get-tesseract-ocr-status` poll/response reports
    `downloaded: true`.
  - The "Tesseract" option itself remains selectable/clickable throughout —
    it is never disabled or hidden merely because it isn't downloaded yet
    (distinguishing this from the native-OCR hiding case above).

### Manual

1. On Windows, enable the new Settings toggle (should already default ON),
   focus a window with visible text (e.g. Notepad with some text), press
   the dictation hotkey, dictate a command referencing that text (e.g. with
   the dictation agent enabled, "summarize what's on my screen"), release,
   and confirm the agent's response reflects the on-screen text.
2. Verify the raw pasted transcript still appears well within the existing
   sub-500ms budget regardless of whether OCR has finished — time it with
   and without the toggle enabled and confirm no observable difference to
   the raw-transcript path.
3. Disable the toggle, repeat step 1, and confirm the agent has no
   knowledge of the on-screen text (screen context was not sent).
4. In tap-to-toggle mode specifically (where the dictation overlay's focus
   behavior around hotkey-press differs from push-to-talk), confirm the
   captured/OCR'd text corresponds to the target app the user was actually
   looking at — not EktosWhispr's own overlay window — verifying the
   self-exclusion behavior in `windows-active-window-info.exe`.
5. Temporarily rename/remove the native helper binary (or block PowerShell
   execution policy) and confirm dictation still completes normally with no
   crash and no user-facing error — only a debug-log line noting the
   fallback/failure.
6. Confirm no screenshot files remain in the OS temp directory after
   several dictation cycles (spot-check via file explorer or `dir`).
7. On macOS or Linux (or by mocking the platform check), confirm the
   Settings toggle is hidden/disabled and no capture is attempted.
8. Confirm idle RAM/CPU (per Premise #2) is unaffected — no new process is
   running when the app is idle with no recording in progress.
9. With the toggle ON but cleanup disabled and no dictation-agent/voice-agent
   route active (plain dictation, no cleanup model configured), perform a
   dictation and confirm via debug logs (or Task Manager/Process Explorer)
   that no `windows-active-window-info.exe` process is ever spawned — the
   gating check (Requirement 1a) skipped capture entirely.
10. **OCR reuse (Requirement 13)**: with the agent/cleanup route active, in
    the same app, dictate a short phrase, then immediately (well within 2
    seconds) dictate a second short phrase in the same window. Confirm via
    debug logs / Process Explorer that the full capture+OCR helper only runs
    once (for the first dictation) and the second dictation's LLM pass still
    receives the same screen context, with only the cheap identity-check
    invoked the second time. Repeat with a >2 second pause between the two
    dictations and confirm the full capture+OCR helper runs both times.
    Repeat again by switching to a different app between the two dictations
    (within 2 seconds) and confirm the full capture+OCR helper runs both
    times (no stale cross-app reuse).
11. **History screen context (Requirement 14)**: perform a dictation that
    triggers the cleanup/agent route with screen context captured, open
    History, locate that entry, expand "Screen context used," and confirm
    the displayed text matches what was actually OCR'd (compare against the
    focused window's visible text at capture time). Then perform a plain
    dictation with the feature disabled/gated-off and confirm that entry
    shows no "Screen context used" section at all.
12. **Migration (Requirement 14 / Premise #6)**: take (or simulate) a
    pre-upgrade copy of the app's SQLite database file (without the new
    column), launch the upgraded app against it, and confirm existing
    History entries still display correctly (original/processed text
    intact) with no "Screen context used" section shown for any of them
    (since their `screen_context_text` is `NULL`), and no crash/error during
    startup migration.
13. **OCR engine forcing (Requirement 15)**: set `screenContextOcrEngine` to
    "Native Windows OCR" in Settings, temporarily block/disable native OCR
    (e.g. rename the PowerShell bridge script or revoke the language pack),
    and confirm the LLM pass proceeds with **no** screen context (not a
    silent Tesseract fallback) — check debug logs confirm no Tesseract/ONNX
    OCR invocation occurred. Then set it to "Tesseract" with native OCR
    working normally and confirm debug logs show only the Tesseract path
    ran, never the PowerShell bridge. Finally set it back to "Automatic"
    and confirm native-first-then-fallback behavior returns.
14. **Screenshot persistence toggle (Requirement 16)**: with
    `persistActiveWindowScreenshots` OFF (default), perform several
    dictations and confirm no files appear under
    `userData/screen-context-captures/` (check via file explorer — the
    directory may not even exist yet). Turn the toggle ON, perform another
    dictation, and confirm exactly one new PNG file appears in that
    directory, visually matching the window that was focused at capture
    time.
15. **Retention dropdown and automatic purge (Requirement 17)**: with
    persistence ON, set `screenContextRetentionDays` to a small value (e.g.
    1 day), manually back-date an existing screenshot file's modified time
    beyond that window (or wait/simulate the six-hour tick), and confirm
    the file is automatically deleted on the next cleanup pass without any
    manual action, while a freshly captured file within the window is kept.
    Then set the value to `0` and confirm the very next cleanup pass
    deletes all existing screenshot files immediately.
16. **Manual "Clear All Screen Context Screenshots" button (Requirement 17)**: with several persisted screenshot files present (deliberately
    within the retention window, so the automatic purge wouldn't remove
    them yet), click the new button in Settings → Speech-to-Text →
    Dictation and confirm all files under
    `userData/screen-context-captures/` are deleted immediately and the
    storage-usage readout updates to show 0 files / 0 bytes.
17. **Toggle-off does not retroactively delete (Requirement 17)**: with
    persistence ON and a few files present, turn
    `persistActiveWindowScreenshots` OFF and confirm the existing files are
    **not** deleted by that action alone — they remain until the retention
    purge or the manual "Clear All" button removes them.
18. **Default-`0` retention on first launch (Requirement 17, 5th revision,
    new)**: on a fresh profile/userData (or a profile that has never opened
    Settings → Privacy & Data's screen-context row), enable
    `persistActiveWindowScreenshots`, perform a dictation to create a
    persisted screenshot, then confirm the _renderer's_ settings-store
    startup sync establishes the real value (per
    `screenContextRetentionSync.js`, mirroring `audioRetentionSync.js`) —
    the file should **not** be silently deleted by main's own `0` fallback
    on the very first immediate cleanup pass at boot (startup-ordering
    safeguard), but **should** be deleted (or not, per whatever value the
    user actually configures) once the renderer's sync round-trip
    completes and a subsequent cleanup tick runs.
19. **Tesseract on-demand download (Requirement 19, new)**: on a fresh
    profile where Tesseract assets have never been downloaded, open
    Settings → Speech-to-Text → Dictation, select "Tesseract" (or
    "Automatic" with native OCR unavailable) for `screenContextOcrEngine`,
    and confirm an inline "Download required" prompt with a Download button
    appears — the option itself remains selectable/clicked, it is not
    greyed out or gated. Click Download, confirm a progress bar advances
    and completes, then confirm the prompt disappears. Perform a dictation
    routed through the agent/cleanup pass with the focused window showing
    visible text, and confirm the OCR'd text now reflects that window's
    content via the Tesseract path (check debug logs to confirm the native
    PowerShell bridge was not the one that ran, if native OCR was
    deliberately made unavailable for this test). Separately, without ever
    clicking Download, perform a dictation while "Tesseract" is selected
    and confirm the LLM pass proceeds with no screen context and no
    download is silently triggered mid-dictation (check Task
    Manager/Process Explorer and debug logs for the absence of any network
    download activity during the recording).

### Docs

- `CLAUDE.md`: add a new numbered section (following the pattern of §17
  Voice Agent Hotkey / §19 Progressive VAD Batching) documenting this
  feature once implemented, and add `windows-active-window-info.exe` to the
  Native Resources / Helper Modules lists.
- `docs/RECREATION_SPEC.md`: update to reflect the new capture/OCR/context
  behavior as actual, current behavior once implemented.
- `docs/network-allowlist.md`: confirm no new outbound host is introduced
  (this feature is local-only apart from the existing, unchanged cloud-LLM
  BYOK calls) — add a note if execution finds otherwise.
- `docs/guides/TROUBLESHOOTING.md`: add a row for "agent doesn't seem to
  know what's on my screen" pointing at the new toggle and its native
  OCR/Tesseract fallback behavior.
- `CLAUDE.md`'s "Database Schema" section: add `screen_context_text` to the
  documented `transcriptions` table columns once implemented.
- `docs/RECREATION_SPEC.md`: update to reflect the OCR reuse-cache behavior
  and the new `screen_context_text` column/History UI as actual, current
  behavior once implemented.
- **New (4th revision)**: `CLAUDE.md`'s "Settings Storage" list gets four
  new entries (`includeActiveWindowContext`, `screenContextOcrEngine`,
  `persistActiveWindowScreenshots`, `screenContextRetentionDays`), and its
  "Helper Modules" list gets a new `screenContextStorage.js` entry
  (mirroring how `audioStorageManager.js`/`meetingAudioStorage.js` are
  already documented there — note the actual existing dictation-audio
  module is `src/helpers/audioStorage.js`, exporting `AudioStorageManager`;
  execution should confirm the exact filename it mirrors when writing this
  doc update). CLAUDE.md's "Data Retention" / Premise #7 prose should also
  gain a short cross-reference noting that persisted screen-context
  screenshots are a second, independent artifact in the same "collected/
  ephemeral, user-controlled retention + auto-purge" category as dictation
  audio, once implemented.
- **New (5th revision)**: `CLAUDE.md`'s "Helper Modules" list also gets a
  new `tesseractOcrManager.js` entry (mirroring how `llamaCudaManager.js`/
  `llamaVulkanManager.js` are documented — check whether those are
  currently listed in CLAUDE.md at all and add them alongside if not,
  since this spec now leans on them as the cited reference pattern).
  `CLAUDE.md`'s "Non-Negotiable Product Premises" §1 privacy prose does not
  need a change for Tesseract's download itself (it's a one-time,
  user/system-initiated asset fetch of open-source OCR software, not a
  telemetry/analytics call and not user data leaving the device — no
  different in kind from downloading a Whisper model or the CUDA runtime,
  both already normal, undocumented-as-exceptional behavior in this
  codebase).
- `docs/network-allowlist.md`: **new (5th revision)** — add whatever host
  Tesseract's WASM/trained-data assets are actually downloaded from once
  execution picks the exact source (official `tesseract.js`/
  `tesseract.js-core` CDN or a GitHub Releases URL), the same way this file
  already documents the llama.cpp GitHub-releases host used by
  `llamaCudaManager.js`/`llamaVulkanManager.js`/`download-llama-server.js`.

## Open Questions

- **RESOLVED (5th revision) — was BLOCKING**: Default-ON vs. default-OFF for
  the new toggle. The project owner has confirmed default-ON ships as-is —
  see TL;DR and Requirement 6. This is no longer open; the tension with
  Premise #1 remains documented as a deliberate, reviewed exception, not a
  pending decision.
- Whether `PrintWindow(PW_RENDERFULLCONTENT)` reliably captures all modern
  GPU-composited app windows (e.g. some Electron/Chromium/DirectComposition
  surfaces are known to be finicky with this API) or whether a
  Desktop-Duplication-API-based fallback is needed for those cases — to be
  verified empirically during execution; the Design section's approach is
  the intended primary path, not guaranteed complete.
- Exact final placement of the settings cluster: this revision's Design
  splits it — `includeActiveWindowContext`/`screenContextOcrEngine`/
  `persistActiveWindowScreenshots` in Settings → Speech-to-Text →
  Dictation (behavior-affecting, alongside where dictation is otherwise
  configured), and `screenContextRetentionDays` + the "Clear All Screen
  Context Screenshots" button + storage-usage readout in Settings →
  Privacy & Data (alongside the existing dictation-audio/meeting-audio
  storage rows). This is a considered default, not a placeholder, but
  left open in case the project owner prefers `includeActiveWindowContext`
  itself to live in AI Models instead (near the cleanup/agent toggles it
  feeds) — confirm at execution time if so.
- **RESOLVED (5th revision)**: `screenContextRetentionDays`'s default is now
  `0`, mirroring `audioRetentionDays`'s exact fallback semantics, per the
  project owner's explicit instruction ("retenção padrão igual as demais
  opções de retenção"). This supersedes the 4th revision's `30`-day default
  and the open question raised about it — see Requirement 17/Design/TL;DR.
- **RESOLVED (5th revision)**: the "Native Windows OCR" option is hidden
  entirely (not shown disabled) when native OCR is known to be unavailable
  on the current build/platform, confirmed by the project owner. See
  Requirement 15/Design's "OCR engine selection" for the resolved behavior,
  and the new "Tesseract OCR: on-demand download" Design subsection for how
  this interacts with Tesseract's not-yet-downloaded state (never hidden
  for that reason — only for structural unavailability).
- Whether chat-agent parity (not just cleanup/dictation-agent) is in scope
  for this first cut, or a fast-follow — see Design's note under "Threading
  OCR text into the LLM context."
- Whether Windows requires any screen-recording consent/permission prompt
  in the app's target deployment scenarios (enterprise-managed devices,
  etc.) — flagged for verification during execution per Requirement 12.
- Exact mechanism for the cheap "same app" identity check (new
  `--identify-only` helper mode vs. some other cheap Windows API path, e.g.
  reading the foreground PID directly from Node via a small native addon or
  existing library instead of spawning a process at all) — left to
  execution to pick whichever is empirically fastest, as long as it's
  strictly cheaper than the full capture+OCR path (Requirement 13).
- Exact placement/component name for the History UI's new "Screen context
  used" section — left to spec-executor to confirm against the actual
  component structure at execution time.
