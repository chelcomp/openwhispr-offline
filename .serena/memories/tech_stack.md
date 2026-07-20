# Tech Stack

## Core

- Electron 41, React 19, TypeScript, Tailwind CSS v4, Vite, **Node 26**
- better-sqlite3 (local transcription history), shadcn/ui + Radix primitives
- react-i18next v15 / i18next v25 — **2 languages only** (`src/locales/en`, `src/locales/pt`)

## Transcription Engines

| Engine                        | Binary location                               | Model cache                             |
| ----------------------------- | --------------------------------------------- | --------------------------------------- |
| whisper.cpp (local)           | `resources/bin/whisper-cpp-{platform}-{arch}` | `~/.cache/ektoswhispr/whisper-models/`  |
| NVIDIA Parakeet (sherpa-onnx) | `resources/bin/sherpa-onnx-{platform}-{arch}` | `~/.cache/ektoswhispr/parakeet-models/` |
| OpenAI Whisper API            | cloud                                         | —                                       |

`LOCAL_TRANSCRIPTION_PROVIDER` env var selects engine (`nvidia` = Parakeet). **Corti, AssemblyAI/Deepgram streaming, and OpenWhispr Cloud were removed in the offline fork.**

## AI Inference

- OpenAI: Responses API (`/v1/responses`), NOT Chat Completions — `input` array not `messages`
- Anthropic: via IPC bridge (CORS workaround), model IDs use alias format (e.g., `claude-sonnet-4-6`)
- Local: llama.cpp server (`src/helpers/llamaServer.js`), GGUF models from HuggingFace
- Provider registry: `src/services/ai/inferenceProviders/index.ts` — **11 registry keys** (openai, custom, openrouter, anthropic, gemini, groq, local, bedrock, azure, vertex, lan) → **7 implementations**. No first-party cloud provider.
- Model registry: `src/models/modelRegistryData.json` (single source of truth)

## Vector / Semantic Search — REMOVED

- **No Qdrant, no embeddings, no semantic search.** `search_notes` and agent conversation search are FTS5 keyword matchers only (see `docs/specs/remove-qdrant-dependency.md`). Do not reintroduce hybrid/vector search.

## Audio Pipeline

MediaRecorder (renderer) → Blob → ArrayBuffer → IPC → temp file → whisper.cpp → result → IPC → renderer → clipboard

## Native Binaries (platform-specific)

- Windows: `windows-key-listener.exe`, `windows-mic-listener.exe`, `windows-system-audio-helper.exe`, `nircmd.exe`, `windows-fast-paste.exe`
- macOS: compiled from Swift/C source during `compile:native`
- Linux: compiled from C source during `compile:native`; clipboard uses `xdotool`/`wtype`/`ydotool` chain

## Database

SQLite via better-sqlite3. Schema: `transcriptions` table (id, timestamp, original_text, processed_text, is_processed, processing_method, agent_name, error).
