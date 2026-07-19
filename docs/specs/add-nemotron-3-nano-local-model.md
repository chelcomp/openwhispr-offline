# Add NVIDIA Nemotron Local GGUF Model Options

## Status

Implemented

## TL;DR

Adds two new local-model entries to `src/models/modelRegistryData.json`, both served entirely on-device via llama.cpp like every other local model already in the registry:

- `NVIDIA-Nemotron-3-Nano-4B` (GGUF, ~2.84GB, Q4_K_M) under a new `nvidia` provider block, reusing the existing ChatML `promptTemplate` already used by `qwen`/`deepseek`.
- `Llama-3.1-Nemotron-Nano-8B-v1` (GGUF, `bartowski/nvidia_Llama-3.1-Nemotron-Nano-8B-v1-GGUF`, ~4.92GB, Q4_K_M) added to the **existing** `llama` provider block (not a new provider) — it's a Llama-3.1 finetune, so it reuses the existing Llama-3 `promptTemplate` string already used by the other three `llama` entries.
- **Explicit constraint for both**: only models with **>2B parameters and <5GB (Q4_K_M) file size** qualify for this addition — both entries satisfy it (4B params/~2.84GB; 8B params/~4.92GB, safely under the 5GB ceiling despite the higher param count due to quantization).
- Both set `supportsThinking: true`, reusing the existing thinking-suppression mechanism — no new code path for `<think>`/`</think>` tags.
- Pure data/config addition: no new IPC channel, no new settings key, no new download script, no schema change.
- No blocking open question — exact byte-exact file sizes, repo paths, and filenames must be re-verified against the live HuggingFace pages at execution time (HF listings can change), but this doesn't block approval of the design.
- Practical impact: users browsing Settings → AI Models → Local will see two new downloadable local model options — "Nemotron 3 Nano 4B" (new NVIDIA section) and "Llama 3.1 Nemotron Nano 8B" (existing Meta Llama section) — selectable for dictation cleanup / dictation agent / note formatting / chat intelligence, running fully offline after the one-time HF download.

## Problem / Goal

EktosWhispr's local model registry (`src/models/modelRegistryData.json` → `localProviders`) currently offers Qwen, Mistral, Llama, DeepSeek, and Gemma families but no NVIDIA-authored local LLM (NVIDIA is currently only represented among ASR models — Parakeet/Nemotron-speech — not as a local reasoning/cleanup LLM). Users who want a Nemotron-based local reasoning model for text cleanup, the dictation agent, note formatting, or chat intelligence have no option today. This spec adds two such models — `NVIDIA-Nemotron-3-Nano-4B` and `Llama-3.1-Nemotron-Nano-8B-v1` — as new selectable local models, both constrained to **>2B parameters and <5GB on-disk (Q4_K_M) size** to keep additions in the "runs comfortably on a modest local machine" tier already occupied by most of this registry's existing entries.

## Requirements

- **Size/parameter constraint (applies to both new entries)**: only add models with **>2B parameters** and **<5GB on-disk size at the chosen quantization**. Both entries below satisfy this (4B params / ~2.84GB; 8B params / ~4.92GB).
- Add a new provider entry to `localProviders` in `src/models/modelRegistryData.json` with `id: "nvidia"`, `name: "NVIDIA"`, `baseUrl: "https://huggingface.co"`, and the same ChatML `promptTemplate` string already used by the `qwen`/`deepseek` provider entries (`"<|im_start|>system\n{system}<|im_end|>\n<|im_start|>user\n{user}<|im_end|>\n<|im_start|>assistant\n"`).
- Under that provider's `models` array, add one model definition matching the `ModelDefinition` interface in `src/models/ModelRegistry.ts`:
  - `id`: `nemotron-3-nano-4b-q4_k_m` (kebab-case, mirrors existing id conventions like `qwen3.5-4b-q4_k_m`)
  - `name`: `"Nemotron 3 Nano 4B"`
  - `size`: human-readable string (e.g. `"2.84GB"`) — verify against HF at execution time
  - `sizeBytes`: exact byte count of the GGUF file — verify against HF at execution time (do not guess/round; read the real `Content-Length`/HF file listing)
  - `description`: short one-line description (e.g. `"NVIDIA's compact reasoning model with long context"`)
  - `fileName`: `"NVIDIA-Nemotron3-Nano-4B-Q4_K_M.gguf"` — confirm exact casing/filename against the HF repo's file listing at execution time (HF filenames are case-sensitive and must match exactly for the download URL to resolve)
  - `quantization`: `"q4_k_m"`
  - `contextLength`: `262144` (up to 262K tokens per NVIDIA's model card — confirm against HF at execution time)
  - `hfRepo`: `"nvidia/NVIDIA-Nemotron-3-Nano-4B-GGUF"` — confirm this exact repo still exists and hosts the Q4_K_M file at execution time
  - `supportsThinking`: `true`
  - `descriptionKey`: `"models.descriptions.local.nvidia_nemotron_3_nano_4b_q4_k_m"`
- Add a second model definition to the **existing** `llama` provider block's `models` array (id `"llama"`, name `"Meta Llama"` — do **not** create a new provider; confirmed this model is a Llama-3.1 finetune, so it takes the same chat template as the other three entries already in this block: `"<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\n{system}<|eot_id|><|start_header_id|>user<|end_header_id|>\n\n{user}<|eot_id|><|start_header_id|>assistant<|end_header_id|>\n\n"`):
  - `id`: `llama-3.1-nemotron-nano-8b-v1-q4_k_m`
  - `name`: `"Llama 3.1 Nemotron Nano 8B"`
  - `size`: human-readable string (e.g. `"4.92GB"`) — verify against HF at execution time
  - `sizeBytes`: exact byte count of the GGUF file — verify against HF at execution time
  - `description`: short one-line description (e.g. `"NVIDIA's Nemotron-tuned Llama 3.1 8B reasoning model"`)
  - `fileName`: `"nvidia_Llama-3.1-Nemotron-Nano-8B-v1-Q4_K_M.gguf"` — confirm exact casing against the HF repo's file listing at execution time
  - `quantization`: `"q4_k_m"`
  - `contextLength`: confirm against the model card at execution time (Llama-3.1 base supports up to 128K tokens; confirm NVIDIA's Nemotron tune preserves this rather than assuming)
  - `hfRepo`: `"bartowski/nvidia_Llama-3.1-Nemotron-Nano-8B-v1-GGUF"` — confirm this exact repo still exists and hosts the Q4_K_M file at execution time
  - `supportsThinking`: `true` (NVIDIA's Nemotron Llama-3.1 tunes are reasoning/thinking-capable — confirm against the model card at execution time)
  - `descriptionKey`: `"models.descriptions.local.llama_llama_3_1_nemotron_nano_8b_v1_q4_k_m"`
- Add the corresponding translation keys (`models.descriptions.local.nvidia_nemotron_3_nano_4b_q4_k_m` and `models.descriptions.local.llama_llama_3_1_nemotron_nano_8b_v1_q4_k_m`) to `src/locales/en/translation.json` and all 8 other locale files (es, fr, de, pt, it, ru, zh-CN, zh-TW), per the CLAUDE.md i18n rule — English descriptions can be placeholder-quality direct translations, non-English strings don't need to be translator-perfect but must exist so no locale silently falls back/breaks.
- No changes needed to `ModelRegistry.ts`, `modelManagerBridge.js`, `llamaServer.js`, or `thinkingSuppression.ts` — the existing generic local-model download path (`getDownloadUrl()` building `${baseUrl}/${hfRepo}/resolve/main/${fileName}`), generic ChatML/Llama-3 prompt formatters, and generic `supportsThinking`-gated `chat_template_kwargs.enable_thinking` suppression already handle both models with zero new logic, exactly as they do today for Qwen3/Qwen3.5/DeepSeek-R1-Distill and the existing Llama-3.x entries respectively.
- Both models must appear automatically in the Local AI reasoning-provider list (`buildReasoningProviders()` in `ModelRegistry.ts` derives this from `localProviders` at import time — no manual UI wiring required) and in Settings → AI Models → Local model picker (Nemotron 3 Nano under a new "NVIDIA" section, Llama 3.1 Nemotron Nano under the existing "Meta Llama" section).

## Non-goals

- No new prompt-template format, no new provider-specific request/response handling.
- No changes to the llama.cpp server invocation, GPU/CPU handling, or any download script — this reuses the existing generic local-model download flow.
- No attempt to special-case NVIDIA's `<think>` reasoning-token format beyond what `supportsThinking` + `chat_template_kwargs.enable_thinking` already do for other ChatML/Llama-3 reasoning models (Qwen3, DeepSeek-R1-Distill) in this repo. If either Nemotron model turns out to need a materially different reasoning toggle than `enable_thinking` (e.g. a different kwarg name), that is out of scope here and must be filed as a follow-up spec once observed in practice — do not guess at NVIDIA-specific reasoning-control kwargs without verifying against the model card at execution time.
- No changes to onboarding flow, default/recommended model selection (both entries ship without `"recommended": true`, matching most existing non-default local models).
- No addition of any third model, or any model outside the >2B-parameter/<5GB-size band, under this spec — a model that doesn't fit that band needs its own spec with its own justification for the exception.

## Design

This is a pure data addition to `src/models/modelRegistryData.json`: one new `nvidia` provider block (following the exact shape/conventions of the existing `qwen`/`deepseek` blocks) plus one new model entry appended to the **existing** `llama` provider block's `models` array (following the exact shape of its three existing Llama-3.x entries). No application logic changes.

**File touched**: `src/models/modelRegistryData.json` only, plus the 9 locale JSON files under `src/locales/*/translation.json` for the two new `descriptionKey`s.

**Why no code changes are needed** (verified against current source):

- `ModelRegistry.ts`'s `registerProvidersFromData()` iterates `modelData.localProviders` generically — any new provider entry with the standard `{id, name, baseUrl, promptTemplate, models}` shape is picked up automatically, no registration call to add.
- `createPromptFormatter()` is a generic `{system}`/`{user}` template substitution — the ChatML template already exists verbatim in the `qwen` and `deepseek` entries, so no new template string logic is introduced, just reuse of the same literal string in a new provider block.
- `getDownloadUrl()` builds `${baseUrl}/${hfRepo}/resolve/main/${fileName}` generically from whatever `hfRepo`/`fileName` the model definition supplies — this resolves directly to the HuggingFace `resolve/main` download URL pattern already used by every other local model, including the second entry's `bartowski/...` repo (already the pattern used by several existing `qwen`/`llama` entries, e.g. `bartowski/Meta-Llama-3.1-8B-Instruct-GGUF`).
- `thinkingSuppression.ts`'s `applyThinkingSuppression()` already branches on `getLocalModel(model)?.supportsThinking` generically (see `localReasoningBridge.js`/`ReasoningService.ts` call sites) — setting `supportsThinking: true` on each new entry is the only signal needed; it will get `chat_template_kwargs.enable_thinking = false` sent when the user has disabled the "show thinking" setting, exactly like Qwen3/Qwen3.5/DeepSeek-R1-Distill do today. When thinking is _not_ suppressed, `<think>...</think>` blocks pass through in the raw model output the same way they do for the other reasoning-capable local models already in the registry — this spec introduces no new tag-stripping behavior because none of the existing reasoning-capable local models have one either (verified: no `<think>` string-stripping logic exists anywhere in `src/services/ai/` or `src/helpers/llamaServer.js` today — output formatting of think-tags, if ever wanted, is pre-existing, unaddressed scope for all reasoning-capable local models, not something unique to these two additions).
- Model downloads route through the existing generic local-model download UI/IPC path (`modelManagerBridge.js`) that already handles every `localProviders` entry — no new download script, no new `prebuild*` package.json entry, no new manager needed (unlike whisper.cpp/Parakeet/system-audio-helper binaries, which are compiled native binaries requiring their own download scripts; a GGUF model file is just a data blob fetched the same way every other local LLM in this registry is fetched).

**Privacy note (Non-Negotiable Product Premise #1)**: both models run 100% on-device via the bundled llama.cpp server once downloaded; the only network call is the one-time, user-initiated HuggingFace download, identical to every other entry already in `localProviders`. No new network egress pattern is introduced.

**Size/parameter constraint rationale**: the >2B/<5GB band keeps both additions comfortably runnable on typical consumer hardware at Q4_K_M, consistent with the bulk of the existing registry (e.g. `qwen3.5-4b`, `qwen3-4b`, `llama-3.2-3b`, `gemma-3-4b`, `gemma-4-e2b` all sit in a similar size class); it deliberately excludes larger Nemotron variants (e.g. any 30B+/MoE Nemotron model) from this spec's scope.

**Exact values to verify before implementation** (spec-executor must re-check the live HF repo pages, not just trust this spec's research pass, since HF listings can change and byte-exact `sizeBytes` and filenames must be correct for the download URL and file-integrity checks to work):

- `NVIDIA-Nemotron-3-Nano-4B`:
  - Confirm `nvidia/NVIDIA-Nemotron-3-Nano-4B-GGUF` is the correct, currently-live repo path.
  - Confirm the exact Q4_K_M filename casing (`NVIDIA-Nemotron3-Nano-4B-Q4_K_M.gguf` per this spec's research, but re-check — HF repos sometimes use inconsistent hyphenation between the repo name and file name).
  - Confirm exact `sizeBytes` (get the precise byte count from the HF file listing, not an approximation of "~2.84GB").
  - Confirm `contextLength` (262144, i.e. 256K tokens rounded up — matches NVIDIA's stated "up to 262K tokens").
- `Llama-3.1-Nemotron-Nano-8B-v1`:
  - Confirm `bartowski/nvidia_Llama-3.1-Nemotron-Nano-8B-v1-GGUF` is the correct, currently-live repo path and that it hosts a `Q4_K_M` quant.
  - Confirm the exact filename casing (`nvidia_Llama-3.1-Nemotron-Nano-8B-v1-Q4_K_M.gguf` per this spec's research, but re-check).
  - Confirm exact `sizeBytes` (approximation used here: ~4.92GB — verify this keeps the model under the 5GB ceiling for this spec's constraint; if the live file is at or over 5GB, this entry must be dropped from this spec and revisited separately).
  - Confirm `contextLength` and `supportsThinking` against NVIDIA's model card — this is a reasoning-tuned Llama-3.1 finetune, but the exact context window and whether thinking-tag behavior matches the generic `enable_thinking` toggle used elsewhere in this registry must be verified, not assumed from the base Llama-3.1 model card alone.
  - Confirm the prompt template: this spec assumes the model card confirms standard Llama-3.1 chat formatting (matching the existing `llama` provider's `promptTemplate`) rather than a custom NVIDIA-specific chat template — if NVIDIA's card specifies a different template, this entry must get its own `promptTemplate`/provider block instead of reusing `llama`'s.
- Confirm license terms for both (NVIDIA Nemotron Open Model License, commercial use permitted) are still accurately described if any license-display UI exists for local models (none found in current source — local models don't currently surface a license field in the registry schema, so no UI change is implied here).

## Validation Plan

- **Automated**: There is no existing automated test in this repo that validates `modelRegistryData.json`'s shape/consistency (confirmed: no test file references `modelRegistryData`, `ModelRegistry`, or `localProviders` under `test/`). Per CLAUDE.md's "rare, reviewed exception" rule, this spec documents why: the change is a pure JSON data addition, structurally identical to existing entries, consumed only by generic, already-tested-by-usage code paths (`registerProvidersFromData()`, `createPromptFormatter()`, `getDownloadUrl()`) that require no new test coverage since their behavior for these new entries is identical to their behavior for every existing local-model entry. Instead, this spec requires a lightweight new regression test as the automated check: add `test/models/modelRegistryData.test.js` (Node's built-in `node:test`, matching this repo's existing test runner convention) that loads `src/models/modelRegistryData.json` and asserts, for every entry in every `localProviders[].models[]`: `id`, `name`, `fileName`, `hfRepo`, `sizeBytes` (positive integer), and `contextLength` (positive integer) are all present and non-empty/well-typed. Additionally assert the specific `>2B-parameter/<5GB` size constraint for these two new entries by name — i.e. explicit assertions that `nemotron-3-nano-4b-q4_k_m` and `llama-3.1-nemotron-nano-8b-v1-q4_k_m` both exist in the registry and that their `sizeBytes` is below `5 * 1024**3` (5GB). This is a general schema-consistency guard (catches this addition _and_ any future one) plus a targeted assertion for this spec's two named models, and doubles as the required regression coverage. It fails today (before this change) because those two model ids don't exist yet, and passes once both are correctly added with size fields under the ceiling — satisfying the "must fail before / pass after" bar.
- **Manual** (required in addition, since the automated test above only validates JSON shape, not actual runtime download/inference behavior) — repeat for **both** new models:
  1. Launch the app in dev mode, open Settings → AI Models → set any of the four scopes (dictation cleanup / dictation agent / note formatting / chat intelligence) to "Local", and confirm "Nemotron 3 Nano 4B" appears under a new NVIDIA section, and "Llama 3.1 Nemotron Nano 8B" appears under the existing Meta Llama section, of the local model picker.
  2. Trigger a download of each model and confirm it completes without error and the file lands at the expected local cache path with the expected size.
  3. Select each model in turn as the active local model for a scope, dictate or send a short test prompt, and confirm a response is returned (i.e. llama.cpp successfully loads the GGUF and the respective ChatML / Llama-3 prompt template produces a coherent completion).
  4. With "show thinking" / disableThinking toggled off in Settings, confirm `<think>...</think>` tags do not appear in suppressed output for either model (same behavior already exhibited by Qwen3/Qwen3.5 today) — this only re-confirms existing generic behavior extends to the new entries, not new logic.
- **Docs**: `CLAUDE.md` §8 ("Model Registry Architecture") lists example local model families by name in the "Local: GGUF models via llama.cpp (Qwen, Llama, Mistral, GPT-OSS)" line under §7 Agent Naming System — update that parenthetical to include NVIDIA/Nemotron once implemented, if the executor judges it's become stale enough to warrant a one-line update (this is illustrative prose, not authoritative data, so it's a minor/optional docs touch, not a hard requirement). No `docs/RECREATION_SPEC.md` update is required — that document doesn't enumerate individual local model entries, only the registry architecture pattern itself, which this change doesn't alter.

## Open Questions

- None blocking. Outstanding items are routine data-accuracy checks for spec-executor to perform against the live HuggingFace pages, not design decisions requiring the project owner's input:
  1. Verify exact filename/size/repo path/context-length for both models.
  2. Verify `Llama-3.1-Nemotron-Nano-8B-v1`'s actual Q4_K_M file size is genuinely under the 5GB ceiling this spec sets — if it turns out to be at or over 5GB, drop that entry from this spec's scope and raise a separate spec/exception request rather than silently proceeding.
  3. Verify `Llama-3.1-Nemotron-Nano-8B-v1` truly uses standard Llama-3.1 chat formatting (justifying reuse of the existing `llama` provider's `promptTemplate`) rather than a custom template that would require its own provider block.
