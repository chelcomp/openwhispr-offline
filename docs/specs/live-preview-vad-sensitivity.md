# Live-Preview VAD Sensitivity (own settings, decoupled from Silero)

## Status
Implemented

> **Superseded in part by `docs/specs/vad-settings-tabs.md`**: that follow-up spec restructures
> the stacked "Voice Activity Detection"/"Live Preview Sensitivity" sections below into two
> tabs, and exposes `speechPadMs`, `maxSpeechDurationS`, `samplesOverlap`, `energyThreshold`,
> `minSegmentRms`, `noiseFloorFactor`, `noiseFloorAlpha`, `maxMerges`, `maxMergedMs` as
> user-facing controls — this spec's own decisions to keep those "3 fields fixed, 6 constants
> out of scope" no longer hold. This spec's decoupling design (separate namespace, separate
> IPC, separate resolver) is unchanged and still authoritative for that part.

## TL;DR
The live-preview overlay ("Listening...") added by `docs/specs/audio-transcription-batching.md`
almost never shows committed text — it silently borrows the Silero VAD settings screen's
values (`minSpeechDurationMs` etc.) for a completely different, cruder energy/RMS detector,
and Silero's tuned defaults (250ms min-speech) never survive real speech's natural
micro-fluctuations under that cruder detector. A temporary experimental override
(`Math.min`/`Math.max` clamps) is sitting uncommitted in this worktree and fixed it, but the
project owner explicitly rejected that pattern — silently overriding a value the user can see
on screen. This spec adds a **separate, visible settings section** for the live-preview
detector's own sensitivity, decoupled entirely from Silero.

- New independent settings namespace ("Live Preview Sensitivity"), new localStorage keys,
  new main-process store, new IPC channels — not a repurposing of `whisperVad.json`/
  `whisper-vad-*` IPC.
- User-tunable: `minSpeechDurationMs` (default 80ms) and `minSilenceDurationMs` (default
  500ms) — the two fields proven to matter and directly implicated in the bug.
- Not user-tunable (own fixed internal defaults, no longer inherited from Silero at all):
  `speechPadMs`, `maxSpeechDurationS`, `samplesOverlap` — three internal knobs a user has no
  intuition for tuning; giving them their own fixed constants (rather than falling through to
  Silero's `DEFAULT_WHISPER_VAD_CONFIG`) is what makes "no Silero value reaches the energy
  detector" actually true, not just true for the two exposed fields.
- `energyThreshold`, `minSegmentRms`, `noiseFloorFactor`, `noiseFloorAlpha`, `maxMerges`,
  `maxMergedMs` stay exactly as they are today — pure code constants in
  `dictationBatchingSession.js`'s `DEFAULTS`, already independent of Silero, out of scope here.
- The uncommitted experimental `Math.min(...)`/`Math.max(...)` clamp in `ipcHandlers.js`
  (~line 6471-6490) is removed entirely and replaced by reading the new settings — no more
  silent floors/caps; whatever the new UI shows is exactly what runs.
- No blocking open question — the product decision (separate visible UI, not a silent
  override) was already made by the project owner in the conversation that produced this spec.
- User impact: a new "Live Preview Sensitivity" section appears in Settings → Speech-to-Text,
  below the existing Silero "Voice Activity Detection" section, with its own two sliders and
  copy explaining it governs the live "Listening..." overlay specifically, not the final
  transcription. With the new 80ms/500ms defaults, the preview should reliably show
  committed/partial text during dictation instead of falling back to full offline transcription
  every time.

## Problem / Goal

`src/helpers/ipcHandlers.js`'s `start-dictation-preview` handler builds the live-preview
energy-VAD's config by reading `this._resolveWhisperVadOptions("dictation")?.vadConfig` — the
user's Silero VAD settings (Settings → Speech-to-Text → "Voice Activity Detection", labeled
"Configure how Silero VAD detects and segments speech for local Whisper transcription").
`src/helpers/dictationBatchingSession.js`'s energy detector is architecturally nothing like
Silero: `_processFrame()` requires an *unbroken run* of voiced 20ms frames for
`_voicedRunMs >= minSpeechDurationMs` before confirming `STATE_SPEECH` — a single unvoiced
frame resets the run to 0. Silero's tuned default (effectively 250ms via
`settingsStore.ts`'s `readString("whisperVadMinSpeechDurationMs", "250")` fallback — note this
250 differs from `whisperVad.json`'s `DEFAULTS.minSpeechDurationMs: 100`, which is the
schema-level default used elsewhere; 250 is what actually ships to new users via the renderer
default) requires ~12-13 consecutive voiced frames with zero dip, which real speech's soft
consonants/breath/syllable gaps essentially never produce. Result: `STATE_SPEECH` rarely
confirms, `coverageRatio` stays near 0, and the live-preview overlay almost always falls back
to the full offline transcription pass instead of showing progressive committed/partial text
— confirmed via debug logs across 5 live dictation attempts this session
(`coverageRatio`: 0, 0, 0.39, 0, 0.08).

An uncommitted experimental edit (capping `minSpeechDurationMs` to 80ms and flooring
`minSilenceDurationMs` to 500ms, both derived from the Silero value) fixed it in one live test
(`coverageRatio: 0.42, fastPath: true`), proving the direction and magnitude, but this
silent-borrow-then-override pattern was explicitly rejected by the project owner: "if there's
a setting on screen, it should respect exactly what's on screen; if something needs to be
forced/limited, that has to be visible on the screen, not hidden from the user." The Silero
settings screen makes no mention of governing the live preview, so a user tuning it has no way
to know or reason about its effect on that overlay — and the existing silent
`minSilenceDurationMs` floor (already shipped, pre-dating this spec) has the same problem.

Goal: give the live-preview energy detector its own, honestly-labeled, user-visible settings,
fully decoupled from the Silero VAD screen, with defaults matching the validated experimental
values, and remove every silent override.

## Requirements

1. A new settings namespace exists for the live-preview energy detector's tunable fields,
   fully independent of the existing Silero `whisperVad.json`/`whisper-vad-*` IPC/
   `whisperVadConfig.js` namespace — no shared schema, no fallthrough to
   `DEFAULT_WHISPER_VAD_CONFIG`.
2. Two fields are user-tunable via new Settings UI controls: `minSpeechDurationMs` (default
   `80`, i.e. the validated experimental value) and `minSilenceDurationMs` (default `500`, the
   validated experimental value — NOT the Silero-namespace's 200/250).
3. Three fields the energy detector also consumes today via the shared `vad` object
   (`speechPadMs`, `maxSpeechDurationS`, `samplesOverlap`) get their own fixed defaults in the
   new namespace, decoupled from Silero's values, but are NOT exposed as user-facing controls
   (internal constants a typical user has no basis to reason about for an invisible preview
   detector). Defaults are chosen to match the energy detector's actual needs, not
   Silero-inherited numbers — see Design for the specific values and rationale.
4. `src/helpers/ipcHandlers.js`'s `start-dictation-preview` handler builds the energy
   detector's `vadConfig` entirely from the new namespace — it must not read
   `_resolveWhisperVadOptions("dictation")` (or any Silero-sourced value) for this purpose
   anymore, for any of the five fields above.
5. The existing experimental `Math.min(...)`/`Math.max(...)` clamps (~ipcHandlers.js
   6471-6490 in this worktree) are removed entirely — no silent floors/caps remain anywhere in
   this path. Whatever the new settings show is exactly what's passed to
   `createDictationBatchingSession`.
6. New Settings UI: a clearly-labeled "Live Preview Sensitivity" section under Settings →
   Speech-to-Text, visually and textually distinct from the existing "Voice Activity
   Detection" (Silero) section, with copy that makes plain-language clear this governs the
   live "Listening..." overlay specifically (a simpler, faster detector), not the final
   transcription quality — and gives the user a reason tuning might matter (e.g. "if the live
   preview rarely shows text while you're speaking, lowering this may help").
7. New localStorage keys persist the two user-tunable values, following the exact pattern of
   `whisperVadMinSpeechDurationMs`/`whisperVadMinSilenceDurationMs` in `settingsStore.ts`
   (own `LIMITS`/`DEFAULTS` constants file, own clamp helper, own IPC push/pull, own reset-to-
   defaults action) — a fully parallel, not shared, code path.
8. Main process persists/serves the new namespace via new IPC channels
   (`preview-vad-get-config` / `preview-vad-set-config`, mirroring `whisper-vad-get-config` /
   `whisper-vad-set-config`) and a new `_resolvePreviewVadOptions()` method mirroring
   `_resolveWhisperVadOptions()`.
9. A pure, unit-testable resolver function builds the final energy-VAD config object from
   raw settings input, independent of Electron/IPC, so it can be tested directly (matching the
   existing convention of `audioCleanupPolicy.js`, `dictationRouting.js`, `whisperVadConfig.js`'s
   `clampVadField`/`sanitizeWhisperVadConfig`).
10. i18n: all new UI strings get keys in both `src/locales/en/translation.json` and
    `src/locales/pt/translation.json`.
11. No migration needed: these are brand-new localStorage keys and a brand-new IPC namespace
    with defaults — no existing settings key, schema, or persisted value is renamed,
    restructured, or reinterpreted (CLAUDE.md §6 does not trigger).

## Non-goals

- Do not modify the Silero VAD settings section, its schema (`whisperVad.json`), its IPC
  channels (`whisper-vad-get-config`/`whisper-vad-set-config`), or its behavior for the
  offline/full-clip Whisper pass — that section continues to mean exactly what its existing
  description says.
- Do not re-open `docs/specs/audio-transcription-batching.md`'s already-implemented
  segmentation/merging/quality-gate design — this spec only changes where the energy
  detector's config values come from.
- Do not expose every field in `dictationBatchingSession.js`'s `DEFAULTS` object as a UI
  control. `energyThreshold`, `minSegmentRms`, `noiseFloorFactor`, `noiseFloorAlpha`,
  `maxMerges`, `maxMergedMs` remain pure code constants — they were never Silero-derived, are
  not implicated in this bug, and require audio-engineering context a settings screen can't
  usefully convey (e.g. an adaptive noise-floor multiplier). If real-world testing surfaces a
  need to tune these later, that is separate future work with its own spec.
- Do not touch the note-recording or meeting Silero VAD contexts (`noteRecordingSileroEnabled`,
  `meetingSileroEnabled`) — the live-preview overlay only exists for the dictation flow
  (`start-dictation-preview` is dictation-only), so there is no equivalent preview-VAD need for
  those contexts.

## Design

### Current state (what's being replaced)

In this worktree, `ipcHandlers.js`'s `start-dictation-preview` handler (~line 6471-6490)
currently:

```
const sileroVadConfig = this._resolveWhisperVadOptions("dictation")?.vadConfig;
const energyVadConfig = {
  ...sileroVadConfig,
  minSilenceDurationMs: Math.max(sileroVadConfig?.minSilenceDurationMs || 0, 500),
  minSpeechDurationMs: Math.min(sileroVadConfig?.minSpeechDurationMs || 0, 80),
};
```

This spreads the *entire* Silero config (`threshold`, `minSpeechDurationMs`,
`minSilenceDurationMs`, `maxSpeechDurationS`, `speechPadMs`, `samplesOverlap`) into the energy
detector's config, then silently clamps two of the six fields. `threshold` happens to be
harmless (the energy detector never reads a `threshold` field — it uses its own
`energyThreshold` constant), but `speechPadMs`, `maxSpeechDurationS`, and `samplesOverlap` are
consumed as-is by `DictationBatchingSession`'s constructor (`this._speechPadMs`,
`this._maxSpeechMs`, `this._overlapSamples`) — meaning a user's Silero settings tuning
currently reaches the energy detector for those three fields too, invisibly. This whole block
is deleted and replaced per below.

### New files

**`src/constants/previewVad.json`** (new, sibling to `src/constants/whisperVad.json`, same
shape):

```json
{
  "DEFAULTS": {
    "minSpeechDurationMs": 80,
    "minSilenceDurationMs": 500,
    "speechPadMs": 100,
    "maxSpeechDurationS": 20,
    "samplesOverlap": 0.3
  },
  "LIMITS": {
    "minSpeechDurationMs": { "min": 20, "max": 500, "round": true },
    "minSilenceDurationMs": { "min": 100, "max": 2000, "round": true },
    "speechPadMs": { "min": 0, "max": 500, "round": true },
    "maxSpeechDurationS": { "min": 5, "max": 60, "round": true },
    "samplesOverlap": { "min": 0, "max": 0.95, "round": false }
  }
}
```

Rationale for the three non-user-facing fields' new fixed defaults (all deliberately
independent of Silero's 200/250/30/200/0.5 defaults, not copies of them):
- `speechPadMs: 100` — half of Silero's default; the energy detector's pre-roll cap
  (`_prerollCap = ceil((speechPadMs + minSpeechMs) / frameMs)`) only needs enough lead-in to
  not clip the confirmed onset, and with `minSpeechMs` now much shorter (80ms) a smaller pad
  keeps the segment head tight instead of dragging in a long stretch of pre-speech silence.
- `maxSpeechDurationS: 20` — shorter than Silero's 30s ceiling on purpose: the energy detector
  has no semantic understanding of sentence boundaries, so long uninterrupted stretches are
  more likely to be one continuous vocalization needing a forced cut than genuine long-form
  speech; this also bounds the fallback per-utterance transcription cost.
- `samplesOverlap: 0.3` — a modest overlap (down from Silero's 0.5) on the forced-cut boundary
  (`_flushSegment({ keepSpeaking: true })`), enough to catch a word straddling the cut without
  meaningfully inflating merged-audio duration.

These three are shipped only as this file's `DEFAULTS` (no `LIMITS`-driven UI control is
rendered for them) — `LIMITS` entries are still defined so `clampPreviewVadField` (below) can
validate them defensively if ever read from a corrupted persisted value, per Requirement 3.

**`src/helpers/previewVadConfig.js`** (new, mirrors `src/helpers/whisperVadConfig.js`
line-for-line in structure):

- `const { DEFAULTS, LIMITS } = require("../constants/previewVad.json");`
- `DEFAULT_PREVIEW_VAD_CONFIG = Object.freeze({ ...DEFAULTS })`
- `PREVIEW_VAD_LIMITS = Object.freeze(LIMITS)`
- `clampPreviewVadField(key, value)` — identical logic to `clampVadField`, against this file's
  own `DEFAULTS`/`LIMITS`.
- `sanitizePreviewVadConfig(input = {})` — identical logic to `sanitizeWhisperVadConfig`,
  merging `DEFAULTS` with `input` and clamping every key.
- **`resolvePreviewVadConfig(persistedSettings = {})`** (new, no Silero equivalent needed
  because Silero's resolver just strips a couple of enabled-flags — this one is the pure
  function Requirement 9 calls for): takes the main-process's stored preview-VAD settings
  object (already sanitized) and returns the exact `vadConfig` object to hand to
  `createDictationBatchingSession` — i.e. it is `sanitizePreviewVadConfig(persistedSettings)`
  by another name, but named/exported separately so `start-dictation-preview` calls one
  clearly-purposed function instead of reaching into a generic sanitizer, and so the
  regression test (Validation Plan) has one narrow, obviously-correct thing to assert against.
  Exported alongside the above.
- Module exports: `DEFAULT_PREVIEW_VAD_CONFIG`, `PREVIEW_VAD_LIMITS`, `clampPreviewVadField`,
  `sanitizePreviewVadConfig`, `resolvePreviewVadConfig`.

### Main process (`src/helpers/ipcHandlers.js`)

- Constructor: alongside the existing `this.whisperVadSettings = { ... }` initialization, add
  `this.previewVadSettings = { ...DEFAULT_PREVIEW_VAD_CONFIG };` (import
  `DEFAULT_PREVIEW_VAD_CONFIG` from the new `previewVadConfig.js`, next to the existing
  `whisperVadConfig.js` import).
- New methods mirroring the existing Silero ones:
  - `_getPreviewVadSettings()` → `sanitizePreviewVadConfig(this.previewVadSettings || {})`.
  - `_setPreviewVadSettings(update = {})` → merges and re-sanitizes, same shape as
    `_setWhisperVadSettings`.
  - `_resolvePreviewVadOptions()` → returns `resolvePreviewVadConfig(this._getPreviewVadSettings())`
    (no per-context branching needed — Requirement's non-goal confirms this is dictation-only).
- New IPC handlers, registered alongside the existing `whisper-vad-get-config`/
  `whisper-vad-set-config` pair:
  - `ipcMain.handle("preview-vad-get-config", ...)` → `{ success: true, config: this._getPreviewVadSettings() }`.
  - `ipcMain.handle("preview-vad-set-config", async (_event, payload) => ...)` →
    `{ success: true, config: this._setPreviewVadSettings(payload || {}) }`.
- `start-dictation-preview` handler: delete the entire
  `sileroVadConfig`/`energyVadConfig` block (lines ~6471-6490) and replace with:
  `const energyVadConfig = this._resolvePreviewVadOptions();` — passed to
  `createDictationBatchingSession({ vadConfig: energyVadConfig, ... })` exactly where
  `energyVadConfig` is used today.

### Preload (`preload.js`)

Add, mirroring the existing pair:
```
getPreviewVadConfig: () => ipcRenderer.invoke("preview-vad-get-config"),
setPreviewVadConfig: (config) => ipcRenderer.invoke("preview-vad-set-config", config),
```
Add corresponding method signatures to `src/types/electron.ts`'s IPC surface type, matching
the existing `getWhisperVadConfig`/`setWhisperVadConfig` entries.

### Renderer store (`src/stores/settingsStore.ts`)

Follow the exact pattern used for `whisperVadMinSpeechDurationMs`/
`whisperVadMinSilenceDurationMs` (read around lines 218-227, 1118-1134, 1709-1720, 1750-1764,
2549-2558 in this worktree), but for the new, separate namespace:

- Import `previewVadConstants` from `src/constants/previewVad.json` (parallel to the existing
  `whisperVadConstants` import) and reuse (or duplicate, matching existing convention) a
  `clampPreviewVadValue` local helper against `previewVadConstants.LIMITS`/`DEFAULTS`.
- New store fields: `previewVadMinSpeechDurationMs: number`,
  `previewVadMinSilenceDurationMs: number`.
- New localStorage keys: `previewVadMinSpeechDurationMs` (default `"80"`),
  `previewVadMinSilenceDurationMs` (default `"500"`) — read via the same `readString(...)` +
  clamp pattern as the Silero fields, so an invalid/missing value falls back to the new
  namespace's own default, never the Silero one.
- New setter actions `setPreviewVadMinSpeechDurationMs(next)` /
  `setPreviewVadMinSilenceDurationMs(next)`, each: clamp → `localStorage.setItem(...)` →
  `useSettingsStore.setState({...})` → `window.electronAPI?.setPreviewVadConfig?.({ ... })` (only
  the two fields; the three internal ones are never sent from the renderer at all — the main
  process's `DEFAULT_PREVIEW_VAD_CONFIG` already supplies them).
- A `resetPreviewVadDefaults()` action mirroring the existing Silero reset-to-defaults action
  (around line 1750), setting both fields back to `previewVadConstants.DEFAULTS` values and
  pushing the full config via `setPreviewVadConfig`.
- Startup hydration: on app init (wherever `whisperVadThreshold` etc. are pushed to main via
  `setWhisperVadConfig` at startup — see line ~2549-2558), add an equivalent one-time push of
  `{ minSpeechDurationMs: currentState.previewVadMinSpeechDurationMs, minSilenceDurationMs: currentState.previewVadMinSilenceDurationMs }`
  via `setPreviewVadConfig`, so a value the user changed in a previous session reaches the main
  process before the next `start-dictation-preview` call (same "two sources of truth" hazard as
  the existing Silero fields — main process has no independent persistence across restarts
  other than what the renderer pushes it).

### Settings UI (`src/components/SettingsPage.tsx`)

Add a new section immediately below the existing "Voice Activity Detection" (Silero) section
(after the block ending ~line 1337 in this worktree), following the same layout/component
patterns (the same slider/field component used for `whisperVadMinSpeechDurationMs` etc.):

- Section title: new i18n key `settingsPage.transcription.previewVad.title` (e.g. "Live Preview
  Sensitivity").
- Section description: new key `settingsPage.transcription.previewVad.description` — must
  explicitly name what makes it different from the section above, e.g. (exact final copy is a
  UI/UX call for whoever writes the translation, but must convey): "Controls how quickly the
  live 'Listening...' preview recognizes and reflects your speech while you're still talking.
  This is a separate, simpler, faster detector than the Voice Activity Detection above, which
  only affects your final transcription — tuning one does not affect the other. If the live
  preview rarely shows text while you speak, try lowering the values below."
- Two fields, same slider/number-input component as the Silero fields:
  - `settingsPage.transcription.previewVad.fields.minSpeechDurationMs.label`/`.info`
  - `settingsPage.transcription.previewVad.fields.minSilenceDurationMs.label`/`.info`
  Each `.info` string should briefly explain direction in plain language (e.g. minSpeech:
  "Lower = the preview starts showing text sooner after you begin speaking, but may also
  react to background noise more easily"; minSilence: "Lower = the preview breaks your speech
  into segments more eagerly during pauses").
- A "Reset to defaults" action mirroring the Silero section's, wired to
  `resetPreviewVadDefaults()`.
- No enable/disable toggle is needed — the live-preview overlay itself already has its own
  on/off setting elsewhere (`showOverlay`); this section only tunes sensitivity when the
  preview is in use.

Add both new i18n keys' strings to `src/locales/en/translation.json` and
`src/locales/pt/translation.json` (Requirement 10).

### Non-Negotiable Product Premises touchpoints

- **§3 Speed**: unaffected — this only tunes the live-preview fast path's segmentation
  timing; the authoritative offline pass (and its ≤500ms budget for tiny/base/GPU engines)
  is untouched. If anything, more responsive live-preview segmentation makes the perceived
  experience faster, not slower.
- **§6 Migration safety**: no migration needed (Requirement 11) — new keys/namespace only,
  nothing renamed or restructured.
- **§2 Performance**: no new timers/polling — this reuses the exact same request/response IPC
  pattern as the existing Silero config, invoked only when Settings are opened/changed and
  once at startup hydration; no idle-cost impact.

## Validation Plan

- **Automated**:
  - `test/helpers/previewVadConfig.test.js` (new): unit-tests the pure functions in
    `src/helpers/previewVadConfig.js` — `clampPreviewVadField` clamps out-of-range/invalid
    input to `LIMITS`, `sanitizePreviewVadConfig` fills missing fields from `DEFAULTS`, and
    `resolvePreviewVadConfig({})` returns the full default object with `minSpeechDurationMs:
    80` and `minSilenceDurationMs: 500` (asserts the exact validated experimental values are
    now the honest defaults, not silently-clamped ones).
  - Extend or add alongside `test/helpers/dictationBatchingIpc.test.js` (same
    `Module._load`-mocking harness already used there): a test that calls the
    `start-dictation-preview` handler with a `whisperVadSettings`/Silero config seeded with
    deliberately distinctive sentinel values (e.g. Silero `minSpeechDurationMs: 999`,
    `speechPadMs: 999`) and a distinct `previewVadSettings` (e.g. `minSpeechDurationMs: 80`),
    then asserts the `vadConfig` passed into `createDictationBatchingSession` (mock/spy the
    module-level `createDictationBatchingSession` the same way the existing test intercepts
    dependencies) matches the preview-VAD sentinel values and contains none of the Silero
    sentinel values — directly regression-locking "no user-set Silero value reaches the
    energy detector" (Design's stated correctness property) for all five previously-shared
    fields, not just the two now-exposed ones.
  - Update `test/helpers/whisperVadConfig.test.js`'s sibling coverage is not required (Silero
    behavior unchanged), but confirm via a quick read that no existing test in that file or
    `dictationBatchingSession.test.js` asserts the old borrow-from-Silero behavior in a way
    that would now be stale/misleading — if any does, update its comment/expectation to point
    at the new namespace instead of deleting coverage.
  - Run `node --test test/helpers/previewVadConfig.test.js test/helpers/dictationBatchingIpc.test.js test/helpers/dictationBatchingSession.test.js test/helpers/whisperVadConfig.test.js`.

- **Manual**:
  1. Open Settings → Speech-to-Text; confirm a new "Live Preview Sensitivity" section appears
     below "Voice Activity Detection", with two controls defaulting to 80ms/500ms and its own
     "Reset to defaults" action, and confirm the copy clearly distinguishes it from the Silero
     section above.
  2. With defaults, start a dictation with the live-preview overlay enabled, speak a full
     sentence with natural pauses/breaths, and confirm the overlay shows progressive
     committed/partial text during speech (not just a blank "Listening..." until release).
     Check debug logs for `[DEBUG] Dictation batching finalize` and confirm `coverageRatio` is
     meaningfully above 0 and `fastPath: true` for a normal utterance.
  3. Change "Live Preview Sensitivity"'s minSpeechDurationMs to a high value (e.g. 400ms),
     repeat step 2, and confirm the preview now reverts to showing little/no progressive text
     (proving the new setting actually reaches the detector) — then reset to defaults.
  4. Confirm changing the existing Silero "Voice Activity Detection" section's
     `minSpeechDurationMs`/`minSilenceDurationMs` values has no observable effect on the live
     preview's behavior (proving the decoupling), while still affecting the final offline
     transcription pass as before.
  5. Restart the app after changing the new settings and confirm they persist (localStorage +
     main-process hydration on startup) rather than reverting to defaults.

- **Docs**: update `CLAUDE.md`'s §16/17-adjacent area or wherever the Custom Dictionary/VAD
  settings are described (there's currently no dedicated CLAUDE.md subsection for the Silero
  VAD settings screen itself, so add a short new bullet under whichever section documents
  `whisperVadConfig.js`/`start-dictation-preview`, or under a new one) to mention the new,
  separate "Live Preview Sensitivity" settings and that they are intentionally independent of
  the Silero VAD section. Also update `docs/RECREATION_SPEC.md` if it documents the current
  (buggy, Silero-borrowing) `start-dictation-preview` config-building behavior, and update
  `docs/specs/audio-transcription-batching.md` only if it explicitly describes the config
  source for the energy VAD (a cross-reference pointer to this spec is sufficient if so — do
  not re-open its already-implemented design).

## Open Questions

None blocking — the core product decision (separate, visible UI controls; no silent override)
was already confirmed with the project owner in the conversation that produced this spec.
Non-blocking items left to executor judgment, called out explicitly in Design/Non-goals:
exact UI copy wording, and whether `speechPadMs`/`maxSpeechDurationS`/`samplesOverlap`'s new
fixed defaults (100ms/20s/0.3) need further live-tuning after this ships — flagged as
plausible follow-up but not required to land this fix, since they were not proven broken this
session (only `minSpeechDurationMs`/`minSilenceDurationMs` were).
