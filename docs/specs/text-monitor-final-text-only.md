# Text Monitor: Final-Pasted-Text Auto-Learn Correctness

## Status
Implemented

## Problem / Goal

EktosWhispr has an "auto-learn" feature: after a dictation is pasted into whatever
app/field the user is working in, a platform-native **text monitor** binary watches
that field for a short window. If the user manually edits a word, the diff is fed
into `extractCorrections()` and, when it looks like a genuine correction (not a
rewrite or continued typing), the corrected word is added to the custom dictionary
(`customDictionary`, used as Whisper prompt-hint text per CLAUDE.md §13) so future
dictations are more likely to get that word right.

The project owner's concern (translated from Portuguese voice input, verbatim
intent): the monitor must always compare against the **final text that was
actually pasted** into the destination field — not a raw, pre-cleanup transcript
buffer — because "Text Cleanup" (the optional AI cleanup pass applied to dictation
output before paste) can itself reword text. If the monitor's baseline were the
pre-cleanup transcript, a cleanup-driven wording change would look identical to a
user correction and get wrongly learned into the dictionary.

**Step 1 research finding (this session): the baseline is already correct.**
Tracing the code end-to-end (see Design → "Current behavior" below), the text
handed to the text-monitor as its comparison baseline is *always* the exact same
string that was placed on the clipboard/pasted — which is already the
cleaned-up text when Text Cleanup is active, and the raw transcript when it is
not (including the dictation-agent/voice-agent route, which explicitly bypasses
cleanup per CLAUDE.md §17). There is a single call site for pasting
(`safePaste()` in `src/helpers/audioManager.js` → `paste-text` IPC → the same
`text` value is used for both the actual OS paste and
`textEditMonitor.startMonitoring(text, …)`). **No code change is required for
the text-source-selection axis of this request** — but there is **no regression
test locking this invariant in place**, so a future refactor could silently
break it without anyone noticing. That gap is real work for this spec.

Separately, Step 1 research surfaced a genuine **behavior gap** relative to the
owner's literal wording ("capture the old word → new word pair"): today,
`extractCorrections()` computes an old-word/new-word diff internally, but only
returns the **new** (corrected) word — the original mis-transcribed word is
discarded. The `custom_dictionary` SQLite table has only a single `word` column;
there is no persisted old→new mapping anywhere. This spec proposes adding
lightweight, non-disruptive provenance for the "old word" (see Design), used
specifically to fix a real, currently-unhandled problem: correction oscillation
(the dictionary can get whipsawed back and forth if a word is "corrected" in
both directions across sessions).

**Scope confirmed by the project owner**: the custom dictionary is only meant
to learn the *correct spelling* for a word the user habitually
mis-transcribes/mis-dictates — it is explicitly **not** meant to become a
text substitution/replacement engine. The app already has a separate,
existing feature for actual word/phrase substitution (Snippets: `trigger` →
`replacement`, optionally app-filtered — see `docs/RECREATION_SPEC.md`'s
Snippets coverage), so building substitution capability into the custom
dictionary here would be duplicate scope. `learned_from` in this spec is
therefore **provenance metadata only** (used solely by the oscillation guard),
never applied as a find/replace rule — this is now a settled design decision,
not an open question.

## Requirements

1. **Regression-lock the "final pasted text" invariant.** Add automated tests
   proving that whatever string is passed to the `paste-text` IPC handler (and
   therefore actually pasted) is *identical* to the string used as
   `textEditMonitor.startMonitoring()`'s baseline (`originalText`), in both of
   these cases:
   - Text Cleanup enabled and successfully applied → baseline is the
     cleaned-up text, never the pre-cleanup raw transcript.
   - Text Cleanup disabled, unreachable, or bypassed (dictation-agent/voice-agent
     route, or `skipReasoning` agent mode) → baseline is the raw transcript,
     unchanged.
2. **Regression-lock that a detected correction already feeds the dictionary.**
   Add/extend automated tests proving the existing pipeline
   (`TextEditMonitor` `text-edited` event → 1500ms debounce
   (`AUTO_LEARN_DEBOUNCE_MS`) → `extractCorrections()` →
   `databaseManager.setDictionary(..., "learned")`) persists a genuine
   correction into `customDictionary` end-to-end.
3. **Capture the old word alongside the new word for provenance**, without
   turning the dictionary into a substitution/replacement engine. Add a
   nullable `learned_from` column to `custom_dictionary` that records the word
   a `source = 'learned'` entry replaced. `extractCorrections()`'s return
   value changes from `string[]` to an array of `{ from, to }` pairs so this
   information is available to the caller; the dictionary's operative content
   (the flat list of hint words handed to Whisper as `initialPrompt`, per
   CLAUDE.md §13) is unaffected — it still only ever contains the corrected
   (`to`) word.
4. **Anti-oscillation guard.** Before persisting a new learned correction
   `{ from: origWord, to: correctedWord }`, check whether an existing
   `source = 'learned'` row already has `word = origWord` (case-insensitive)
   with `learned_from = correctedWord` (case-insensitive) — i.e., the exact
   reverse correction was learned previously. If so, treat this as a probable
   oscillation/reversal rather than a genuine new correction: skip persisting
   it (do not add or modify any dictionary row), and log it at debug level for
   diagnosability. This is a heuristic safeguard, not a guarantee — see Edge
   Cases in Design.
5. **Document what counts as "a correction" vs. continued typing**, at the
   level of the existing heuristic in `src/utils/correctionLearner.js`
   (region-finding, word-level LCS alignment, edit-distance ratio ≤0.65,
   ≥3-character minimum, 50%-changed-words rewrite bailout), and add a
   regression test for the "user keeps typing new content after the pasted
   text" case specifically (as distinct from "user edits a word inside the
   pasted text"), since this is the crux of the non-trivial word-alignment
   problem referenced in the task.
6. Update `CLAUDE.md` and `docs/RECREATION_SPEC.md` to document the auto-learn
   pipeline (currently undocumented in CLAUDE.md's Helper Modules list and
   Custom Dictionary section — `textEditMonitor.js` and
   `src/utils/correctionLearner.js` aren't mentioned there at all), including
   the final-text invariant, the `learned_from` provenance field, and the
   oscillation guard.

## Non-goals

- Turning the custom dictionary into a true find/replace or substitution
  engine. `learned_from` is provenance metadata for the oscillation guard
  only; it is never applied as a text-replacement rule anywhere (not in the
  Whisper prompt, not in cleanup, not in paste). **Confirmed by the project
  owner**: the dictionary's job is strictly to learn correct spelling for
  words the user mis-transcribes/mis-dictates, not to substitute text —
  actual substitution is already covered by the separate, existing Snippets
  feature (`trigger` → `replacement`), so building that capability here would
  be duplicate scope.
- Syncing `learned_from` through the existing dictionary cloud-sync path
  (`db-upsert-dictionary-from-cloud`, `db-mark-dictionary-synced`, etc.) — it
  stays local-only metadata for this device's oscillation guard, at least for
  this spec.
- New Settings UI to view, edit, or manage `learned_from` pairs. The existing
  Custom Dictionary UI (flat word list) is unchanged.
- Changing the 500ms post-paste delay before monitoring starts, the 30s
  monitoring timeout, or the 1500ms auto-learn debounce.
- Changing the platform-native monitoring mechanisms themselves
  (AT-SPI2 on Linux, UI Automation on Windows, the Accessibility API /
  AXObserver on macOS) — Step 1 confirmed these already observe the real
  OS-level focused text field's value directly, which is the correct thing to
  watch; see Design.
- Any change to paste paths outside dictation (e.g., notes, snippets expansion
  itself) — there is a single call site for `paste-text` (`safePaste()` in
  `audioManager.js`, called only from `useAudioRecording.js`'s
  `onTranscriptionComplete`), so this spec's scope is exactly that path.

## Design

### Current behavior (confirmed via source, not assumed)

**Consumer/helper module**: `src/helpers/textEditMonitor.js` (class
`TextEditMonitor`), instantiated once in `main.js` and shared with
`windowManager` and `ipcHandlers`. It is a genuinely platform-native
implementation:

- **macOS**: spawns `resources/bin/macos-text-monitor` (compiled from
  `resources/macos-text-monitor.swift`), a Swift AXObserver binary that reads
  the focused element's `AXValue` for the given target PID; falls back to
  osascript AppleScript polling (`_startMacOSPolling`, reading `AXValue`/
  `AXSelectedText` every 500ms) if the binary is unavailable or fails to spawn.
- **Windows**: spawns `windows-text-monitor.exe` (from
  `resources/windows-text-monitor.c`), which uses **UI Automation** to read
  the focused control's value and emits `CHANGED:`/`CHANGED_B64:` lines on
  change.
- **Linux**: spawns `linux-text-monitor` (from `resources/linux-text-monitor.c`)
  using **AT-SPI2** event listeners, or falls back to a Python script
  (`linux-text-monitor.py`) using AT-SPI2 as well.

All three read the OS/accessibility-tree's actual current field value — this
*is* "the final text that was pasted into the destination text box," observed
directly at the source, not a copy or buffer maintained by EktosWhispr. This
already satisfies the owner's "watch the real destination field" requirement
and needs no change.

**What baseline text it's compared against**: `TextEditMonitor.startMonitoring(
originalText, timeoutMs, options)` is called from exactly one place — the
`paste-text` IPC handler in `src/helpers/ipcHandlers.js` — immediately after
`clipboardManager.pasteText(textToPaste, …)` succeeds, using the *same* `text`
argument the handler itself received (not `textToPaste`, which has trailing
smart-spacing appended; the monitor's baseline is the pre-spacing `text`, which
is what the destination field's *content* — modulo that trailing space — should
match). That `text` argument is `window.electronAPI.pasteText(text, options)`
called from `AudioManager.safePaste()` in `src/helpers/audioManager.js`, which
is called from exactly one place: `useAudioRecording.js`'s
`onTranscriptionComplete` callback, with `result.text`.

`result.text` is produced by `AudioManager.processTranscription(text, source)`
(`src/helpers/audioManager.js`, ~line 1613). This function:
- Returns the raw, normalized transcript unchanged when: cleanup is unreachable
  (`useCleanupModel` off or no cleanup model configured) *and* no dictation
  agent applies; or when `skipReasoning` is set (agent/voice-agent mode, per
  CLAUDE.md §17, which explicitly never falls back to cleanup).
- Returns the cleanup-model's or dictation-agent's processed output when
  reasoning is available and succeeds (`resolveReasoningRoute()` → cleanup or
  agent route).
- Falls back to the raw normalized transcript if reasoning throws.

In other words: `result.text` is always "the actual final text that is about to
be pasted," regardless of route, and that is exactly the string used both for
the OS paste and as the text-monitor's comparison baseline. **This confirms the
owner's requirement is already met on the text-source axis.**

**When monitoring starts/stops**: started via `setTimeout(..., 500)` right
after `clipboardManager.pasteText()` resolves inside the `paste-text` handler,
gated on `this.textEditMonitor && this._autoLearnEnabled`; runs for up to 30s
(safety-net timeout in `TextEditMonitor`, binaries also self-timeout); stopped
early on `NO_ELEMENT`/`NO_VALUE` from the binary, on `stopMonitoring()` (called
at the start of every new `startMonitoring()` call and on app quit), so only one
monitoring session is ever active.

**What triggers "a correction" today**: any OS-reported change to the focused
field's value emits a `text-edited` event
(`{ originalText, newFieldValue }`). `ipcHandlers.js`'s
`_setupTextEditMonitor()` listens, stores the latest `{originalText,
newFieldValue}` (overwriting on every intermediate keystroke so only the final
state after 1500ms of inactivity is processed —
`AUTO_LEARN_DEBOUNCE_MS`), then calls `_processCorrections()`, which invokes
`extractCorrections(originalText, newFieldValue, currentDict)`
(`src/utils/correctionLearner.js`). That function:
1. Bails out immediately if the texts are identical.
2. Locates the "edited region" within a larger field value via exact substring
   match or a sliding word-window with ≥30% overlap (`findEditedRegion`) — this
   is what lets the monitor ignore text the user typed *after* the pasted
   content, rather than misreading it as a correction.
3. Tokenizes both the original and edited region, computes a word-level LCS
   alignment (`findSubstitutions`) to find `[origWord, editedWord]`
   substitution pairs.
4. Bails out entirely if more than 50% of words changed (treated as a rewrite,
   not spot corrections).
5. Filters remaining substitutions: skip if the corrected word is already in
   the dictionary, skip duplicates within the same event, skip if the two
   words are identical case-insensitively, skip corrected words under 3
   characters, skip if Levenshtein edit-distance ratio exceeds 0.65 (keeps
   "phonetic" corrections like Shunade→Sinead, rejects unrelated replacements).
6. Returns the surviving corrected words (today: `string[]`, discarding the
   `origWord` half of each pair once used for the checks above).

**Does a detected correction already feed the dictionary today?** Yes.
`_processCorrections()` in `ipcHandlers.js` appends every returned corrected
word to the current `customDictionary` and calls
`databaseManager.setDictionary(updatedDict, "learned")`, which upserts into the
`custom_dictionary` table with `source = 'learned'`, then broadcasts the
post-save list to renderers. This part already works; there is no "missing
feed into the dictionary" gap.

**What's missing**: the old word (`origWord`) from each detected pair is
discarded — `custom_dictionary` has no column to record it, so there is no way
to detect an oscillation (word A learned as a correction for word B, then later
word B "corrected" back to word A) other than by re-running the same
edit-distance heuristic blind to history.

### Changes for this spec

1. **`src/utils/correctionLearner.js`**: change `extractCorrections()`'s return
   type from `string[]` to `Array<{ from: string, to: string }>` (one entry per
   surviving substitution, `from` = original word as it appeared in the pasted
   text, `to` = the corrected word as it appears in the field). Preserve every
   existing filter/threshold exactly as-is (this is a shape change only, not a
   logic change) so the 11 existing tests in
   `test/utils/correctionLearner.test.js` continue to hold after updating their
   assertions to the new shape.
2. **`src/helpers/database.js`**:
   - Add a nullable `learned_from TEXT` column to `custom_dictionary`, added
     via the same additive-migration pattern already used for
     `client_dict_id`/`cloud_id`/`source`/`sync_status`/`deleted_at`/
     `updated_at` (guarded `ALTER TABLE ... ADD COLUMN`, checked against the
     table's current columns before running — see the existing migration block
     around `src/helpers/database.js:560-603`).
   - `setDictionary(words, sourceForNewWords)` gains an optional way to pass
     per-word provenance for `learned` entries (e.g. an overload/second
     parameter carrying a `Map<lowercasedWord, originalWord>` for the words
     being added this call) so a newly-inserted `learned` row can have
     `learned_from` populated in the same transaction as the `insert`
     prepared statement already in that method. Existing manual-entry and
     bulk-restore code paths that don't supply provenance leave `learned_from`
     NULL, unchanged from today.
   - When a `learned` row is promoted to `manual` (existing `promoteSource`
     statement, triggered when a user manually re-types/re-saves a word that
     was previously auto-learned), also clear `learned_from` to NULL — once a
     human has explicitly endorsed the word, its auto-learn provenance is no
     longer meaningful (see Open Questions — confirm this is desired).
   - Add a small accessor (e.g. `getDictionaryWithProvenance()` or extend
     `getDictionary()`'s row mapping) so `ipcHandlers.js` can look up
     `{ word, source, learned_from }` for the oscillation check without a new
     IPC channel — this can be a plain internal `DatabaseManager` method, not
     necessarily new IPC surface, since it's only consumed within the main
     process's `_processCorrections()`.
3. **`src/helpers/ipcHandlers.js`** (`_processCorrections()`):
   - Adapt to `extractCorrections()`'s new `{from, to}` return shape.
   - Before adding each `{from, to}` pair to the dictionary, run the
     oscillation check described in Requirement 4: look up whether an existing
     `source = 'learned'` row has `word` matching `to`'s... — precisely: check
     for an existing row where `word` (case-insensitive) equals `from` and
     `learned_from` (case-insensitive) equals `to`. If found, skip this pair
     (do not append it, do not touch the existing row), and emit a
     `debugLogger.debug("[AutoLearn] Skipped likely oscillation", { from, to })`
     line so this is diagnosable without being user-visible (matches the
     otherwise-silent auto-learn UX already in place).
   - Pass surviving pairs' provenance through to `databaseManager.setDictionary(...)`
     per the interface change above.
4. **No changes** to `TextEditMonitor` itself, to the `paste-text` IPC handler's
   text-selection logic, to `AudioManager.processTranscription()`, or to any of
   the native binaries — Step 1 confirmed these are already correct for the
   final-pasted-text requirement. This spec only adds tests around them (see
   Validation Plan) plus the provenance/oscillation work above.

**Implementation note**: `ipcHandlers.js`'s `_processCorrections()` body (steps
2–3 above) was extracted into a new, Electron-free module
(`src/helpers/autoLearnDictionary.js`, `processAutoLearnCorrections()`) so the
oscillation guard and dictionary-persistence logic is unit-testable without
instantiating the full `IPCHandlers` class (whose constructor does unrelated,
heavy app-startup work — GPU detection, audio-cleanup timers, hundreds of other
IPC registrations). `_processCorrections()` itself is now a thin wrapper that
calls this function and handles the Electron-specific broadcasting
(`dictionary-updated`/`corrections-learned`/`showDictationPanel`). Behavior is
unchanged; this is purely a testability-driven refactor, consistent with the
Validation Plan's "smallest exercisable unit" framing.

### Edge cases

- **Continued typing vs. correction** (Requirement 5): already handled by
  `findEditedRegion`'s sliding-window/substring match, which isolates just the
  portion of the field corresponding to the originally-pasted text before
  diffing. Text typed before or after that region is invisible to
  `extractCorrections()` and never considered a "correction." A regression
  test should exercise: paste text, then append a new, unrelated sentence after
  it (cursor at end, keep typing) → expect zero corrections extracted.
- **Oscillation / feedback loops** (Requirement 4): handled by the
  `learned_from`-based reverse-lookup above. This is a heuristic, not a
  guarantee — it only detects an *exact* prior reverse pair
  (`from`/`to` swapped), not more complex cycles (A→B→C→A). That is an
  accepted limitation for this spec; the existing `undo-learned-corrections`
  IPC and manual dictionary editing remain the escape hatch for anything the
  heuristic doesn't catch.
- **Rapid re-edits within one paste** are already collapsed correctly: the
  1500ms debounce means only the field's state 1500ms after the last edit is
  diffed against the original — intermediate keystrokes never each trigger
  their own correction event.
- **Field grows much larger than the pasted text** (e.g. the pasted text is one
  sentence in a much longer document): `findEditedRegion`'s `length <=
  originalText.length * 1.5` short-circuit and sliding-window fallback already
  handle this; no change needed, but add a regression test for a field whose
  total content is several times longer than the pasted text with a
  correction landing inside the pasted region.

## Validation Plan

### Automated

- `test/utils/correctionLearner.test.js`: update all existing assertions for
  `extractCorrections()`'s new `{from, to}` return shape (currently asserts a
  flat `string[]`); do not change the underlying filter behavior being tested.
  Add:
  - A test asserting each returned entry has both `from` (the original,
    mis-transcribed word) and `to` (the corrected word) populated correctly
    for a known phonetic-correction case (e.g. Shunade→Sinead).
  - A test for "continued typing after the pasted text" (append a new
    sentence past the end of the pasted region) → expect an empty result.
  - A test for a correction landing inside a pasted region that is a small
    fraction of a much larger field (field length » 1.5× original length).
- New or extended test file (e.g. `test/helpers/autoLearnDictionary.test.js`,
  following this repo's existing self-contained-mock convention — see
  `docs/RECREATION_SPEC.md` §7.8 — mocking `databaseManager`/`textEditMonitor`
  via `Module._load` interception as other `test/helpers/*.test.js` files do):
  - **(a) Old-word→new-word capture into the custom dictionary**: simulate a
    `text-edited` event through `_setupTextEditMonitor()`'s handler (or the
    smallest unit that exercises `_processCorrections()`), wait past the debounce,
    and assert `databaseManager.setDictionary()` is called with the corrected
    word present in the updated list, `source: "learned"`, and that the
    provenance (`from`) is threaded through to be persisted as `learned_from`
    on that row.
  - **Oscillation guard**: seed a mock dictionary state with an existing
    `learned` row `{ word: "B", learned_from: "A" }`; simulate a new
    `text-edited` event whose diff is `{from: "B", to: "A"}` (i.e., the exact
    reverse); assert `setDictionary()` is either not called, or called with no
    net change for that word — the dictionary must not flip back to "A"
    replacing "B".
- New or extended test asserting **(b) correct text-source selection when Text
  Cleanup is active vs. inactive**: call the `paste-text` IPC handler function
  directly (with mocked `clipboardManager`/`textEditMonitor`/`windowManager`,
  matching this repo's existing IPC-handler unit-testing style) with a given
  `text` argument, and assert `textEditMonitor.startMonitoring()` is invoked
  with that exact same string as its `originalText` argument — proving the
  handler never has two diverging notions of "the text." Separately, add/extend
  a test on `AudioManager.processTranscription()` (or the smallest exercisable
  unit) asserting:
  - With `useCleanupModel: true` and a working cleanup route, the returned text
    is the cleanup-model's output, not the raw transcript passed in.
  - With `useCleanupModel: false` (or no cleanup model configured, and no
    dictation agent), the returned text equals the raw transcript unchanged.
  - With `skipReasoning` set (agent/voice-agent bypass per CLAUDE.md §17), the
    returned text equals the raw/agent-route transcript, never routed through
    cleanup.
- Run the full suite (`npm test`) to confirm no regressions in the 11 currently
  passing `correctionLearner.test.js` cases or `textEditMonitorPrecedingChar.test.js`.

**Implementation note (reviewed exception for the `AudioManager.processTranscription()`
part of (b))**: this repo's automated test harness is `node --test` only (no
bundler/TS-loader, no Vitest/jsdom — confirmed via `package.json`'s `test`
script). `audioManager.js` is a renderer-only ES module that transitively
imports extensionless `.ts` files (e.g. `../stores/settingsStore`) and uses
browser globals (`window`); neither plain `require()` nor Node's native
dynamic `import()` can resolve it without a bundler, so it cannot be directly
unit-tested today (verified by spike — `import()` fails on the `.ts` imports).
Its internal `resolveReasoningRoute()`'s routing-*kind* decision (cleanup vs.
agent vs. skip, including the voice-agent-never-falls-back-to-cleanup rule)
already delegates to `resolveDictationRouteKind()`/
`resolveDictationAgentReachability()` in `src/helpers/dictationRouting.js`,
which is fully covered by the pre-existing `test/helpers/dictationRouting.test.js`
(unchanged by this spec). Combined with the new
`test/helpers/pasteTextMonitorInvariant.test.js` (which exercises the real,
registered `paste-text` IPC handler and proves it never diverges the pasted
text from the monitor's baseline, regardless of what produced that text
upstream), this constitutes the automated coverage that's actually
obtainable for requirement (b) without introducing a new test-bundling
toolchain (out of scope for this spec). The remaining gap — that
`processTranscription()` itself returns the cleanup-model's output vs. the
raw transcript under the three `useCleanupModel`/`skipReasoning` conditions —
is covered by the Manual steps 1–2 below (debug-log inspection of
`originalText` against Text Cleanup on/off), per this repo's documented
"reviewed exception" allowance for genuinely non-automatable cases.

### Manual

1. Enable Text Cleanup with a working cleanup model configured, and enable
   Auto-Learn in Settings. Dictate a sentence containing a name Whisper
   commonly mis-transcribes (e.g., "Shunade"), letting cleanup reword something
   unrelated elsewhere in the sentence. After paste, within the 30s monitoring
   window, manually correct only the mis-transcribed name in the destination
   app. Enable debug logging (`--log-level=debug`) and confirm the
   `[AutoLearn]` log lines show `originalText` equal to the **cleaned-up**
   text that was actually pasted (matching the visible pasted content), not
   the pre-cleanup raw transcript. Confirm the corrected name appears in
   Settings → Custom Dictionary shortly after (debounce + processing).
2. Disable Text Cleanup entirely. Repeat the same dictation and correction.
   Confirm the dictionary still updates, and confirm via debug logs that
   `originalText` equals the raw transcript (since no cleanup ran either way —
   same value as what was pasted).
3. Oscillation guard: after step 1 learns "Sinead" as a correction for
   "Shunade," trigger another dictation later where the pasted field is
   manually edited from "Sinead" back to "Shunade." Confirm via debug logs
   that this is detected and explicitly skipped as a likely oscillation, and
   that Settings → Custom Dictionary is unchanged (does not re-add "Shunade" as
   a learned word replacing "Sinead").
4. Continued-typing check: dictate text, let it paste, then click at the end
   of the pasted text and type a brand-new, unrelated sentence. Confirm no
   dictionary changes occur.
5. Repeat steps 1–2 once each on Windows (UI Automation), Linux (native
   AT-SPI2 binary, and again with the binary temporarily removed/renamed to
   force the Python AT-SPI2 fallback), and macOS (native AXObserver path, and
   again forcing the osascript-polling fallback) to confirm the platform-native
   "final field value" observation genuinely reflects reality on all three,
   per the binary table in `docs/RECREATION_SPEC.md` §7.7.

### Docs

- `CLAUDE.md`: add `textEditMonitor.js` and `src/utils/correctionLearner.js`
  to the Helper Modules list (currently absent), and add a subsection near
  §13 (Custom Dictionary) documenting the auto-learn pipeline: final-pasted-text
  invariant, the debounce, the `{from, to}` diff, the `learned_from` provenance
  field, and the oscillation guard.
- `docs/RECREATION_SPEC.md`: its auto-learn coverage (around the "Dicionário"
  and helper-init sections, and §7.7's binary table) should be updated to
  reflect the `learned_from` column, `extractCorrections()`'s new return
  shape, and the oscillation-guard behavior, once implemented.
- This spec file: `spec-executor` sets `Status: Implemented` once validation
  passes, per the standard workflow.

## Open Questions

1. Should the oscillation guard remain silent (debug-log only, matching
   today's silent auto-learn UX), or should it surface a toast/notification to
   the user when a likely-reversal is skipped?
2. Should `learned_from` ever sync across devices via the existing dictionary
   cloud-sync path, so the oscillation guard works consistently across a
   user's machines? This spec assumes local-only for now.
3. Should `learned_from` be cleared when a `learned` row is promoted to
   `manual` (existing `promoteSource` path)? This spec assumes yes (see
   Design) — confirm.
4. Is a 500ms debounce/1500ms wait/30s timeout still acceptable given this
   spec keeps them unchanged? (Not expected to need revisiting, but flagging
   since none of this spec's requirements touch timing.)
