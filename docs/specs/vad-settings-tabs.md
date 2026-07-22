# VAD Settings: Live/Silero Tabs + Full Live-Preview Parameter Exposure

## Status
Implemented

## TL;DR
Follow-up to `docs/specs/live-preview-vad-sensitivity.md` (implemented, same PR #25). The
project owner asked for two things: (1) restructure Settings → Speech-to-Text → Dictation's
stacked "Voice Activity Detection" (Silero, final transcription) + "Live Preview Sensitivity"
(energy VAD, live overlay) sections into two tabs, "Live" and "Voice Activity Detection"; (2)
inside "Live," expose every genuinely tunable parameter the energy detector consumes, not just
the 2 fields the prior spec exposed.

- Reuses this file's own existing `ProviderTabs`/`useSubTab`/`TabPanel` sub-tab pattern
  (already used for the Dictation/Note Recording/Upload split) — no new tab primitive.
- Only the Dictation sub-tab's VAD area is restructured. The Note Recording sub-tab's
  standalone Silero section (meeting/note-recording toggles) is untouched — out of scope per
  the prior spec's non-goals, unaffected by this one.
- Read the energy detector's actual constructor (`dictationBatchingSession.js`): of the 11
  fields it consumes, 10 are genuine independent tunable knobs worth exposing —
  `minSpeechDurationMs`, `minSilenceDurationMs` (already exposed), `speechPadMs`,
  `maxSpeechDurationS`, `samplesOverlap` (previously fixed constants, now promoted to
  user-facing controls), plus `energyThreshold`, `minSegmentRms`, `noiseFloorFactor`,
  `noiseFloorAlpha`, `maxMerges`, `maxMergedMs`. Only `tailFinalizeBudgetMs` is excluded — a
  fixed internal latency safety margin protecting the sub-500ms Speed premise, not a
  detection-quality knob; exposing it risks a user silently blowing that budget. (An earlier
  draft of this spec also excluded `noiseFloorAlpha` on "too technical to explain" grounds —
  that repeated the exact "users have no basis to tune this" judgment the owner just overrode
  for `speechPadMs`/`maxSpeechDurationS`/`samplesOverlap` in the prior spec, and it doesn't
  clear a bar the included `maxMerges`/`maxMergedMs` don't already clear, so it's exposed here
  too, broadly per the owner's instruction — see Open Questions for the one non-blocking
  judgment call left open.) Silero's `threshold` field is confirmed NOT read by the energy
  detector's constructor at all, so there is no 12th field hiding there.
- All new fields default to today's exact hardcoded constants — no runtime behavior change on
  upgrade, no migration needed (CLAUDE.md §6 does not trigger).
- No blocking open question — restructure direction and "expose all relevant" were both
  explicit instructions from the project owner.
- User impact: Settings → Speech-to-Text → Dictation shows two tabs, "Live" and "Voice
  Activity Detection," instead of two stacked sections. "Live" now has 9 tunable fields
  (up from 2) with plain-language explanations, letting an advanced user tune the live
  preview's noise floor, merge/segmentation, and pre/post-roll behavior directly instead of
  only its two timing thresholds.

## Problem / Goal

The prior spec deliberately kept `speechPadMs`, `maxSpeechDurationS`, `samplesOverlap` (VAD-shape
fields shared with Silero's config shape) and `energyThreshold`, `minSegmentRms`,
`noiseFloorFactor`, `noiseFloorAlpha`, `maxMerges`, `maxMergedMs` (pure `DictationBatchingSession`
constants) out of the UI, reasoning a typical user has "no real basis to tune them for an
invisible preview detector." The project owner has since explicitly asked for the opposite:
give the user every relevant knob, laid out as two tabs so "Live" (energy VAD) and "Voice
Activity Detection" (Silero, final pass) read as clearly parallel, switchable options rather
than one section stacked under the other with a wall of text distinguishing them.

Today's stacked-sections layout (`renderWhisperVadSettings()` then `renderPreviewVadSettings()`,
both called unconditionally back-to-back inside `SpeechToTextTabs`'s `renderDictation` render
prop — `src/components/SettingsPage.tsx` lines ~2883-2886) also makes the "Live" section easy to
miss below the denser 6-field Silero grid above it.

Goal: (a) present the two sections as tabs instead of stacked blocks; (b) expose every
independently-meaningful energy-VAD parameter as a user-facing control inside the "Live" tab,
with plain-language copy per field; (c) do this without any settings migration or behavior
change for users who don't touch the new controls.

## Requirements

1. Inside the Dictation sub-tab of `SpeechToTextTabs` (where both VAD sections currently
   render), replace the current stacked `renderWhisperVadSettings()` /
   `renderPreviewVadSettings()` sequence with a two-tab control: "Live" and "Voice Activity
   Detection," using this codebase's existing `ProviderTabs` + `TabPanel` + `useSubTab` pattern
   (the same one `SpeechToTextTabs`/`LlmsTabs` already use one level up) — not a new tab
   component, not the generic shadcn `Tabs` primitive in `src/components/ui/tabs.tsx` (confirm
   during implementation whether `ui/tabs.tsx` is unused dead code or used elsewhere; either
   way, do not introduce it here since `ProviderTabs` is this file's established sibling-tab
   convention).
2. "Live" tab shows `renderPreviewVadSettings()`'s content (expanded per Requirement 3); "Voice
   Activity Detection" tab shows `renderWhisperVadSettings()`'s content, unchanged in content
   and behavior from today.
3. The "Live" tab's `renderPreviewVadSettings()` gains 8 new user-facing controls, in addition
   to the 2 existing ones (`minSpeechDurationMs`, `minSilenceDurationMs`):
   - `speechPadMs` (ms) — pre-roll kept before a confirmed speech onset.
   - `maxSpeechDurationS` (s) — forced-cut ceiling for one continuous utterance.
   - `samplesOverlap` (0-0.95 fraction) — audio overlap carried across a forced cut.
   - `energyThreshold` (0-1 RMS) — absolute floor a frame's volume must clear to count as
     voiced, before the adaptive noise-floor term is applied.
   - `minSegmentRms` (0-1 RMS) — minimum overall loudness a closed segment must have to be
     sent for transcription at all (below this, it's dropped silently as likely near-silence).
   - `noiseFloorFactor` (multiplier) — how far above the room's adaptively-tracked ambient
     noise level a frame's volume must rise to count as voiced.
   - `noiseFloorAlpha` (0-1 smoothing rate) — how quickly the detector's ambient-noise
     estimate adapts to a changing environment; higher reacts faster to a room getting
     louder/quieter but is noisier itself.
   - `maxMerges` (integer count) — how many times a low-confidence utterance may be deferred
     and merged into the next one before being committed as-is.
   - `maxMergedMs` (ms) — hard ceiling on how long a merged/deferred audio chain may grow.
4. Only `tailFinalizeBudgetMs` remains a fixed internal constant, not exposed — see TL;DR
   bullet and Design rationale for why this one field specifically is excluded while the other
   8 are promoted. (`noiseFloorAlpha` is exposed, not excluded — see Requirement 3.)
5. `src/constants/previewVad.json`'s `DEFAULTS`/`LIMITS` are extended with entries for all 8
   newly-exposed fields. `tailFinalizeBudgetMs` is NOT added to this file — it stays solely in
   `dictationBatchingSession.js`'s own `DEFAULTS`, never becomes settings-configurable even
   internally, since exposing it anywhere risks a future accidental UI surface for a
   safety-budget constant.
6. Every new field's shipped default in `previewVad.json`/`previewVadConfig.js` exactly equals
   `dictationBatchingSession.js`'s current hardcoded `DEFAULTS` constant for that field
   (`energyThreshold: 0.006`, `minSegmentRms: 0.003`, `noiseFloorFactor: 3`,
   `noiseFloorAlpha: 0.05`, `maxMerges: 2`, `maxMergedMs: 20000`) — not the prior spec's
   already-decoupled `speechPadMs: 100`/`maxSpeechDurationS: 20`/`samplesOverlap: 0.3` values,
   which stay as-is (those three were already given honest, already-shipped defaults by the
   prior spec; this spec only adds the UI control for them, it does not change their default).
7. `src/helpers/ipcHandlers.js`'s `start-dictation-preview` handler passes ALL properties
   `resolvePreviewVadConfig()` returns straight through to `createDictationBatchingSession`'s
   constructor options (both the `vadConfig`-shaped fields consumed via the `vad` sub-object —
   `speechPadMs`, `maxSpeechDurationS`, `samplesOverlap`, alongside the already-passed
   `minSpeechDurationMs`/`minSilenceDurationMs` — and the top-level constructor options
   `energyThreshold`, `minSegmentRms`, `noiseFloorFactor`, `noiseFloorAlpha`, `maxMerges`,
   `maxMergedMs`) — read the current handler code precisely before changing it, since the two
   groups are consumed through different code paths in the constructor (`vad =
   {...DEFAULT_WHISPER_VAD_CONFIG, ...options.vadConfig}` vs. direct `options.<field>`) and
   must be threaded to the right one.
8. `src/stores/settingsStore.ts` gains the same read/clamp/persist/setter/reset/startup-push
   pattern already used for the 2 existing preview-VAD fields, for each of the 8 new fields —
   new localStorage keys, new store fields, new setter actions, folded into the existing
   `resetPreviewVadDefaults()` and the existing startup `setPreviewVadConfig(...)` push (extend
   the object literal, not a second push call).
9. `preload.js`/`src/types/electron.ts` need no new IPC channels — the existing
   `getPreviewVadConfig`/`setPreviewVadConfig` pair already carries a config object; only the
   object's shape grows.
10. i18n: every new field's label + info string gets a key in both
    `src/locales/en/translation.json` and `src/locales/pt/translation.json`, under
    `settingsPage.transcription.previewVad.fields.*`, matching the existing 2 fields' key
    shape (`.label`, `.info`). New keys are also needed for the two new tab labels (e.g.
    `settingsPage.speechToText.vadTabs.live` / `.silero` — exact key names are an
    implementation detail, but must exist in both locale files).
11. Migration safety (CLAUDE.md §6): confirmed no migration needed — every new field is a
    brand-new localStorage key with a default equal to today's already-running constant (see
    Requirement 6); no existing key is renamed or reinterpreted. Validation Plan must assert
    this explicitly (see below).
12. The "Reset to defaults" action already present under the "Live" tab must reset all 10
    fields (2 existing + 8 new), not just the original 2.
13. `test/helpers/previewVadConfig.test.js` is extended to cover clamping/defaults for every
    newly-exposed field, including `noiseFloorAlpha`.
14. A regression test proves `start-dictation-preview`'s constructed `DictationBatchingSession`
    options contain zero Silero-sourced values across the full newly-expanded field set — not
    just the 5 fields the prior spec's equivalent test covered — even though today's code
    already keeps these fields architecturally separate (pure `DictationBatchingSession.DEFAULTS`
    constants, never derived from Silero), this closes the loop for the newly-exposed set and
    guards against a future accidental re-introduction of Silero fallthrough for any of them.
15. A component-level UI test proves the two-tab restructure renders both tabs, defaults to a
    stable tab (matching the existing `useSubTab`/localStorage-persisted-tab convention already
    used for `SpeechToTextTabs`/`LlmsTabs`), and switching tabs shows/hides the correct section
    content — see Validation Plan for the exact test file and assertions, and why this is
    feasible given this repo's existing `test/components/*.test.js` + `@testing-library/react`
    infrastructure (this is NOT a "no automated test possible" case).

## Non-goals

- Do not touch the Note Recording sub-tab's standalone Silero VAD section
  (`renderNoteRecording`'s own `renderWhisperVadSettings()` call) — it has no "Live" equivalent
  (no live-preview overlay exists for note recording) and stays a single, non-tabbed section
  exactly as today.
- Do not touch the Silero "Voice Activity Detection" tab's own fields, schema
  (`whisperVad.json`), IPC channels, or behavior — its content moves into a tab wrapper
  unchanged, nothing about what it does or how it's stored changes.
- Do not re-litigate the prior spec's decoupling design (separate namespace, separate IPC,
  separate resolver) — this spec only (a) changes the visual container from two stacked
  sections to two tabs, and (b) extends the set of fields `previewVad.json`/
  `previewVadConfig.js`/the renderer store expose, following that exact same established
  pattern.
- Do not expose `noiseFloorAlpha` or `tailFinalizeBudgetMs` as UI controls (Requirement 4) —
  if real-world tuning need surfaces later, that's separate future work with its own spec.
- Do not change `DEFAULT_WHISPER_VAD_CONFIG`/Silero's own default values.
- Do not add a third tab or restructure Note Recording/Upload's existing tab set.

## Design

### Current state

`src/components/SettingsPage.tsx`:
- Lines ~437-482: `SpeechToTextTabs` renders a `ProviderTabs` bar (`dictation` /
  `noteRecording` / `upload`) driven by `useSubTab<SpeechTab>("settings.speechToTextTab",
  SPEECH_TABS, initialTab)`, then a `TabPanel` per tab showing the render-prop content.
- Lines ~2883-2886: inside the `dictation` tab's render prop, `renderWhisperVadSettings()` and
  `renderPreviewVadSettings()` are called back-to-back (both gated on
  `transcriptionMode === "local"`; Silero additionally gated on
  `localTranscriptionProvider !== "nvidia"`) — two stacked `<div>` sections, no visual tab
  separation.
- Lines ~1211-1348: `renderWhisperVadSettings()` — Silero toggles (dictation/note-recording/
  meeting/AEC) plus a 6-field grid (`threshold`, `minSpeechDurationMs`,
  `minSilenceDurationMs`, `maxSpeechDurationS`, `speechPadMs`, `samplesOverlap`) and a reset
  button.
- Lines ~1350-1405: `renderPreviewVadSettings()` — a 2-field grid (`minSpeechDurationMs`,
  `minSilenceDurationMs`) and a reset button.

`src/helpers/dictationBatchingSession.js`'s constructor (lines ~96-159) consumes, from
`options`: `transcribe`, `onCommit`, `onPartial`, `onError`, `isLowQuality` (callbacks, not
settings), `sampleRate`, `frameMs` (fixed, not user-relevant — untouched by either spec),
`energyThreshold`, `minSegmentRms`, `noiseFloorFactor`, `noiseFloorAlpha`, `maxMerges`,
`maxMergedMs`, `tailFinalizeBudgetMs` (all `?? DEFAULTS.<field>` top-level options), plus
`options.vadConfig` merged with `DEFAULT_WHISPER_VAD_CONFIG` and read as `vad.minSpeechDurationMs`,
`vad.minSilenceDurationMs`, `vad.speechPadMs`, `vad.maxSpeechDurationS` (×1000 → ms), and
`vad.samplesOverlap` (× sampleRate → sample count). Confirmed: no `vad.threshold` read anywhere
in this file — Silero's probability threshold has no energy-detector equivalent, consistent
with the prior spec's note that it's "harmless" when spread through, and confirms the TL;DR
claim that there is no hidden 12th tunable field.

`src/helpers/ipcHandlers.js`'s `start-dictation-preview` handler currently (post prior-spec
implementation) does:
```
const energyVadConfig = this._resolvePreviewVadOptions();
```
and passes `{ vadConfig: energyVadConfig, ... }` to `createDictationBatchingSession`. Today
`energyVadConfig` only carries the 5 `vad`-shaped fields (2 exposed + 3 fixed); the 6
top-level constructor options (`energyThreshold` etc.) are not passed at all today, so
`DictationBatchingSession` falls through to its own internal `DEFAULTS` for them — which is
exactly why Requirement 6's "defaults must match today's constants" matters: once this spec
starts threading them through explicitly, the values must be identical to what silently applies
today, or existing users get an unintended behavior change purely from this settings-exposure
work landing.

### Tab restructure

Add a new tiny wrapper component in `SettingsPage.tsx`, `DictationVadTabs`, following the exact
shape of `SpeechToTextTabs`/`LlmsTabs`, but declared as a **named export**
(`export function DictationVadTabs(...)`) rather than only being used internally — this is
what makes the component test in the Validation Plan tractable without a full `SettingsPage`
render:
- `const [tab, setTab] = useSubTab<"live" | "silero">("settings.dictationVadTab", ["live",
  "silero"], initialTab)` — a new, separate localStorage-backed sub-tab key, independent of
  `settings.speechToTextTab`, so remembering which VAD tab was last open doesn't collide with
  remembering which top-level sub-tab (dictation/noteRecording/upload) was last open.
- Renders a `ProviderTabs` bar with two entries (`live`, `silero`), reusing `renderIcon` in the
  same style as the existing tab bars (e.g. an icon conveying "live/real-time" vs. a
  waveform/settings icon for Silero — exact icon choice left to implementation, must exist in
  the `lucide-react` set already imported in this file).
- `<TabPanel active={tab === "live"}>{renderPreviewVadSettings()}</TabPanel>` and
  `<TabPanel active={tab === "silero"}>{renderWhisperVadSettings()}</TabPanel>`.
- Default tab: `"live"` — surfaces the newly-expanded, previously-easy-to-miss section first,
  consistent with the project owner naming "Live" first in their request.

Replace the current call site (SpeechToTextTabs's `renderDictation`, lines ~2883-2886):
```
{transcriptionMode === "local" && (
  <DictationVadTabs
    renderPreviewVadSettings={renderPreviewVadSettings}
    renderWhisperVadSettings={
      localTranscriptionProvider !== "nvidia" ? renderWhisperVadSettings : undefined
    }
  />
)}
```
`DictationVadTabs` must handle the case where `renderWhisperVadSettings` is `undefined`
(nvidia/Parakeet local provider — Silero doesn't apply): render only the "Live" tab with no
tab bar at all in that case (a single section, matching today's behavior when the Silero
section is conditionally absent), rather than showing an empty/disabled "Voice Activity
Detection" tab.

The `noteRecording` sub-tab's own `renderWhisperVadSettings()` call (line ~2894) is untouched —
it does not go through `DictationVadTabs`.

### Extending `previewVad.json` / `previewVadConfig.js`

`src/constants/previewVad.json` becomes:
```json
{
  "DEFAULTS": {
    "minSpeechDurationMs": 80,
    "minSilenceDurationMs": 500,
    "speechPadMs": 100,
    "maxSpeechDurationS": 20,
    "samplesOverlap": 0.3,
    "energyThreshold": 0.006,
    "minSegmentRms": 0.003,
    "noiseFloorFactor": 3,
    "noiseFloorAlpha": 0.05,
    "maxMerges": 2,
    "maxMergedMs": 20000
  },
  "LIMITS": {
    "minSpeechDurationMs": { "min": 20, "max": 500, "round": true },
    "minSilenceDurationMs": { "min": 100, "max": 2000, "round": true },
    "speechPadMs": { "min": 0, "max": 500, "round": true },
    "maxSpeechDurationS": { "min": 5, "max": 60, "round": true },
    "samplesOverlap": { "min": 0, "max": 0.95, "round": false },
    "energyThreshold": { "min": 0.001, "max": 0.05, "round": false },
    "minSegmentRms": { "min": 0.0005, "max": 0.05, "round": false },
    "noiseFloorFactor": { "min": 1, "max": 10, "round": false },
    "noiseFloorAlpha": { "min": 0.01, "max": 0.5, "round": false },
    "maxMerges": { "min": 0, "max": 10, "round": true },
    "maxMergedMs": { "min": 5000, "max": 60000, "round": true }
  }
}
```
`energyThreshold`/`minSegmentRms`/`noiseFloorFactor` bounds are chosen as a generous-but-sane
range around today's constants (matching the reasoning style of the existing `speechPadMs`/
`maxSpeechDurationS` bounds — wide enough to be genuinely adjustable, narrow enough to prevent
a value that breaks detection entirely, e.g. `energyThreshold` capped well below 1.0 since RMS
values above ~0.05 are already unusually loud speech). `tailFinalizeBudgetMs` is deliberately
NOT added here (Requirement 5) — it never enters this schema.

`src/helpers/previewVadConfig.js` needs no structural change — `clampPreviewVadField`,
`sanitizePreviewVadConfig`, `resolvePreviewVadConfig` are already generic over
`Object.keys(DEFAULTS)`, so adding keys to the JSON file is sufficient; only the JSON file
changes.

### `ipcHandlers.js` — threading the new fields to the constructor

The `start-dictation-preview` handler must pass `resolvePreviewVadConfig()`'s full 11-field
object into `createDictationBatchingSession`'s options such that:
- `vadConfig: { minSpeechDurationMs, minSilenceDurationMs, speechPadMs, maxSpeechDurationS,
  samplesOverlap }` (the 5 `vad`-shaped fields, exactly as passed today for the 2 already-live
  ones, now also including the 3 previously-fixed ones), and
- `energyThreshold, minSegmentRms, noiseFloorFactor, noiseFloorAlpha, maxMerges, maxMergedMs`
  spread as top-level constructor options (new — not passed at all today).
Read the exact current handler code (post prior-spec merge) before implementing this split to
avoid clobbering any other option already being passed (e.g. `transcribe`, `onCommit`,
`onPartial`, `onError`, `isLowQuality`, `sampleRate`, `frameMs`).

### `settingsStore.ts` — new fields

For each of the 8 newly-exposed fields, add (mirroring the existing `previewVadMinSpeechDurationMs`
pattern at the referenced line numbers in the prior spec):
- A `LIMITS`-driven `clampPreviewVadValue(key, value)` call against the corresponding new
  `previewVad.json` entry (reuse the existing helper — it's already generic over key).
- A new store field + localStorage key: `previewVadSpeechPadMs`, `previewVadMaxSpeechDurationS`,
  `previewVadSamplesOverlap`, `previewVadEnergyThreshold`, `previewVadMinSegmentRms`,
  `previewVadNoiseFloorFactor`, `previewVadNoiseFloorAlpha`, `previewVadMaxMerges`,
  `previewVadMaxMergedMs` — each read via `readString(key,
  String(previewVadConstants.DEFAULTS.<field>))` + clamp, so a missing/corrupt value falls
  back to this namespace's own default, never Silero's.
- A setter action per field (`setPreviewVadSpeechPadMs(next)` etc.), each: clamp →
  `localStorage.setItem` → `useSettingsStore.setState` → `window.electronAPI?.setPreviewVadConfig?.({
  ...allTenPreviewVadFields })` (send the full object each time, matching the existing 2-field
  setters' behavior of sending the complete config, not a partial patch — confirm this against
  the actual current setter code and follow whichever pattern it already uses).
- `resetPreviewVadDefaults()` extended to reset all 10 fields (2 existing + 8 new) to
  `previewVadConstants.DEFAULTS`.
- The existing startup-hydration push (around the line pushing
  `{ minSpeechDurationMs, minSilenceDurationMs }` via `setPreviewVadConfig`) extended to include
  all 10 fields in that same object literal.

### Settings UI — expanded "Live" tab content

`renderPreviewVadSettings()`'s existing 2-field grid (lines ~1358-1393) grows to a 10-field grid
(same `grid-cols-1 sm:grid-cols-2` layout, same `VADLabelWithInfo` + `Input` component pair used
throughout both sections today), in this order (matching Requirement 3's list): existing
`minSpeechDurationMs`, `minSilenceDurationMs`, then new `speechPadMs`, `maxSpeechDurationS`,
`samplesOverlap`, `energyThreshold`, `minSegmentRms`, `noiseFloorFactor`, `noiseFloorAlpha`,
`maxMerges`, `maxMergedMs`. `Input` `step`/`min`/`max` props per field mirror that field's
`previewVad.json` `LIMITS` entry (matching how the existing 2 fields' `Input` props already
mirror their `LIMITS`).

New i18n keys under `settingsPage.transcription.previewVad.fields.<field>.label` / `.info` for
all 8 new fields, e.g. (exact copy is an implementation/UI-copy call, but must convey the
following facts, one plain sentence each):
- `speechPadMs.info`: "How much audio just before your speech is kept, so the start of a
  sentence isn't clipped."
- `maxSpeechDurationS.info`: "The live preview will force-cut and start a new segment if you
  speak continuously longer than this, without pausing."
- `samplesOverlap.info`: "How much audio is repeated across a forced cut, so a word split
  across the cut isn't lost."
- `energyThreshold.info`: "The minimum loudness a moment of audio must reach to be treated as
  speech at all. Lower catches quieter speech but may also catch background noise."
- `minSegmentRms.info`: "A whole recognized segment quieter than this is dropped instead of
  being sent for transcription, to avoid transcribing near-silence."
- `noiseFloorFactor.info`: "How far above your room's background noise level your voice must
  rise to count as speech. Lower is more sensitive in noisy rooms but may pick up more noise."
- `noiseFloorAlpha.info`: "How quickly the detector updates its sense of your room's background
  noise level. Higher reacts faster to a room getting louder or quieter, but can make the
  detector itself less steady moment to moment."
- `maxMerges.info`: "How many low-confidence phrases in a row may be combined with the next one
  before being accepted as-is."
- `maxMergedMs.info`: "The longest a combined/merged stretch of speech is allowed to grow before
  being finalized regardless."

New tab-label i18n keys: `settingsPage.speechToText.vadTabs.live` (e.g. "Live"),
`settingsPage.speechToText.vadTabs.silero` (e.g. "Voice Activity Detection").

All added to `src/locales/en/translation.json` and `src/locales/pt/translation.json`.

### Non-Negotiable Product Premises touchpoints

- **§3 Speed**: `tailFinalizeBudgetMs` is deliberately excluded from any settings surface
  (Requirement 4) specifically to protect the sub-500ms raw-transcription budget from being
  loosened by a user; nothing else in this spec touches the transcription pipeline's timing
  budget — it only exposes/threads pre-existing tunable constants that already run today.
- **§6 Migration safety**: every new field is a brand-new key with a default equal to today's
  already-running constant (Requirement 6) — no rename, no schema restructure, no data loss
  risk. Validation Plan includes an explicit assertion of this.
- **§2 Performance**: no new timers, IPC channels, or polling — reuses the existing
  `preview-vad-get-config`/`preview-vad-set-config` request/response pair with a larger payload
  object; no idle-cost impact.

## Validation Plan

- **Automated**:
  - Extend `test/helpers/previewVadConfig.test.js`: add cases asserting
    `clampPreviewVadField` clamps each of the 8 new fields to their `LIMITS` (values below
    min, above max, non-finite/missing → falls back to that field's `DEFAULTS` entry), that
    `sanitizePreviewVadConfig({})` returns all 11 fields (including `noiseFloorAlpha`) matching
    `DEFAULT_PREVIEW_VAD_CONFIG`, and — the explicit migration-safety assertion (Requirement
    11) — that `DEFAULT_PREVIEW_VAD_CONFIG.energyThreshold === 0.006`,
    `.minSegmentRms === 0.003`, `.noiseFloorFactor === 3`, `.noiseFloorAlpha === 0.05`,
    `.maxMerges === 2`, `.maxMergedMs === 20000` (byte-for-byte equal to
    `dictationBatchingSession.js`'s own `DEFAULTS` constants, proving no behavior change for a
    user who never touches the new controls).
  - Extend the existing `dictationBatchingIpc.test.js` Silero-non-leak test (added by the prior
    spec) to also seed distinctive Silero sentinel values for `threshold` and assert none of
    the now-10 preview-VAD fields inherit it, and add a new assertion that
    `createDictationBatchingSession` receives `energyThreshold`/`minSegmentRms`/
    `noiseFloorFactor`/`noiseFloorAlpha`/`maxMerges`/`maxMergedMs` as top-level options (not
    nested under `vadConfig`) with values taken from a distinctive `previewVadSettings`
    fixture, proving the handler threads the two field groups (`vadConfig`-nested vs.
    top-level) to the correct constructor slots per Design.
  - New component test `test/components/dictationVadTabs.test.js` (same
    `--import ./test/setup/tsxRegister.js` + `@testing-library/react` harness already used by
    `test/components/TranscriptionPreviewOverlay.test.js`). To keep this tractable,
    `DictationVadTabs` must be a **named export** from `SettingsPage.tsx` (not a
    function-scoped-only helper), so the test can `require("../../src/components/SettingsPage.tsx").DictationVadTabs`
    and render it directly with a minimal, locally-defined
    `renderPreviewVadSettings`/`renderWhisperVadSettings` stub pair (e.g. each returning a
    `<div>` with distinctive test text) — not a full `SettingsPage` render, which would need
    i18n provider, store, and `electronAPI` stubbing well beyond what this interaction test
    needs to prove. Asserts: (a) both "Live" and "Voice Activity Detection" tab buttons
    render, (b) "Live"'s stub content is visible and Silero's stub content is not, on initial
    render (default tab), (c) clicking the "Voice Activity Detection" tab button shows
    Silero's stub content and hides "Live"'s, (d) when `renderWhisperVadSettings` is not
    passed (nvidia/Parakeet case), no tab bar renders and only "Live"'s stub content shows.
    This is feasible, not a "no automated test possible" exception — this repo already has
    working RTL + tsx-register infra for exactly this kind of interaction test.
  - Run: `node --test test/helpers/previewVadConfig.test.js test/helpers/dictationBatchingIpc.test.js test/helpers/dictationBatchingSession.test.js` and `node --test --import ./test/setup/tsxRegister.js test/components/*.test.js`.

- **Manual**:
  1. Open Settings → Speech-to-Text → Dictation (local Whisper, non-Parakeet provider) and
     confirm two tabs, "Live" and "Voice Activity Detection," appear where the two stacked
     sections used to be; "Live" is selected by default and shows 10 fields (up from 2) with a
     "Reset to defaults" button.
  2. Click "Voice Activity Detection" and confirm the existing Silero toggles/6-field grid
     render unchanged from before this change.
  3. Switch `localTranscriptionProvider` to Parakeet/nvidia and confirm only "Live" content
     shows, with no tab bar (since Silero doesn't apply to that provider).
  4. With all 10 "Live" fields at their (new) defaults, run a live dictation and confirm
     behavior is identical to before this change (progressive preview text still appears as it
     did after the prior spec shipped) — proving the new pass-through wiring didn't
     accidentally change any default-path behavior.
  5. Change `energyThreshold` to a much higher value (e.g. 0.03), attempt a live dictation at
     normal speaking volume, and confirm the preview now shows little/no progressive text
     (proving the newly-exposed field actually reaches the detector) — then reset to defaults.
  6. Restart the app after changing several "Live" tab values and confirm all 10 persist
     (localStorage + main-process hydration), not just the original 2.
  7. Go to Settings → Speech-to-Text → Note Recording and confirm its Silero VAD section is
     still a single, non-tabbed section, unaffected by this change.

- **Docs**: update `CLAUDE.md`'s note about the Live Preview Sensitivity settings (added by the
  prior spec, if a bullet was added — otherwise wherever `previewVadConfig.js`/
  `start-dictation-preview` is documented) to mention the tab restructure and the now-10-field
  set. Update `docs/RECREATION_SPEC.md` if it documents the current 2-field/stacked-sections
  state. `docs/specs/live-preview-vad-sensitivity.md` should get a one-line pointer/cross-
  reference to this spec noting its "3 fields fixed, 6 constants out of scope" decisions were
  superseded here (do not otherwise edit that already-`Implemented` spec's content).

## Open Questions

None blocking. Left to executor judgment: exact icon choice for the two new tab buttons, and
exact final UI copy wording for the 8 new field `.info` strings (facts to convey are specified
above). One non-blocking judgment call the project owner may want to weigh in on rather than
leaving entirely to the executor: this draft exposes `noiseFloorAlpha` as a 10th user-facing
control (an earlier draft had excluded it as "too technical," which repeated the exact
"users have no basis to tune this" judgment the owner explicitly overrode for
`speechPadMs`/`maxSpeechDurationS`/`samplesOverlap` in the prior spec — see TL;DR/Requirement
3's rationale for why it's included here instead). If, on review, the owner still feels
`noiseFloorAlpha` specifically is too deep an internal knob despite that reasoning, say so when
approving and it reverts to a fixed constant (a one-line change, not a redesign) — otherwise
the 10-field set above stands.
