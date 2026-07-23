# Meeting/Note Recording: whisper.cpp `-tdrz` (tinydiarize) Investigation

## Status
Draft

## TL;DR
- This is an **investigation spec**, not a committed implementation. The user asked
  whether to adopt whisper.cpp's `-tdrz` (tinydiarize) flag for Meeting recordings and
  Note Recording, explicitly requested a compatibility check, and — on hearing the
  incompatibilities found — chose "investigate anyway: scope a follow-up spec to bundle
  a tdrz-finetuned model and evaluate replacing/merging it with the existing diarization
  pipeline." This document is that investigation and follow-up scoping.
- **Headline finding: `-tdrz` is not worth adopting as a replacement or merge target for
  the existing Meeting diarization pipeline.** It is a strictly weaker signal along
  every axis that matters for this product's actual Meeting/Note Recording use case:
  turn-boundary hints only, no speaker identity/naming, no cross-meeting persistence,
  English-only, whisper.cpp-only (silently inapplicable whenever Meeting local provider
  is Parakeet or a cloud realtime provider — a majority-relevant gap since Parakeet is
  the multilingual/GPU-accelerated default many users pick).
- Concrete findings (verified live this session via `gh api`/HuggingFace API, not
  assumed):
  1. **The bundled whisper.cpp fork's server genuinely supports tdrz.**
     `OpenWhispr/whisper.cpp` (per `scripts/download-whisper-cpp.js`) is a live fork of
     `ggml-org/whisper.cpp`, and its `examples/server/server.cpp` implements
     `-tdrz`/`--tinydiarize` fully, including a **per-HTTP-request** `tinydiarize` form
     field — no separate server binary or restart is needed to toggle it. It emits a
     literal `" [SPEAKER_TURN]"` marker inline in the transcript text. So the earlier
     "unconfirmed server support" concern is resolved: support exists.
  2. **No tdrz-finetuned model is bundled or registered today, and the only ones that
     exist are community-hosted, not official.** None of the six models in
     `modelRegistryData.json` support it. The only tdrz GGML model found is
     `akashmjn/tinydiarize-whisper.cpp` on HuggingFace — a single-file, English-only
     `small.en`-class model, last updated **2023**, from an independent community author,
     not `ggerganov`/`ggml-org`'s own model catalog (which hosts every model this project
     currently bundles). A second, even less established quantized repackaging exists
     (`mldsqc/tinydiarized-whisper_q5_q4`, 0 recorded downloads) but is not a credible
     primary source. Neither is currently allowlisted (`docs/network-allowlist.md`).
  3. Both available tdrz models are **English-only**, conflicting with Meeting/Note
     Recording's multilingual use (Parakeet's default model alone covers 25 languages).
  4. `-tdrz` only exists in the whisper.cpp code path. Meeting/Note Recording routes to
     Parakeet (`meetingLocalProvider === "nvidia"`, `ipcHandlers.js`) or a cloud realtime
     provider (`meetingRecordingStore.ts`) just as often as to local whisper — `-tdrz`
     would be silently unavailable in both those cases, and must degrade gracefully
     (Non-Negotiable Premise #5), never block core recording.
  5. The existing pipeline (`diarization.js` + `speakerEmbeddings.js`, pyannote
     segmentation + CAM++ speaker embeddings via the ONNX utility process, persisted to
     `speaker_profiles`/`speaker_mappings`/`note_speaker_embeddings` in `database.js`)
     already does real, named, cross-meeting speaker identity — tdrz's turn-only markers
     are a regression against this, not an upgrade.
- **Blocking open question for the project owner**: given the recommendation above, do
  you still want a follow-up implementation spec, and if so at what scope — (a) full
  replacement of the existing pipeline (not recommended — feature loss), (b) an
  experimental supplementary signal alongside the existing pipeline (narrow, low
  priority), or (c) drop the idea entirely? See Open Questions.
- Practical impact if the answer is "drop it" (the recommended path): no change to the
  app; Meeting/Note Recording keeps its current named-speaker diarization exactly as is.
  If the answer is "proceed anyway": a follow-up spec would need to source/host a tdrz
  model, add a gated, English-only, whisper-only, opt-in "experimental turn hints" UI
  surface that does not touch or replace the named-speaker pipeline.

## Problem / Goal
The user wants to know whether whisper.cpp's built-in `-tdrz` (tinydiarize) flag can
improve or replace Meeting recording / Note Recording's current speaker-diarization
story, and asked for an explicit compatibility check before proceeding. That check
surfaced multiple load-bearing incompatibilities (model availability, language coverage,
engine-routing coverage, and a large capability gap against the existing pipeline). The
user's explicit follow-up instruction was: investigate anyway, and scope a follow-up spec
for bundling a tdrz-finetuned model and evaluating replacing/merging it with the existing
diarization pipeline. This document is that scoped investigation, producing a
recommendation and (if the owner still wants to proceed) a concrete design for a narrow,
non-destructive follow-up.

## Requirements
Because this is an investigation/decision spec, its "requirements" are what the
investigation itself must establish and record, not application behavior:

- Confirm (not merely infer) whether the project's bundled whisper.cpp fork
  (`OpenWhispr/whisper.cpp`) actually implements `-tdrz`/`--tinydiarize` in its server,
  and whether any tdrz-compatible GGML model exists to pair with it — done via live
  `gh api`/HuggingFace API checks this session (see Design); confirmed yes on both counts,
  with the caveat that the only available model is a stale (2023), community-hosted,
  English-only single file, not an officially maintained model.
- Document tdrz's actual output format/capability (turn-boundary markers only, no
  speaker naming or identity) against the existing pipeline's actual capabilities
  (turn segmentation + persisted, named, cross-meeting speaker identity via voice
  embeddings) — done in Design below.
- Document the engine-routing gap: which Meeting/Note Recording provider configurations
  (`whisper` local vs. `nvidia`/Parakeet local vs. cloud realtime) `-tdrz` could ever
  apply to, and what "unavailable" must look like in each of the other cases (silent
  no-op per Premise #5, never an error/crash).
- Produce an explicit recommendation: adopt / don't adopt / adopt-narrowly-if-owner-
  insists, with justification.
- Surface the blocking decision to the project owner rather than silently picking a
  side effect and starting Design/implementation work.

## Non-goals
- This spec does not implement anything. No model is bundled, no registry entry is
  added, no UI is built, no IPC channel is added.
- This spec does not re-evaluate or redesign the existing embedding-based diarization
  pipeline (`diarization.js`/`speakerEmbeddings.js`/`liveSpeakerIdentifier.js`) beyond
  what's needed to compare it against `-tdrz`.
- This spec does not cover the sibling "dictation-language-detection-fix" spec being
  planned in parallel in this same worktree — that is a separate, unrelated piece of
  work and is not touched or referenced further here.
- If the owner ultimately says "proceed," this spec does not itself become the
  implementation spec — a follow-up spec (or an update to this one, re-titled/rescoped)
  would carry the actual Requirements/Design/Validation Plan for that narrower feature.

## Design

### What `-tdrz` actually is
whisper.cpp's tinydiarize mode is a lightweight, in-decoder turn-detection feature: a
specifically fine-tuned model (upstream ships an English-only `small.en`-class variant)
emits a special token when it predicts the speaker has changed. The server/CLI surfaces
this as a `[SPEAKER_TURN]`-style marker interleaved with the transcript text. It is:
- **Turn-detection only** — it marks *where* a change might have happened, not *who* is
  speaking. There is no speaker count, no naming, no voice fingerprint, and no way to
  recognize the same person across two different meetings.
- **Model-locked** — it requires a model specifically fine-tuned for the task; none of
  the six models in `src/models/modelRegistryData.json`'s `whisperModels` (`tiny`,
  `base`, `small`, `medium`, `large`, `turbo`) support it.
- **Server support is confirmed present.** This session's live check
  (`gh api repos/OpenWhispr/whisper.cpp/contents/examples/server/server.cpp`) confirms
  `OpenWhispr/whisper.cpp` — a live fork of `ggml-org/whisper.cpp`, per
  `gh api repos/OpenWhispr/whisper.cpp -q '.fork, .parent.full_name'` — implements
  `-tdrz`/`--tinydiarize` in full: a CLI flag, an equivalent per-HTTP-request
  `tinydiarize` form field (`server.cpp:541-543`), a mutual-exclusion check against
  whisper.cpp's own unrelated `--diarize` flag (`server.cpp:650-651`, not used by this
  project either way), and a literal `" [SPEAKER_TURN]"` text marker emitted inline
  (`server.cpp:117,439-441`). Because it's a per-request field, no separate server
  binary/restart would even be needed to toggle it — a real, if narrow, implementation
  affordance if the owner proceeds.
- **Model availability is confirmed, but the only source is a stale community repo.**
  A live HuggingFace API search this session (`huggingface.co/api/models?search=tdrz`)
  found no tdrz model in `ggerganov`/`ggml-org`'s own HF org (the org this project's
  official six whisper models come from). The only real option is
  `akashmjn/tinydiarize-whisper.cpp` (`ggml-small.en-tdrz.bin`), an independent
  community repo last updated in 2023, with a second, far less established quantized
  repackaging (`mldsqc/tinydiarized-whisper_q5_q4`, 0 recorded downloads at time of
  check). Neither is an official, actively maintained source comparable to this
  project's existing model provenance.
- **English-only** at the model level — both available tdrz models are `small.en`-class.
  This conflicts with Meeting/Note Recording's multilingual use (Parakeet's
  `parakeet-tdt-0.6b-v3` alone covers 25 languages, per `modelRegistryData.json`).
- **whisper.cpp-only.** `-tdrz` has no Parakeet or cloud-realtime-provider equivalent.

### What the existing pipeline actually is
`src/helpers/diarization.js` wraps a separate `sherpa-onnx-diarize` binary combining:
- `sherpa-onnx-pyannote-segmentation-3-0` (speech-boundary/turn segmentation model), and
- `3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx` (speaker-embedding/voiceprint
  model, run through the ONNX utility process via `src/helpers/speakerEmbeddings.js`).

This output feeds `src/helpers/mergeSpeakerTurns.js` (turn merging, `maxGapSec: 1.5`,
`maxTurnSec: 60`, `buildSpeakerLabels()`) and `src/helpers/liveSpeakerIdentifier.js`
(live, in-recording speaker identification). Speaker identity is persisted in
`database.js` across three tables: `speaker_profiles` (`display_name`, `email`,
`embedding`, `sample_count`), `speaker_mappings`, and `note_speaker_embeddings`, with
merge/dedupe logic (`mergeSpeakerProfiles()`) when two profiles turn out to be the same
person. This means: named speakers, persisted and re-recognized across separate
meetings, not just turn markers inside one recording.

**Feature-for-feature, `-tdrz` provides a strict subset of what this pipeline already
does** — turn boundaries only, with none of the naming/identity/persistence. It is not
an upgrade in any dimension; it would only be interesting as a cheap fallback signal in
a scenario the existing pipeline can't cover, and Design below evaluates that narrow
case.

### Engine-routing coverage gap
Meeting/Note Recording's local transcription provider is selectable per
`ipcHandlers.js` (`meetingLocalProvider === "nvidia"` routes to Parakeet, `~line 5492`)
and `meetingRecordingStore.ts`'s cloud-realtime-provider path (`~lines 131-148`,
`openai-realtime`/other streaming providers via `useStreamingProvidersStore`). `-tdrz`
can only ever apply when the Meeting/Note Recording local provider is whisper — never
Parakeet, never a cloud realtime provider. Per Non-Negotiable Premise #5 (graceful
degradation), any future gating logic must make this an invisible no-op (feature simply
doesn't fire; no error toast, no blocked recording) in the other two cases — mirroring
how `screenContextCapture` or other optional-binary features already degrade elsewhere
in this codebase.

### Recommendation
**Do not adopt `-tdrz` as a replacement for, or merge target into, the existing
diarization pipeline.** Server support turned out to be real and cheap to wire up (a
per-request flag, no rebuild needed) — but that doesn't change the outcome, because the
bottleneck was never server support. It regresses the primary Meeting/Note Recording
capability users actually rely on (named, persisted speaker identity) in exchange for a
coarser, English-only, whisper-only signal backed only by a stale, unofficial,
community-maintained model with no update history since 2023. There is no "combine the
two for a better result" story either: the existing pipeline already does its own turn
segmentation (pyannote), so tdrz's turn markers add no new information the current
pipeline is missing — they'd only be relevant as a fallback when the existing pipeline's
models are unavailable, which is an edge case with a much lower cost/benefit ratio than
the model-hosting/allowlisting and gating work required, especially given the model's
weak provenance.

**If the project owner still wants to proceed despite this recommendation** (per their
explicit "investigate anyway" instruction), the only shape worth scoping in a follow-up
spec is a narrow, additive, opt-in experimental mode:
- Gate: whisper.cpp local provider only, English-recording-only (validated against the
  meeting's configured language before offering the toggle), and only surfaced when the
  existing sherpa-onnx diarization models are *not* downloaded/available (i.e. tdrz
  turn-hints as a lightweight fallback rather than a competing signal against the real
  pipeline when both are present).
- Output would be additive metadata (raw turn markers) attached to the transcript
  segment, clearly and separately labeled from the existing `speaker_profiles`-backed
  named-speaker labels in the Notes UI — never silently merged into or overwriting the
  existing pipeline's speaker labels, to avoid presenting a low-confidence turn marker
  as if it were an identified speaker.
- This would require: (1) live-verifying `OpenWhispr/whisper.cpp`'s tdrz support and
  sourcing/hosting a compatible model with a `hfRepo`/`downloadUrl` registry entry
  (mirroring the existing `whisperModels` shape in `modelRegistryData.json`); (2) a new,
  narrowly-scoped `--tinydiarize`/`-tdrz` flag pass-through in whichever whisper-server
  invocation path Meeting/Note Recording uses; (3) gating logic per the routing-coverage
  section above; (4) a new `docs/network-allowlist.md` entry if a new download host is
  introduced; (5) parsing/surfacing the `[SPEAKER_TURN]` marker distinctly in the Notes
  transcript UI. None of this is designed further here — it is explicitly deferred to
  the follow-up spec the owner would need to request after answering the Open Question
  below.

## Validation Plan
**N/A for this investigation spec — no code changes are proposed here.** This is the
documented, reviewed exception CLAUDE.md's spec-driven workflow allows: the spec's
purpose is entirely to establish findings and a recommendation for the project owner to
act on, not to change application behavior. If the project owner directs a follow-up
implementation (either "merge as experimental fallback" from the Recommendation section,
or a full pipeline replacement against this recommendation), that follow-up work must go
through a new or updated spec carrying its own concrete Validation Plan — naming the
specific automated regression test files under `test/helpers/*.test.js` (e.g., a test
for the model-availability/language/provider gating logic, mirroring the pattern used by
`test/helpers/dictationRouting.test.js` for the analogous voice-agent routing decision,
and a test asserting the existing named-speaker pipeline's output is never overwritten by
tdrz turn markers) — per the "not testable is not a default" rule in CLAUDE.md.

- Docs: none require updating as a result of this spec landing at `Draft`/investigation
  stage. If a follow-up implementation spec is later approved and implemented, it must
  update `CLAUDE.md`'s §16 (Meeting Recording) and §20-adjacent diarization description,
  `docs/RECREATION_SPEC.md`'s §2.8 (Diarização), and `docs/network-allowlist.md` if a new
  model-hosting host is introduced.

## Open Questions
- **Blocking**: Given the recommendation above (do not adopt/merge `-tdrz`), does the
  project owner want a follow-up implementation spec anyway, and if so at what scope —
  (a) full replacement of the existing named-speaker pipeline (not recommended), (b) a
  narrow, opt-in, whisper-only, English-only experimental fallback signal that never
  overwrites named-speaker output (the only shape this investigation considers
  defensible), or (c) drop the idea?
- Not yet checked (out of scope for this pass, but relevant if the owner proceeds):
  whether the **prebuilt release binaries** this project actually downloads
  (`whisper-server-{platform}-cpu/cuda/vulkan.zip` assets, per
  `scripts/download-whisper-cpp.js`) were built from a source revision that includes the
  tdrz code confirmed in the fork's current `master` branch — release assets are zipped
  binaries, not inspectable source, so this can only be confirmed by running `--help` (or
  the per-request field) against an actual downloaded binary, not via the GitHub API.
- Given the model's weak provenance (single community author, unmaintained since 2023,
  0-download quantized derivative), would the project be comfortable bundling/hosting it
  at all, independent of the capability-gap argument above? This is a separate trust bar
  from the technical feasibility question.
- If proceeding with option (b) above: what UI treatment distinguishes an unverified
  turn-marker hint from the existing pipeline's confident named-speaker labels, so users
  don't mistake one for the other in the Notes transcript view?
