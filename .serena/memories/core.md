# OpenWhispr (EktosWhispr) — Core Memory

Offline-first dictation app (speech-to-text). Windows-primary dev environment (`C:\dev\EktosWhispr`), **Node 26** required (`.nvmrc` pinned — never regenerate lockfile with a different major; CI uses `npm ci`). This is the **offline fork**: all cloud-only features (OpenWhispr Cloud, Corti, Tinfoil, referral, Google Calendar, Qdrant semantic search) were removed.

## Entry Points

- `main.js` — Electron main process, initializes all managers
- `preload.js` — IPC bridge (context isolation on); every new IPC channel MUST be registered in BOTH `src/helpers/ipcHandlers.js` AND `preload.js`
- `src/main.jsx` → React renderer (Vite, URL-based routing for two windows)
- `src/AppRouter.jsx` — routes between main overlay and control panel

## Key Domains

- Transcription engines & models: `mem:tech_stack`
- Build/dev commands: `mem:suggested_commands`
- Code conventions (i18n, IPC, secrets, sidecar binaries): `mem:conventions`
- Task completion checklist: `mem:task_completion`

## Two-Window Architecture

- **Main overlay** (always-on-top, draggable): dictation trigger UI
- **Control panel**: settings, history, model management
  Both are the same React app — differentiated by URL path.

## Process Architecture

- Main process: Electron + IPC + SQLite
- Renderer: React 19 + Vite (context isolation)
- ONNX utility process: lazy-spawned worker (`src/helpers/onnxWorkerClient.js` → `src/workers/onnxWorker.js`) for all `onnxruntime-node` inference; respawns on crash
- Sidecar binaries: llama.cpp server, whisper.cpp, sherpa-onnx (Parakeet) — managed via `sidecarRegistry.js`. **Qdrant was REMOVED** (see `docs/specs/remove-qdrant-dependency.md`); do not reintroduce it.

## Critical Non-Obvious Facts

- Secrets (**16 total**: 7 BYOK API keys + 5 enterprise creds [Bedrock×3, Azure, Vertex] + 4 [ASSEMBLYAI, DEEPGRAM, CUSTOM_TRANSCRIPTION, CUSTOM_CLEANUP]) encrypted via Electron `safeStorage` → per-key files in `userData/secure-keys/`. Non-secret env vars go to `.env` via `saveAllKeysToEnvFile()`.
- AI model registry single source of truth: `src/models/modelRegistryData.json`
- 4 inference scopes (`dictationCleanup`, `dictationAgent`, `noteFormatting`, `chatIntelligence`) each have independent provider/model config — see `src/config/inferenceScopes.ts`
- Inference providers registry at `src/services/ai/inferenceProviders/index.ts`: **11 registry keys** (openai, custom, openrouter, anthropic, gemini, groq, local, bedrock, azure, vertex, lan) → **7 implementations**. **No `openwhispr`/first-party cloud provider, no Corti.**
- Anthropic API calls route through IPC (main process) to avoid renderer CORS; all other providers called directly from renderer
- `search_notes` is FTS5 keyword search ONLY — no semantic/vector search (Qdrant removed)
