# Remove Dead Google Calendar Remnants

## Status
Implemented

Approved by the project owner in conversation, after resolving both Open Questions
(amend the sibling spec now; remove the entire orphaned `integrations.*` pt-locale
block, not just `sections.calendar`).

Implemented per this spec's Design section. Validation Plan executed in full:
`test/helpers/meetingDetectionEngine.test.js` and
`test/helpers/databaseCalendarMigration.test.js` added and passing; grep-based
regression check confirms no remaining references to the removed methods/keys;
`npm test`, `npm run lint`, `npm run typecheck`, and `npm run build:renderer` all
pass (the one pre-existing `extractArchive.test.js` failure is unrelated — a
zip/tar-tooling quirk in this Windows environment, reproducible on the
pre-change baseline); `meetingEchoLeakDetector.test.js`, `meetingMicHoldback.test.js`,
and `snippetsDatabase.test.js` pass unmodified. `docs/RECREATION_SPEC.md` updated
per R6.

## Problem / Goal

Google Calendar integration (OAuth, calendar sync, `googleCalendarManager.js`/
`googleCalendarOAuth.js`) was already removed from EktosWhispr in a prior change
(`docs/RECREATION_SPEC.md` §0.6/§3.4.5). CLAUDE.md's Meeting Detection section already
states the removal as fact. However, several remnants of that removal were left behind
and never cleaned up — they were surfaced as a side-discovery while planning
`docs/specs/remove-meeting-auto-detection.md` (an Approved-but-not-yet-implemented
spec; see its Non-goals, ~lines 139-144, and Resolved Decisions, ~lines 370-372, which
explicitly defer this cleanup to "a separate spec if desired").

The remnants fall into three independent piles, all confirmed by direct source
inspection (not assumption):

1. **Functionally-inert-but-reachable code** in `src/helpers/meetingDetectionEngine.js`:
   `startManualMeeting()` calls `this.databaseManager.getActiveEvents()` and, if
   non-empty, delegates to `joinCalendarMeeting(activeEvents[0].id, "hotkey")`;
   `handleNotificationResponse()`'s `"start"` action branch computes `isRealEvent` and,
   if true, calls `this.databaseManager.getCalendarEventById(...)`. Both call sites are
   reachable today (the manual meeting hotkey at `main.js:497`/`main.js:949`, and the
   `meeting-notification-respond` IPC handler in `ipcHandlers.js`), but neither can ever
   do anything useful: `getActiveEvents()` always returns `[]` (nothing populates
   `calendar_events` since sync was removed), and `isRealEvent` is always `false` (the
   only two `calendar_id` values ever written today are the literals `"__detected__"`
   and `"__manual__"`, both of which `isRealEvent`'s check explicitly excludes) — so
   `getCalendarEventById()` is called from `handleNotificationResponse()` in a branch
   that can never execute with a truthy condition. `joinCalendarMeeting()` itself is
   reachable only from the now-always-false `getActiveEvents()` check, i.e. it too is
   permanently dead in practice while remaining technically callable.
2. **Fully dead code with zero callers anywhere in `src/`** (verified via repo-wide
   grep, not just within `database.js`): in `src/helpers/database.js`, `saveGoogleTokens`,
   `getGoogleTokens`, `getGoogleTokensByEmail`, `getAllGoogleTokens`, `getGoogleAccounts`,
   `removeGoogleAccount`, `deleteGoogleTokens`, `saveGoogleCalendars`,
   `applyPrimaryOnlyToSelection`, `getGoogleCalendars`, `updateCalendarSelection`,
   `getSelectedCalendars`, `upsertCalendarEvents`, `getUpcomingEvents`,
   `getNoteByCalendarEventId`, `clearCalendarData`, `updateCalendarSyncToken`,
   `removeCalendarEvents`, `removeEventsFromDeselectedCalendars` — none of these has any
   caller outside `database.js` itself, and none is used by `meetingDetectionEngine.js`
   either. This is a larger surface than initially scoped (18 methods, not just the 5
   named in the original side-discovery) — confirmed by re-grepping `src/` for every
   method name individually.
3. **Orphaned prompt/UI/i18n strings**, unrelated to the two piles above: `get_calendar_events`
   appears as a tool-description string in `src/config/prompts.ts`'s `TOOL_INSTRUCTIONS`
   map and as an icon-mapping key in `src/components/chat/toolIcons.ts`, but there is no
   tool implementation, schema, or registration anywhere named `get_calendar_events` /
   `getCalendarEventsTool` / `GetCalendarEvents` (confirmed by grep — only prompt/icon/
   locale hits). Since `getAgentSystemPrompt()`'s `availableTools` array is only ever
   populated from the real registered-tool list (see Design), this string can never be
   surfaced to a model. Additionally, `src/locales/pt/translation.json` has an entire
   `integrations.googleCalendar.*` block (16 keys) that does not exist in
   `en/translation.json` or any other locale — a stray leftover unique to the Portuguese
   file from the original removal — plus `chat.tools.get_calendar_eventsStatus` /
   `chat.tools.calendarEvents` / `chat.tools.calendarEvents_plural` keys that exist in
   only `en` and `pt` (not the other 7 locales), also unreferenced by any code.

None of this is reachable by users in a way that produces incorrect behavior today —
`startManualMeeting()` already always falls through to creating a fresh manual meeting
note, exactly as if this code didn't exist, because the calendar branch's precondition
is permanently false. This is pure dead-code removal with no behavior change, but it
adds maintenance surface, three unnecessary tables/queries created on every app boot,
and functions future readers might mistake for live functionality.

## Requirements

- R1. In `src/helpers/meetingDetectionEngine.js` (current file name/class — see Design
  for why this spec targets the pre-rename file):
  - Rewrite `startManualMeeting()` to remove the `getActiveEvents()` check and the
    `joinCalendarMeeting(...)` delegation; the method should unconditionally run the
    "create a fresh manual meeting note" logic that already exists further down in the
    method body (behavior is unchanged, since that's the only path ever taken today).
  - Delete `joinCalendarMeeting(eventId, trigger)` entirely (its only caller is the
    branch just removed from `startManualMeeting()`, and grep confirms no other caller
    exists).
  - In `handleNotificationResponse()`'s `"start"` action branch, delete the `isRealEvent`
    computation and its `if (isRealEvent) { ... getCalendarEventById ... }` block
    entirely (dead — `isRealEvent` is always `false`, see Problem/Goal). Everything else
    in `handleNotificationResponse()` (the `saveNote`/`getMeetingsFolder`/
    `queueMeetingNoteNavigation`/`"dismiss"` logic) is untouched — this spec does not
    remove the method itself; that's `remove-meeting-auto-detection`'s job.
- R2. In `src/helpers/database.js`:
  - Remove the 18 dead methods listed in Problem/Goal pile 2, plus `getActiveEvents()`
    and `getCalendarEventById()` (now uncalled after R1).
  - Remove the 3 `CREATE TABLE IF NOT EXISTS` blocks (`google_calendar_tokens`,
    `google_calendars`, `calendar_events`) and their associated `ALTER TABLE` migration
    blocks (`google_calendars.account_email`, `google_calendars.is_primary`,
    `calendar_events.attendees`) and the `idx_google_calendar_tokens_email` unique-index
    migration block from `initDatabase()`.
  - Add a migration step (see Design) that drops the 3 tables for existing installs.
  - Do **not** touch `notes.calendar_event_id` or `notes.participants` columns, their
    `ALTER TABLE notes ADD COLUMN` migration blocks, or `upsertNoteFromCloud()` /
    `getNoteByClientId()` / `markNoteSynced()` / cloud note-sync methods — these belong
    to EktosWhispr's own (separate, unrelated) note cloud-sync feature and remain fully
    in use (confirmed via grep: `participants` is read by
    `src/utils/participants.ts`, `src/components/notes/NoteParticipants.tsx`,
    `PersonalNotesView.tsx`, `NoteEditor.tsx`, `MeetingTranscriptChat.tsx`).
  - Do **not** touch `getMeetingsFolder()`, `saveNote()`, `updateNote()`, or any other
    non-calendar method `meetingDetectionEngine.js` calls.
- R3. In `src/helpers/ipcHandlers.js` / `main.js` / `windowManager.js`: no changes are
  required by R1/R2 beyond what's already covered — `meeting-detection-get-preferences`,
  `meeting-detection-set-preferences`, `meeting-notification-respond`, and the rest of
  the notification/preference IPC surface are untouched by this spec (that's
  `remove-meeting-auto-detection`'s scope). Verify at execution time that no other file
  calls any of the removed `database.js` methods or `joinCalendarMeeting` (grep check —
  see Validation Plan) before finalizing the diff.
- R4. Remove the orphaned prompt/UI remnants (Problem/Goal pile 3):
  - `src/config/prompts.ts`: remove the `get_calendar_events` entry from
    `TOOL_INSTRUCTIONS`.
  - `src/components/chat/toolIcons.ts`: remove the `get_calendar_events: Calendar` entry
    (and the now-unused `Calendar` import from `lucide-react` if nothing else in the
    file still uses it — verify at execution time).
  - `src/locales/en/translation.json` and `src/locales/pt/translation.json`: remove
    `chat.tools.get_calendar_eventsStatus`, `chat.tools.calendarEvents`,
    `chat.tools.calendarEvents_plural` (present in exactly these two locales — verify at
    execution time that no other locale gained these keys since planning).
  - `src/locales/pt/translation.json` only: remove the **entire top-level `integrations`
    key** in one step — every sub-key under it (`title`, `description`, `googleCalendar.*`
    [15 keys], `sections.{calendar,api,mcp,cli}`, `api.*`, `mcp.*`, `cli.*` [including its
    nested `local`/`cloud` objects], `plan.*`, `notABot.*`) — not just the
    `googleCalendar`/`sections.calendar` subset identified in an earlier pass. Confirmed
    by grep (repo-wide, `src/**/*.{ts,tsx,js,jsx}` for code, all 9
    `src/locales/*/translation.json` for locale data) that the entire top-level
    `integrations` object exists in **only** `src/locales/pt/translation.json` — no other
    locale file has an `integrations` key at all — and no code file anywhere in `src/`
    references `integrations` as a bare identifier, a dotted i18n key path (`integrations.
    anything`), or via a `t("integrations...")` call; there is also no Settings →
    Integrations component in the current codebase (`grep -r Integrations src` finds
    nothing) to render any of it. This supersedes the prior narrower instruction (remove
    only `googleCalendar` + `sections.calendar`, leaving `sections.api`/`mcp`/`cli` and the
    rest of the block in place) per final user scope decision: since the whole block is
    confirmed dead by the same evidence that justified the narrower removal, there is no
    reason to leave siblings behind as a "future cleanup" — remove the whole `integrations`
    key now, in this spec, in one step.
- R5. Migration safety (CLAUDE.md Non-Negotiable Premise #6): ship a migration that
  drops the 3 Google Calendar tables for existing user databases, per the Design
  section's reasoning about why this satisfies the premise's spirit despite being a
  destructive schema change.
- R6. Update documentation to record the completed removal: `docs/RECREATION_SPEC.md`
  §0.6, §3.4.5, and the passages at (approximately) §701/§769/§1043 that currently say
  "schema preserved... but nothing populates" and "tem instrução/ícone mas não há tool
  registrada" must be rewritten to state these remnants are now actually gone (mirroring
  how §3.4.5 already documents the OAuth/sync removal as history — extend that same
  paragraph rather than replacing it, since the initial removal and this cleanup are
  two chapters of the same story).

## Non-goals

- Removing `handleNotificationResponse()`, `_handleDetection`, `_showPrompt`,
  `setPreferences`/`getPreferences`, the notification queue/cooldown machinery, or any
  other part of the auto-detection/notification system — that is
  `docs/specs/remove-meeting-auto-detection.md`'s scope (R4 there), not this spec's.
  This spec only removes the `isRealEvent`/`getCalendarEventById` sub-block inside
  `handleNotificationResponse()`, nothing else in that method.
- Renaming `meetingDetectionEngine.js` to `manualMeetingLauncher.js` or the class to
  `ManualMeetingLauncher` — that rename is `remove-meeting-auto-detection`'s R9. This
  spec keeps the current file name and class name throughout (see Design for the
  sequencing rationale).
- Any change to `notes.calendar_event_id`, `notes.participants` (columns or the methods
  that read/write them for cloud note sync), `getMeetingsFolder()`, `saveNote()`,
  `updateNote()`, or any other non-calendar-specific method touched incidentally by
  `meetingDetectionEngine.js`.
- Any change to the `meeting` hotkey slot, manual meeting recording, Note Recording, or
  system-audio capture (`windows-system-audio-helper`/`AudioTapManager`) — untouched by
  this spec, same as the sibling spec's Non-goals state.
- Adding a first-party Google Calendar (or any calendar) integration back. This is
  strictly a removal of stale remnants of a feature that no longer exists.
- Backfilling the removed `chat.tools.get_calendar_eventsStatus`/`calendarEvents*` keys
  into the 7 locales that never had them (es, fr, de, it, ru, zh-CN, zh-TW) — they were
  never there, so there's nothing to remove from them, and adding them just to delete
  them serves no purpose.

## Design

### Sequencing relative to `remove-meeting-auto-detection.md`

**This spec should be implemented before `remove-meeting-auto-detection.md`.** Reasons:

- `remove-meeting-auto-detection.md`'s Design section explicitly targets
  `src/helpers/meetingDetectionEngine.js` (pre-rename) and its Non-goals explicitly defer
  this calendar cleanup, so there's no requirement that it land first.
- If this spec lands first, `remove-meeting-auto-detection`'s executor will encounter a
  `meetingDetectionEngine.js` where `startManualMeeting()` no longer branches into
  `joinCalendarMeeting()` and where `joinCalendarMeeting()` no longer exists at all.
  **Resolved**: `docs/specs/remove-meeting-auto-detection.md` (Approved) has already been
  amended to reflect this — its Non-goals, R6, Design "Files renamed", and Resolved
  Decisions sections no longer say the narrowed `ManualMeetingLauncher` class "keeps...
  `joinCalendarMeeting()`"; they now state that method (along with `getActiveEvents()`/
  `getCalendarEventById()`) is already gone by the time that spec executes, sequenced
  after this one, and that its narrowed class keeps only `startManualMeeting()` (already
  calendar-free). No further action is needed on that spec's text — whoever executes it
  next will find it already consistent with this spec landing first.
  - Similarly, that spec's `handleNotificationResponse` deletion (its R4) subsumes the
    smaller `isRealEvent` deletion this spec makes — no conflict, just a strict subset.
- If instead `remove-meeting-auto-detection` lands first (order flipped from this
  recommendation), this spec's executor must adjust: operate on
  `src/helpers/manualMeetingLauncher.js` / class `ManualMeetingLauncher` instead of
  `meetingDetectionEngine.js` / `MeetingDetectionEngine`, and skip R1's
  `handleNotificationResponse()` edit entirely (that method — and the whole
  detection-response surface — will already be gone). R2 (database.js) and R4
  (prompts/UI/i18n) are unaffected either way, since neither spec touches those areas.

### `src/helpers/meetingDetectionEngine.js` changes (R1)

- `startManualMeeting()`: delete the `const activeEvents = this.databaseManager.getActiveEvents(); if (activeEvents?.length > 0) { return this.joinCalendarMeeting(...); }` block at the top of the method. The remainder of the method (setting `_meetingModeActive`, building the `"__manual__"` event object, `saveNote`/`getMeetingsFolder`, error handling, `broadcastToWindows`, `queueMeetingNoteNavigation`) is unchanged — this is exactly the code path already taken on every real invocation today.
- Delete `joinCalendarMeeting(eventId, trigger)` in its entirety.
- `handleNotificationResponse()`: inside the `"start"` branch, delete the `isRealEvent` computation and its guarded `getCalendarEventById`/`updates.participants`/`updateNote` block. The `"start"` branch continues to: create the note, set `_meetingModeActive`, broadcast `"note-added"`, call `queueMeetingNoteNavigation`, and call `this.audioActivityDetector.resetPrompt()` — all unchanged. The `"dismiss"` branch and the `finally`/`catch` blocks are unchanged.
- No constructor signature change, no changes to `_handleDetection`/`_showPrompt`/preferences/queue machinery — out of scope per Non-goals.

### `src/helpers/database.js` changes (R2)

Removed methods (18 fully-dead + 2 now-uncalled after R1 = 20 total):
`saveGoogleTokens`, `getGoogleTokens`, `getGoogleTokensByEmail`, `getAllGoogleTokens`,
`getGoogleAccounts`, `removeGoogleAccount`, `deleteGoogleTokens`, `saveGoogleCalendars`,
`applyPrimaryOnlyToSelection`, `getGoogleCalendars`, `updateCalendarSelection`,
`getSelectedCalendars`, `upsertCalendarEvents`, `getUpcomingEvents`,
`getNoteByCalendarEventId`, `clearCalendarData`, `updateCalendarSyncToken`,
`removeCalendarEvents`, `removeEventsFromDeselectedCalendars`, `getActiveEvents`,
`getCalendarEventById`.

Removed schema blocks inside `initDatabase()`:
- The three `CREATE TABLE IF NOT EXISTS` statements for `google_calendar_tokens`,
  `google_calendars`, `calendar_events`.
- The `idx_google_calendar_tokens_email` unique-index migration try/catch block.
- The two `ALTER TABLE google_calendars ADD COLUMN ...` blocks (`account_email`,
  `is_primary`).
- The `ALTER TABLE calendar_events ADD COLUMN attendees TEXT` block.
- Leave `ALTER TABLE notes ADD COLUMN transcript TEXT`, `ALTER TABLE notes ADD COLUMN
  calendar_event_id TEXT`, and `ALTER TABLE notes ADD COLUMN participants TEXT`
  completely untouched (they belong to the notes schema, not the calendar tables, and
  `calendar_event_id`/`participants` remain live columns per R2's Non-goals).

### Migration approach for the 3 dropped tables (R5 — Premise #6 reasoning)

`database.js` has no versioned migration runner (no `PRAGMA user_version`, no
migration-number table) — every schema change is applied via idempotent,
run-on-every-boot statements: `CREATE TABLE IF NOT EXISTS` for new tables, and
`ALTER TABLE ... ADD COLUMN` wrapped in a try/catch that swallows the
"duplicate column" error for column additions. This spec follows that exact existing
pattern rather than inventing a new migration mechanism: add three
`this.db.exec("DROP TABLE IF EXISTS <name>")` statements (`google_calendar_tokens`,
`google_calendars`, `calendar_events`) inside `initDatabase()`, in the same place the
`CREATE TABLE` statements used to be. `DROP TABLE IF EXISTS` is naturally idempotent —
it drops the table (and its indexes/data) the first time this code runs against an
existing database that still has it, and is a harmless no-op on every subsequent boot
and for brand-new installs that never had the table. This requires no version tracking
because the operation is safe to repeat forever.

**Why dropping (not preserving/exporting) satisfies Premise #6's spirit**: Premise #6
requires that a schema change not "silently reset or drop" user data — existing user
data must "survive the upgrade untouched or be transformed forward." The data in these
3 tables fails to qualify as data this premise is protecting, for reasons specific to
each table:

- `google_calendar_tokens` holds OAuth access/refresh tokens for a Google Calendar
  integration that was already ripped out of the app in a prior release. No UI, IPC
  handler, or code path anywhere in the current codebase can read, display, refresh, or
  otherwise use these tokens — they are already unreachable dead weight before this
  spec, and (being access/refresh tokens for an integration whose consent/callback flow
  no longer exists in-app) are functionally worthless credentials regardless. There is
  nothing to "transform forward" because there is no live feature to transform them
  into.
- `google_calendars` holds cached calendar names/colors — pure metadata mirrored from
  Google's API, not authored or owned by EktosWhispr; the authoritative copy lives at
  Google, unaffected by dropping this local cache.
- `calendar_events` holds cached event data (summaries/times/attendees) mirrored from
  Google Calendar via a sync path that no longer exists. Same reasoning: it's a stale
  cache/mirror of externally-authoritative data, not the user's own content created
  inside EktosWhispr (unlike notes, the custom dictionary, or meeting recordings/audio,
  which Premise #7 explicitly protects as "operational data" because EktosWhispr is
  their only home). Google Calendar remains the source of truth for a user's actual
  calendar; nothing here is lost from the user's perspective.

This reasoning is why (a) — an outright `DROP TABLE IF EXISTS` migration — is the
correct choice, not (b) a more conservative approach (e.g. archiving rows to a JSON
export in `userData` before dropping, or gating removal behind a settings flag). A
conservative export was considered and rejected: since literally no code path reads this
data today (confirmed — zero callers beyond the methods this spec deletes) and it was
already unreachable before this change, exporting it would produce a file no feature
ever reads either, adding cost (implementation, test surface, disk I/O) with no
corresponding user benefit. This is explicitly *not* a precedent for future schema
drops of live/operational data (e.g. notes, dictionary, meeting audio) — those must
follow `postMigrationDetector.js`'s pattern of a real forward-migration or explicit
user-facing preservation, per Premise #6/#7. The distinguishing fact here is that the
*feature that wrote this data* was already deleted in a prior, separate change, and nothing
downstream can act on the data's presence or absence.

### `src/config/prompts.ts` / `toolIcons.ts` / locale changes (R4)

`getAgentSystemPrompt(availableTools, noteContext)` only emits a tool's description line
when its name appears in the `availableTools` array passed by the caller
(`src/components/chat/useChatStreaming.ts:147`), which is built from the actual
registered tool list, not from `TOOL_INSTRUCTIONS`'s keys — so `get_calendar_events`
already can never be surfaced to the model; removing the map entry changes nothing
observable, it just removes a stale placeholder. Same reasoning for `toolIcons.ts`: a
tool name is only looked up in that map when a tool call with that name actually occurs
in a chat transcript, which can never happen since no such tool exists.

For the locale keys: `chat.tools.get_calendar_eventsStatus`,
`chat.tools.calendarEvents`, `chat.tools.calendarEvents_plural` are read dynamically
(via a `` `chat.tools.${toolName}Status` ``-style key built from the tool name at
render time — verify the exact template at execution time), never as a literal string
in code, so grepping for the literal key names in `.ts`/`.tsx` finds nothing (confirmed)
— they are only ever reachable if a `get_calendar_events` tool call actually streamed
back from a model, which cannot happen. Removing them is purely a cleanup of translation
files with zero runtime effect.

For the top-level `integrations` key: repo-wide grep (`src/**/*.{ts,tsx,js,jsx}` for code,
all 9 `src/locales/*/translation.json` for locale data) confirms the entire object —
`title`, `description`, `googleCalendar.*` (15 keys: `title`, `optional`, `description`,
`connect`, `connecting`, `connected`, `addAnother`, `primaryOnly`,
`primaryOnlyDescription`, `disconnect`, `disconnectConfirm`, `disconnectDescription`,
`systemAudioRequired`, `systemAudioDescription`, `openSettings`), `sections.{calendar,api,
mcp,cli}`, `api.*` (`title`, `description`, `proRequired`, `manage`, `viewPlans`,
`dialogTitle`), `mcp.*` (`title`, `description`, `step1`, `step2`, `step3`, `learnMore`,
`viewPlans`, `copyUrl`, `proRequired`, `copied`), `cli.*` (`title`, `description`,
`installLabel`, `learnMore`, `copyDocsLink`, `docsLinkCopied`, `viewPlans`, plus nested
`local.{label,freeBadge,description}` and `cloud.{label,description,proRequired}`),
`plan.*` (`title`, `current`, `free`, `freeLimit`, `essential`, `essentialLimit`, `pro`,
`proLimit`, `upgrade`), and `notABot.*` (`title`, `description`) — exists in only
`src/locales/pt/translation.json` (block spans lines 2635-2715 in that file as of
planning); no other locale defines an `integrations` key at all. No code anywhere
references `integrations` as a bare identifier or any dotted `integrations.*` i18n key
path, and there is no Settings → Integrations component in the current codebase
(`grep -r Integrations src` finds nothing) — this is a leftover from whatever pre-removal
Settings layout hosted the Google Calendar connect UI, API keys, MCP, and CLI sections
together under one "Integrations" heading.

**Final scope decision (supersedes the earlier narrower pass):** an earlier pass of this
spec removed only `integrations.googleCalendar` and `integrations.sections.calendar`,
leaving `sections.api`/`mcp`/`cli` and the rest of the block (`api`, `mcp`, `cli`, `plan`,
`notABot`) as a documented "future cleanup, out of scope" note — reasoning that only the
calendar-related sub-keys were confirmed in scope of the then-open question. That
reasoning is now superseded: the same grep that confirmed `sections.calendar` was dead
was re-run against every remaining key in the block (`title`, `description`, `sections.
{api,mcp,cli}`, `api.*`, `mcp.*`, `cli.*`, `plan.*`, `notABot.*`) and found zero code
references for any of them either — there is no partial-orphan story here, the entire
top-level `integrations` object is unreferenced dead JSON. Per final user direction,
this spec now removes the entire top-level `integrations` key from
`src/locales/pt/translation.json` in one step, rather than leaving a known-dead sibling
block behind under a "future cleanup" label. Note that the immediately-following sibling
keys `calendar` (`"Google Agenda"` UI strings) and `upcoming` (`"Próximas reuniões"` UI
strings) that appear right after `integrations` in the file are separate top-level keys,
not part of the `integrations` object, and are **not** touched by this change (out of
scope — not confirmed dead, not part of this spec's investigation).

## Validation Plan

### Automated

- **New file**: `test/helpers/meetingDetectionEngine.test.js`, using the same
  `require.cache[require.resolve("electron")] = { exports: { BrowserWindow: class {} } }`
  electron-stub pattern already used in `test/helpers/hotkeySlotRollback.test.js`, to
  load `src/helpers/meetingDetectionEngine.js` outside Electron. Assert:
  - `startManualMeeting()` with a `databaseManagerStub` whose `saveNote()`/
    `getMeetingsFolder()` return valid data: creates a note, calls
    `windowManagerStub.queueMeetingNoteNavigation` with `trigger: "hotkey"`, and calls
    `broadcastToWindows("note-added", ...)` — **and** that `databaseManagerStub` does
    **not** have `getActiveEvents` invoked with a truthy-length return causing any
    delegation (assert by making the stub's `getActiveEvents` throw if called, or by
    omitting it entirely and asserting no `TypeError`/no such property access occurs —
    proves the branch was actually deleted, not just made unreachable via stub data).
  - The class instance has no `joinCalendarMeeting` method
    (`assert.equal(typeof instance.joinCalendarMeeting, "undefined")`).
  - `handleNotificationResponse(detectionId, "start")`, given a stubbed
    `activeDetections` entry whose `event.calendar_id` is a value that would have made
    the old `isRealEvent` check true (e.g. `"real-cal-id-123"`), does **not** call
    `databaseManagerStub.getCalendarEventById` (assert by making that stub method throw
    if invoked) and still completes the note-creation/navigation flow normally.
  - This test file replaces/supersedes the sibling spec's planned
    `test/helpers/manualMeetingLauncher.test.js` only in the sense that whichever spec
    executes first should name its test file to match whichever file/class exists at
    that time; if this spec runs first (the recommended order), this new test targets
    `meetingDetectionEngine.js`/`MeetingDetectionEngine` and the later
    `remove-meeting-auto-detection` executor should adapt/rename it (or add a new file)
    to match its own rename rather than deleting this test's coverage.
- **New file**: `test/helpers/databaseCalendarMigration.test.js`, using the same
  electron-stub + temp-`userData`-dir pattern as `test/helpers/snippetsDatabase.test.js`
  (stub `Module._load` for `"electron"` to return `{ app: { getPath, getAppPath,
  isReady } }` pointed at a fresh `fs.mkdtempSync` directory, skip via `t.skip(...)` if
  the `better-sqlite3` native binding is unavailable for the current Node runtime, same
  as that file does). Assert:
  - **Pre-migration setup**: open the same SQLite file path `DatabaseManager` will use
    directly via `better-sqlite3` (before constructing `DatabaseManager`), manually
    `CREATE TABLE` the 3 legacy tables with the old schema and insert one row into each
    (a fake OAuth token row, a fake calendar row, a fake event row), then close that
    handle.
  - Construct `new DatabaseManager()` (this runs `initDatabase()`, including the new
    `DROP TABLE IF EXISTS` statements) and assert all 3 tables no longer exist
    afterward (e.g. querying `sqlite_master` for each table name returns no row).
  - Assert the migration is idempotent: close and re-construct a second
    `DatabaseManager()` against the same file — no error thrown, tables still absent.
  - Assert unrelated tables/columns survive untouched: create a note via
    `dbManager.saveNote(...)`, confirm it round-trips, and confirm the `notes` table
    still has usable `calendar_event_id`/`participants` columns (e.g.
    `dbManager.updateNote(id, { participants: "[]" })` succeeds without error) —
    proving R2's Non-goals boundary (don't touch the notes-table calendar columns) held.
  - Assert none of the 20 removed method names exist on `DatabaseManager.prototype`
    (loop over the list from Design and assert
    `typeof DatabaseManager.prototype.<name> === "undefined"` for each) — proves removal
    actually happened, not just that callers were removed.
- **Grep-based regression check** (documented as a `node --test` assertion, or a
  manual step run by the executor before marking `Implemented` — executor's choice,
  consistent with how the sibling spec handled its own grep check): confirm no file
  under `src/` (outside `node_modules`) references any of the 20 removed `database.js`
  method names, `joinCalendarMeeting`, `get_calendar_events` (as a `TOOL_INSTRUCTIONS`/
  `toolIcons` key), or the removed locale keys. For `src/locales/pt/translation.json`
  specifically, assert the **entire top-level `integrations` key is absent** (e.g.
  `JSON.parse(readFileSync(...))` and assert `parsed.integrations === undefined`, or a
  grep for `"integrations"` in that file returning no match) — not a check of individual
  sub-keys like `sections.api`/`mcp`/`cli`, since none of the block survives this spec.
  Also assert the sibling top-level `calendar` and `upcoming` keys in the same file are
  still present and unchanged (they are separate keys, not part of `integrations`, and
  are out of scope for this spec).
- Run the full suite: `npm test` (must pass, including the two new files above),
  `npm run lint`, `npm run typecheck`, `npm run build` (renderer) — per the mandatory
  `pr-reviewer` gate in CLAUDE.md. In particular, typecheck must confirm removing the
  `Calendar` import from `toolIcons.ts` (if unused after the key removal) doesn't leave
  a lint error, and that no `.ts`/`.tsx` file still imports/references anything deleted.
- Existing tests that must continue passing unmodified:
  `test/helpers/meetingEchoLeakDetector.test.js`, `test/helpers/meetingMicHoldback.test.js`,
  `test/helpers/snippetsDatabase.test.js` (if this one exercises any calendar-adjacent
  path incidentally, verify it doesn't — it shouldn't, since it targets dictionary/
  snippets tables).

### Manual

1. Fresh profile: launch the app, confirm it starts normally (no errors in debug logs
   related to `google_calendar`/`calendar_events` table creation).
2. Press the configured meeting hotkey: confirm a new note is created in the "Meetings"
   folder titled `Meeting <date> <time>` and the control panel navigates to it — same
   behavior as before this change (this is the only path `startManualMeeting()` ever
   took anyway).
3. Existing-install profile with pre-existing `google_calendar_tokens`/
   `google_calendars`/`calendar_events` rows (simulate by copying a database file that
   predates this change, or by manually inserting rows via `sqlite3` CLI against a dev
   profile's `ektoswhispr.db` before launching the updated app): launch the app once,
   then inspect the database file afterward (e.g. `sqlite3 ektoswhispr.db ".tables"`) to
   confirm the 3 tables are gone and the app started without error.
4. Open the AI chat agent, ask something unrelated to calendars, confirm no
   `get_calendar_events`-related tool call or icon ever appears (expected — there was
   never a real tool to call).
5. Switch UI language to Portuguese, browse Settings → Integrations (if such a section
   still renders in the running build): confirm no dangling "Google Calendar" text
   appears anywhere that used to be sourced from the removed `integrations.googleCalendar`
   keys.

### Docs

- `docs/RECREATION_SPEC.md` §0.6, §3.4.5, and the passages near §701 (`imminentEvent`
  hardcoded null note), §769 (calendar table schema-preserved note), and §1043
  (`get_calendar_events` "não há tool registrada" note) updated to state the remnants
  described in Problem/Goal are now removed, extending (not replacing) the existing
  historical note about the original Google Calendar removal.
- `docs/README.md`: no changes expected (it doesn't name these specific files), but
  verify at execution time.
- CLAUDE.md: no changes expected — CLAUDE.md's Google Calendar removal sentence
  (§16, "Meeting Detection (Event-Driven)") is already accurate and doesn't reference
  the specific dead functions/tables this spec removes; verify at execution time that
  no CLAUDE.md passage needs a matching update (e.g. if any file/method list elsewhere
  in CLAUDE.md happens to name one of the removed items).

## Open Questions

None. Both prior open questions have been resolved by explicit user direction:

1. `docs/specs/remove-meeting-auto-detection.md` has been amended (Non-goals, R6, Design
   "Files renamed", Resolved Decisions) to reflect that `joinCalendarMeeting()`/
   `getActiveEvents()`/`getCalendarEventById()` will already be gone by the time it
   executes, per this spec's recommended sequencing — see Design's "Sequencing" section
   above.
2. The entire top-level `integrations` key in `src/locales/pt/translation.json` is
   confirmed dead (pt-only locale key, zero code references anywhere in `src/` for any
   sub-key, no Settings → Integrations component exists) and its removal — in full, not
   just the `googleCalendar`/`sections.calendar` subset from an earlier pass — is now
   part of R4's removal list and the Design R4 subsection above.
