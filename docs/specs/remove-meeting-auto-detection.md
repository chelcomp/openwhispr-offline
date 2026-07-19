# Remove Meeting Auto-Detection / Notification System

## Status
Approved

Approved directly by the project owner in conversation, with the three Open Questions below resolved — not inferred by any subagent.

## Problem / Goal

EktosWhispr currently watches for meeting apps (Zoom, Teams, Webex, FaceTime) and for
"sustained" microphone activity, then proactively pops up a "Meeting Detected — want to
take notes?" notification (`docs/RECREATION_SPEC.md` §3.4, CLAUDE.md §16). The project
owner wants this proactive detection/notification behavior removed entirely.

This must **not** touch:
- The manual, user-initiated "start a meeting recording" flow (meeting hotkey / a
  deliberate click that begins recording and transcribing a meeting).
- "Note Recording" (recording audio while creating/editing a Personal Note), which
  shares 100% of its backend call path with manual meeting transcription
  (`src/stores/meetingRecordingStore.ts` → `meeting-transcription-start/-send/-stop`
  IPC, consumed from `src/components/notes/PersonalNotesView.tsx`).

## Requirements

- R1. Remove the two detection sources and their orchestration: process-based detection
  (`meetingProcessDetector.js`), microphone-activity detection (`audioActivityDetector.js`),
  and the shared process-list cache that exists only to serve them
  (`processListCache.js` — confirmed below to have no other consumers).
- R2. Remove the native/prebuilt mic-activity-listener binaries and their build/download
  tooling: `resources/windows-mic-listener.c`, `resources/macos-mic-listener.swift`,
  `scripts/build-macos-mic-listener.js`, `scripts/download-windows-mic-listener.js`, and
  the `.github/workflows/build-windows-mic-listener.yml` CI workflow. Remove all
  `package.json` script wiring that invokes them (`compile:mic-listener`,
  `download:windows-mic-listener`, and their references inside `compile:native` and
  `prebuild:win`). Remove the `"macos-mic-listener"` / `"windows-mic-listener*"` entries
  from `electron-builder.json`'s file list, and the two "Download windows-mic-listener.exe"
  CI steps in `.github/workflows/release.yml` and `.github/workflows/build-and-notarize.yml`.
- R3. Remove the "Meeting Detected" notification window/overlay end to end: the
  `?meeting-notification=true` renderer route, `MeetingNotificationOverlay.tsx`, and
  `MeetingNotificationCard.tsx` (verified to have no consumer other than the overlay and
  the already-dead onboarding preview removed in R5) — plus the main-process window
  plumbing that shows/dismisses it (`windowManager.js`: `showMeetingNotification`,
  `showNotificationWindow`, `dismissMeetingNotification`, `notificationWindow`,
  `_pendingNotificationData`, `_notificationTimeout`, `_notificationReadyFallback`) and
  its IPC surface (`meeting-notification-respond`, `get-meeting-notification-data`,
  `meeting-notification-ready`, `meeting-notification-data` push, `meeting-detected` push,
  `meeting-detected-start-recording` push — the latter already has zero renderer
  listeners today and is dead regardless).
- R4. Remove the meeting-detection preferences system: the `meetingDetectionEngine.js`
  preference/notification machinery (`preferences`, `setPreferences`, `getPreferences`,
  `_handleDetection`, `_showPrompt`, `handleNotificationResponse`'s detection-driven
  branch, `handleNotificationTimeout`, `_flushNotificationQueue`, `_notificationQueue`,
  `activeDetections`, `_userRecording`/`setUserRecording`, `_postRecordingCooldown`,
  `_bindListeners`, `start()`/`stop()` for the two detectors), the
  `meeting-detection-get-preferences` / `meeting-detection-set-preferences` IPC handlers,
  and the Settings UI toggle "Meeting Detection" under Settings → General →
  Notifications (`notifyMeetingDetection` end to end: `SettingsPage.tsx` toggle row,
  `settingsStore.ts` state/persisted-key/setter, `useSettings.ts`, the
  `sync-notification-preferences` handler's `notifyMeetingDetection`→`audioDetection`
  gating in `ipcHandlers.js`). Also remove the vestigial `meetingProcessDetection`
  setting (`settingsStore.ts`: persisted key, state field, default, setter, and its
  startup sync call `meetingDetectionSetPreferences({ processDetection: ... })`) — it
  has no UI control today (defaults to `false`, dead since the detector it enabled is
  being removed).
- R5. Remove the onboarding preview of this feature: `src/components/onboarding/MeetingSetupStep.tsx`
  (its only purpose is registering the manual meeting hotkey while previewing the
  now-removed `MeetingNotificationCard`) and the dead `"meeting"` onboarding step in
  `OnboardingFlow.tsx` (`showMeetingStep` — already hardcoded `false`, i.e. unreachable —
  its `steps` list entry, the `case "meeting":` render branch, the `meetingKey`/
  `setMeetingKey` destructuring that exists solely to feed that step). Do **not** touch
  `meetingKey`/`setMeetingKey` at their source (the shared settings hook) — they remain
  required by the still-active "Meeting Hotkey" control under Settings → General.
- R6. Preserve the manual meeting-recording feature completely: the `meeting` hotkey slot
  and its Settings UI (`SettingsPage.tsx` "Meeting Hotkey" section,
  `register-meeting-hotkey` IPC, `hyprlandShortcut`/`gnomeShortcut`/`kdeShortcut`
  `ToggleMeeting` bindings), `meetingDetectionEngine.js`'s manual-start method
  (`startManualMeeting` — by the time this spec executes, `joinCalendarMeeting()` no
  longer exists: it was removed, calendar-free, by
  `docs/specs/remove-dead-google-calendar-code.md`, which is sequenced to land first —
  see that spec's Design "Sequencing" section),
  `queueMeetingNoteNavigation`/`consumePendingMeetingNoteNavigation`,
  `snapControlPanelToMeetingMode`/`restoreControlPanelFromMeetingMode`, the entire
  "Meeting Transcription" IPC block in `ipcHandlers.js` (`meeting-transcription-prepare/
  -start/-send/-stop/-cancel`, diarization, speaker identification, AEC), and all of
  `meetingRecordingStore.ts`, `MeetingRecordingMount.tsx`, `MeetingRecordingPill.tsx`,
  `MeetingTranscriptChat.tsx`, `meetingEchoLeakDetector.js`, `meetingMicHoldback.js`,
  `meetingAecManager.js`, `meetingAudioStorage.js`.
- R7. Preserve Note Recording completely: no change to
  `src/components/notes/PersonalNotesView.tsx` or any IPC channel it depends on, since
  it consumes the same `meeting-transcription-*` channels preserved by R6.
- R8. Preserve system-audio capture used by manual/deliberate meeting recording — see
  the explicit finding below. `windows-system-audio-helper.c`/`.exe`
  (`windowsLoopbackAudioManager.js`) and macOS `AudioTapManager`
  (`audioTapManager.js`) are **not** part of the detection/notification system and must
  not be touched by this change.
- R9. Rename `src/helpers/meetingDetectionEngine.js` → `src/helpers/manualMeetingLauncher.js`
  (class `MeetingDetectionEngine` → `ManualMeetingLauncher`) once its body no longer does
  any detection, so the name doesn't mislead future readers. Update every reference:
  `main.js` (`require`, the `meetingDetectionEngine` local variable →
  `manualMeetingLauncher`, its constructor call — now taking only `windowManager` and
  `databaseManager`, since the two detector arguments no longer exist — the
  `windowManager.meetingDetectionEngine = ...` assignment → `windowManager.manualMeetingLauncher`,
  removal of the `meetingDetectionEngine.start()` boot call in `initializeDeferredManagers()`
  since there is nothing left to start, and removal of the `meetingDetectionEngine.stop()`
  call on quit since the narrowed class has no teardown state), `windowManager.js`
  (the `meetingDetectionEngine` property and its 3 `setUserRecording(...)` call sites in
  the dictation start/stop paths — these existed solely to gate/cooldown auto-detection
  and have no purpose once detection is gone, so delete the call sites, not just rename
  them), and `ipcHandlers.js` (`this.meetingDetectionEngine` → `this.manualMeetingLauncher`
  in the `managers` constructor destructure and in the `register-meeting-hotkey`/
  `meeting-notification-respond`-adjacent handlers that remain, i.e.
  `restore-from-meeting-mode`'s `setMeetingModeActive(false)` call).
- R10. Verify (do not assume) that `processListCache.js` has no consumers besides
  `meetingProcessDetector.js` and `audioActivityDetector.js` before deleting it — already
  verified during planning (see Design), re-verify at execution time in case of drift.
- R11. Update documentation to match: CLAUDE.md §16 ("Meeting Detection (Event-Driven)")
  rewritten to describe only what remains (manual meeting recording + Note Recording,
  system-audio capture, meeting hotkey), not deleted wholesale since parts of it describe
  surviving features; `docs/RECREATION_SPEC.md` §3.4 (rewrite to describe the narrowed
  `manualMeetingLauncher.js` and record the removal as history, similar to how §3.4.5
  already documents the prior Google Calendar removal) and its §0/§6 mentions of the
  now-deleted onboarding "meeting" step; `docs/guides/TROUBLESHOOTING.md` "Meeting
  Transcription Issues" section (remove the "meeting detection enabled in settings" /
  "auto-detection" / "meeting notification" language, keep manual-start troubleshooting);
  `docs/guides/DEBUG.md`'s "Meeting Detection" log-category row (rename/refold into
  whatever remains — the `"meeting"` debug category itself stays, since manual meeting
  transcription/AEC logging still uses it).
- R12. i18n: remove now-unused translation keys from all locale files
  (`src/locales/{lang}/translation.json` for all 9 supported languages) for the removed
  Settings toggle (`settingsPage.general.notifications.meetingDetection*`) and the
  removed onboarding step (`onboarding.steps.meeting`, `onboarding.meeting.*`). Do not
  remove keys still used by preserved features (e.g. `settingsPage.general.meetingHotkey.*`).

## Non-goals

- No changes to the manual meeting-recording feature's behavior, UI, or audio pipeline
  beyond the renames/call-site removals in R9 (which are mechanical, not behavioral).
- No changes to Note Recording.
- No changes to `windows-system-audio-helper` / `AudioTapManager` (system-audio capture
  for manual meeting recording) — see Design for why these are out of scope.
- Cleanup of the pre-existing dead Google Calendar code (`getActiveEvents()`,
  `getCalendarEventById()` in `database.js`, `joinCalendarMeeting()` in the launcher) is
  not this spec's job — that removal is `docs/specs/remove-dead-google-calendar-code.md`'s
  scope, and (per its recommended sequencing) lands *before* this spec, meaning
  `joinCalendarMeeting()`/`getActiveEvents()`/`getCalendarEventById()` are already gone
  from the codebase by the time this spec executes. This spec's own references to
  `meetingDetectionEngine.js`'s "manual-start methods" (R6, Design) reflect that
  already-narrowed shape (`startManualMeeting()` only) rather than the pre-cleanup one.
- No changes to `meetingAecManager.js`, `meetingEchoLeakDetector.js`,
  `meetingMicHoldback.js`, `meetingAudioStorage.js`, or any part of the "Meeting
  Transcription" IPC block in `ipcHandlers.js`.
- No change to the `meeting` hotkey slot's D-Bus method names (`ToggleMeeting`) in
  `gnomeShortcut.js`/`hyprlandShortcut.js`/`kdeShortcut.js` — these back the manual
  meeting hotkey, not detection.
- No renaming of the `"meeting"` debug-log category string used throughout the manual
  meeting-transcription/AEC code paths (only the CLAUDE.md/DEBUG.md *description* of
  that category changes, not the string itself, to avoid unnecessary code churn in
  preserved files).

## Finding: role of `windows-system-audio-helper`

Verified by reading the source: `windows-system-audio-helper.exe` is wrapped by
`src/helpers/windowsLoopbackAudioManager.js`, which is a WASAPI process-loopback
**system-audio capture** helper — it hears every application on every output device
(excluding EktosWhispr's own audio) and is consumed only by the manual meeting
transcription pipeline in `ipcHandlers.js` (the "Meeting Transcription" block, via
`getMeetingSystemAudioPlan()`/`getMeetingSystemAudioCapabilityMode()`) to capture what
other participants are saying once a meeting recording has actually started. It is a
completely different binary from `windows-mic-listener.exe`
(`src/helpers/audioActivityDetector.js`), which only monitors WASAPI session
start/stop events to *detect* that a mic is in use, for the auto-detection prompt. The
two share no code and are downloaded/compiled by different scripts
(`download-windows-system-audio-helper.js` vs. `download-windows-mic-listener.js`).
**Conclusion: `windows-system-audio-helper` plays no role in detection/notification and
must be preserved untouched (R8).** The macOS equivalent, `AudioTapManager`
(`audioTapManager.js`, Core Audio Process Tap, macOS 14.2+), is likewise
capture-only and preserved.

## Design

### Files removed entirely
- `src/helpers/meetingProcessDetector.js`
- `src/helpers/audioActivityDetector.js`
- `src/helpers/processListCache.js` (verified: only consumers are the two files above —
  re-check with a repo-wide search for `require(...processListCache...)` at execution
  time before deleting, per R10)
- `resources/windows-mic-listener.c`
- `resources/macos-mic-listener.swift`
- `scripts/build-macos-mic-listener.js`
- `scripts/download-windows-mic-listener.js`
- `.github/workflows/build-windows-mic-listener.yml`
- `src/components/MeetingNotificationOverlay.tsx`
- `src/components/MeetingNotificationCard.tsx`
- `src/components/onboarding/MeetingSetupStep.tsx`

### Files renamed
- `src/helpers/meetingDetectionEngine.js` → `src/helpers/manualMeetingLauncher.js`,
  class `MeetingDetectionEngine` → `ManualMeetingLauncher`. The narrowed class keeps
  only: constructor `(windowManager, databaseManager)` (drop the two detector
  parameters), `startManualMeeting()` (already calendar-free — its
  `getActiveEvents()`/`joinCalendarMeeting()` delegation was removed by
  `docs/specs/remove-dead-google-calendar-code.md`, sequenced to land first, so
  `joinCalendarMeeting()` itself no longer exists by the time this spec executes and is
  not something this spec's narrowed class needs to keep or delete),
  `setMeetingModeActive(active)`, `broadcastToWindows(channel, data)`, and the
  `handleNotificationResponse`/`handleNotificationTimeout`/detection-preference/queue
  machinery is deleted (it existed only to service the removed prompt). Confirm at
  execution time whether any remaining method still references
  `this.audioActivityDetector` (e.g. `_dismiss()`, `resetPrompt()` calls inside the old
  `"start"` action branch of `handleNotificationResponse` and inside
  `setMeetingModeActive`) — those calls must be deleted along with the rest of the
  detection-response branch, not left dangling on an undefined property.

### Files modified (non-exhaustive line references from planning; re-verify at execution
time since line numbers drift)
- `main.js`: remove `MeetingProcessDetector`/`AudioActivityDetector` requires and their
  two `new` calls; update the `ManualMeetingLauncher` require/constructor call and
  variable name per R9; remove the `meetingDetectionEngine.start()` call in
  `initializeDeferredManagers()`; remove the `meetingDetectionEngine.stop()` call in the
  quit handler (or replace with a no-op-safe equivalent only if the renamed class still
  holds cleanup state — it should not, per the Design above).
- `src/helpers/windowManager.js`: remove `showMeetingNotification`,
  `showNotificationWindow`, `dismissMeetingNotification`, and the
  `notificationWindow`/`_pendingNotificationData`/`_notificationTimeout`/
  `_notificationReadyFallback` fields (verify `NOTIFICATION_WINDOW_CONFIG` constant is
  still used by `showUpdateNotification` before deleting it — it is, per planning
  research, so keep the constant, delete only the meeting-specific methods/fields);
  remove the 3 `meetingDetectionEngine?.setUserRecording(...)` call sites in the
  dictation start/stop/toggle paths; remove the `notifyMeetingDetection: true` default
  in the notification-prefs object; rename the `meetingDetectionEngine` property to
  `manualMeetingLauncher` everywhere it's still referenced (`queueMeetingNoteNavigation`
  callers, etc. are unaffected since they don't touch this property).
- `src/helpers/ipcHandlers.js`: remove `meeting-detection-get-preferences`,
  `meeting-detection-set-preferences`, `meeting-notification-respond`,
  `get-meeting-notification-data`, `meeting-notification-ready` handlers; remove
  `notifyMeetingDetection` from `NOTIFICATION_PREF_KEYS` and the
  `audioDetection`-gating lines inside `sync-notification-preferences` (that handler
  keeps persisting the other notification prefs, it just stops calling
  `meetingDetectionEngine.setPreferences`); rename `this.meetingDetectionEngine` →
  `this.manualMeetingLauncher` in the constructor's managers destructure and its
  remaining use (`restore-from-meeting-mode` → `setMeetingModeActive(false)`).
- `preload.js` / `src/types/electron.ts`: remove `meetingDetectionGetPreferences`,
  `meetingDetectionSetPreferences`, `onMeetingDetected`,
  `onMeetingDetectedStartRecording`, `onMeetingNotificationData`,
  `getMeetingNotificationData`, `meetingNotificationReady`, `meetingNotificationRespond`.
  Keep `snapToMeetingMode`, `restoreFromMeetingMode`, `registerMeetingHotkey`,
  `getPendingMeetingNoteNavigation`, `onMeetingNoteNavigationPending`, all
  `meetingTranscription*`/`onMeetingTranscription*`/`onMeetingSpeaker*` entries, and
  `setMeetingSpeakerDiarizationEnabled`/`setMeetingSessionSpeakerConfig`.
- `src/AppRouter.jsx`: remove the `?meeting-notification=true` route and the
  `MeetingNotificationOverlay` import.
- `src/components/OnboardingFlow.tsx`: remove `MeetingSetupStep` import,
  `showMeetingStep` constant, the `"meeting"` entry pushed into `steps`, the
  `case "meeting":` render branch, and the `meetingKey`/`setMeetingKey` destructuring
  (leave the shared hook/store that provides them untouched — `SettingsPage.tsx` still
  needs them).
- `src/components/SettingsPage.tsx`: remove the "Meeting Detection" notification Toggle
  row (`settingsPage.general.notifications.meetingDetection*`) and its
  `notifyMeetingDetection` prop plumbing. Keep the entire "Meeting Hotkey" section
  untouched.
- `src/stores/settingsStore.ts`: remove `notifyMeetingDetection` and
  `meetingProcessDetection` — persisted-key list entries, `SettingsState` interface
  fields, default reads, setters (`setNotifyMeetingDetection`,
  `setMeetingProcessDetection`), and the two startup-sync blocks that call
  `meetingDetectionSetPreferences`/pass `notifyMeetingDetection` into
  `syncNotificationPreferences` (keep syncing `notificationsEnabled`,
  `notifyCalendarReminders`, `notifyUpdates`).
- `src/hooks/useSettings.ts`: remove the `notifyMeetingDetection` passthrough.
- `package.json`: remove `compile:mic-listener` and `download:windows-mic-listener`
  script definitions; remove their invocations from `compile:native` and
  `prebuild:win`. Do not touch `download:meeting-aec-helper` or
  `download:windows-system-audio-helper` (different, preserved features).
- `electron-builder.json`: remove the `"macos-mic-listener"` and
  `"windows-mic-listener*"` file-list entries.
- `.github/workflows/release.yml` and `.github/workflows/build-and-notarize.yml`:
  remove the "Download windows-mic-listener.exe" step from each.
- `src/locales/{en,es,fr,de,pt,it,ru,zh-CN,zh-TW}/translation.json`: remove the keys
  listed in R12 from all 9 files.

### Documentation updates (see Validation Plan for exact scope)
- `CLAUDE.md` §16: rewrite to document only the manual meeting-recording feature,
  Note Recording's shared backend, and system-audio capture; remove all
  detection/notification/preference description; rename any reference to
  `meetingDetectionEngine.js` to `manualMeetingLauncher.js`.
- `docs/RECREATION_SPEC.md` §3.4: rewrite `§3.4.1` to describe the narrowed
  `manualMeetingLauncher.js`; remove `§3.4.2`–`§3.4.4` (process detector, audio
  detector, process-list cache) and replace with a short note recording the removal
  (mirroring the style of the existing §3.4.5 Google Calendar removal note) so future
  readers know these subsystems existed and were intentionally removed, not merely
  never documented. Update §0 item 7 and §6's step list to reflect that the onboarding
  `"meeting"` step and `MeetingSetupStep.tsx` no longer exist in code (rather than
  "exists but disabled").
- `docs/guides/TROUBLESHOOTING.md`: update "Meeting Transcription Issues" to remove
  "meeting detection enabled in settings" / auto-detection / "meeting notification"
  guidance; keep guidance about manually starting a meeting recording and about
  system-audio capture fallback.
- `docs/guides/DEBUG.md`: update the log-category table row currently labeled "Meeting
  Detection" to reflect what's left (or remove the row if nothing distinct remains
  under that heading once detection-specific logging is gone — verify at execution
  time which debug log lines under the `"meeting"` category survive).

## Validation Plan

### Automated
- Add `test/helpers/manualMeetingLauncher.test.js` (new file), following the
  `require.cache[require.resolve("electron")] = { exports: { BrowserWindow: class {} } }`
  stubbing pattern already used in `test/helpers/hotkeySlotRollback.test.js`, to load
  `src/helpers/manualMeetingLauncher.js` outside Electron and assert:
  - Constructing `new ManualMeetingLauncher(windowManagerStub, databaseManagerStub)`
    (2-arg constructor, no detector arguments) succeeds.
  - `startManualMeeting()` with a `databaseManagerStub` whose `getActiveEvents()`
    returns `[]`: creates a note via `databaseManagerStub.saveNote(...)` with a
    generated "Meeting <date>" title, calls `windowManagerStub.queueMeetingNoteNavigation`
    with the correct `{ noteId, folderId, event, trigger: "hotkey" }` shape, and calls
    `broadcastToWindows("note-added", ...)`.
  - `startManualMeeting()` when `databaseManagerStub.saveNote()`/`getMeetingsFolder()`
    return falsy: does not throw, does not call `queueMeetingNoteNavigation`, and resets
    `_meetingModeActive` to `false` (assert via a follow-up call or an exposed getter/side
    effect — whatever the executor implements should be inspectable without reaching
    into private fields where avoidable).
  - The class has no `meetingProcessDetector`/`audioActivityDetector` properties or
    `setPreferences`/`getPreferences`/`handleNotificationResponse` methods (asserts the
    detection surface was actually removed, not just unused).
- Grep-based regression check (can be a `node --test` assertion or a documented manual
  step — executor's choice, but must run before marking the spec `Implemented`):
  confirm no remaining source file (outside `node_modules`) requires/imports any of the
  deleted files (`meetingProcessDetector`, `audioActivityDetector`, `processListCache`,
  `MeetingNotificationOverlay`, `MeetingNotificationCard`, `MeetingSetupStep`) and that
  `npm run lint` / `npm run typecheck` pass (this catches dangling imports/dead IPC
  types automatically).
- Confirm existing meeting-transcription-adjacent unit tests still pass unmodified:
  `test/helpers/meetingEchoLeakDetector.test.js`, `test/helpers/meetingMicHoldback.test.js`
  (these must not need any changes — if they do, that's a signal the refactor touched
  something in scope for R6/R7 and must be reverted to the minimal change).
- Run the full suite: `npm test` (must pass), `npm run lint`, `npm run typecheck`,
  `npm run build` (renderer) — per the mandatory `pr-reviewer` gate in CLAUDE.md.

### Manual
1. Launch the app in dev mode. Confirm no "Meeting Detected" notification ever appears
   regardless of running Zoom/Teams or talking with the mic on for an extended period.
2. Settings → General → Notifications: confirm the "Meeting Detection" toggle row is
   gone; remaining notification toggles (disable-all, calendar reminders if present,
   updates) still work.
3. Settings → General → Meeting Hotkey: confirm the hotkey field, layout mode
   (full-width/side-panel), and registration still work exactly as before (unaffected).
4. Press the configured meeting hotkey (or trigger it if unset — set one first): confirm
   a new note is created in the "Meetings" folder, the control panel navigates to it,
   and (if system audio permissions are granted) manual meeting transcription starts and
   produces a transcript with both mic and system-audio segments, using the same
   verification steps already documented in `docs/guides/TROUBLESHOOTING.md`'s "Meeting
   Transcription Issues"/"Meeting Audio Recording Not Appearing" sections.
5. Personal Notes → create/open a note → start Note Recording: confirm recording starts,
   produces a transcript, and the audio player appears in the Transcript tab afterward,
   exactly as before this change (uses the same `meeting-transcription-*` IPC preserved
   by R6/R7).
6. Onboarding: run through the first-run wizard end to end on a fresh profile; confirm
   there is no "meeting" step (there wasn't one visibly before either, since
   `showMeetingStep` was already `false` — this just confirms removing the dead code
   didn't break the surrounding steps' indices/navigation).
7. Windows only: confirm the packaged/dev build no longer bundles
   `windows-mic-listener.exe` but still bundles `windows-system-audio-helper.exe`
   (check `resources/bin/` after running the relevant `prebuild*`/`predev` script).
8. macOS only: confirm `macos-mic-listener` is no longer compiled by `compile:native`
   but the Process Tap system-audio helper (used by `AudioTapManager`) still is.

### Docs
- `CLAUDE.md` §16 rewritten per Design.
- `docs/RECREATION_SPEC.md` §3.4 (and its §0 item 7 / §6 cross-references) rewritten per
  Design.
- `docs/guides/TROUBLESHOOTING.md` "Meeting Transcription Issues" section updated per
  Design.
- `docs/guides/DEBUG.md` log-category table updated per Design.

## Resolved Decisions (formerly Open Questions)

- The `"meeting"` debug-log category is **left as-is** — still an accurate umbrella term
  for the surviving manual-recording pipeline; renaming would be churn without benefit.
- `joinCalendarMeeting()`/`getActiveEvents()`/`getCalendarEventById()` (pre-existing dead
  calendar code, Non-goals) are **not folded into this change** — their removal is
  `docs/specs/remove-dead-google-calendar-code.md`'s scope, sequenced to land *before*
  this spec. By the time this spec executes, those three functions no longer exist in
  the codebase; this spec's own text (R6, Design "Files renamed") has been updated to
  match that already-narrowed shape rather than describing them as still-present dead
  code to work around.
- `docs/guides/DEBUG.md`'s "Meeting Detection" table row is **deleted outright** (not
  repurposed as a historical note) once execution reveals exactly which debug log lines
  under the `"meeting"` category survive the removal.
