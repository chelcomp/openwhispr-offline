# EktosWhispr Technical Reference for AI Assistants

This document provides comprehensive technical details about the EktosWhispr project architecture for AI assistants working on the codebase.

**Documentation map**: [`docs/README.md`](docs/README.md) indexes every doc in this repo (guides, reference, specs, agent definitions) and explains how they relate. Consult it before searching the repo ad hoc for "where is X documented." In particular, this file (CLAUDE.md) is the day-to-day architecture reference, but [`docs/RECREATION_SPEC.md`](docs/RECREATION_SPEC.md) — especially its §0 — is the authority when the two disagree about current behavior.

## Project Overview

EktosWhispr is an Electron-based desktop dictation application that uses whisper.cpp for speech-to-text transcription. It supports both local (privacy-focused) and cloud (OpenAI API) processing modes.

## Non-Negotiable Product Premises

These three constraints are foundational and take priority over convenience, feature scope, or implementation simplicity. `spec-planner` must state how any spec touching these areas complies with them, and `pr-reviewer` treats violations as a hard `FAIL`, not an advisory note.

### 1. Privacy — no data leaves the user's PC by default

- No telemetry, analytics, or crash-reporting call fires without explicit user opt-in. There is none in the codebase today — keep it that way.
- No silent/background update checks. Any version-check network call must be visible to and controlled by the user, not fired automatically without notice.
- Cloud AI providers (OpenAI, Anthropic, Gemini, Groq, the enterprise `bedrock`/`azure`/`vertex` handler, etc.) are an explicit exception: they're BYOK and opt-in — the user supplied the key and picked the provider. The rule is about data leaving _without the user choosing it_, not about the existence of cloud options.
- No new TCP listener may bind to anything other than loopback (`127.0.0.1`) — never `0.0.0.0`, never reachable from the network. Existing loopback-only sidecars (`cliBridge.js` on ports 8200–8219, the Qdrant sidecar) are already compliant and don't need re-justifying. Any _new_ port/service must state in its spec why it's needed and confirm it's loopback-only.

### 2. Performance — minimal footprint while idle

EktosWhispr starts with Windows and runs continuously in the background, so idle cost matters more than active-use cost.

- Idle budget (app running, no active recording, no transcription/reasoning in flight): **≤300 MB RAM, <2% average CPU**, measured over several minutes of idle — not instantaneous spikes.
- Prefer event-driven OS APIs over polling for anything continuous. New background work should follow the same lazy-spawn approach used by `QdrantManager` and the ONNX utility process — spawned on first use, never at app launch.
- Any new always-on timer, polling loop, or background service must justify its interval and cost in the spec; `pr-reviewer` checks it against the idle budget above.

### 3. Speed — sub-500ms raw transcription

- From hotkey release to **raw transcript text** (before any optional cleanup/agent LLM pass), local transcription must complete in **≤500ms** for the default/fast engines (Whisper `tiny`/`base`, Parakeet, GPU-accelerated paths).
- Medium/large Whisper models are an explicit, documented exception — they trade this budget for quality, and the UI/docs must make that tradeoff visible rather than implying they also hit 500ms.
- The optional AI cleanup/agent pass (LLM round-trip, possibly over the network) has its own latency budget, separate from this 500ms figure, since it's a distinct opt-in step.
- Any change to the audio pipeline, `whisper.js`/`parakeet.js` integration, or the IPC path between hotkey-release and transcript-ready must state its expected impact on this budget in the spec.

### 4. Single instance — the app never runs twice

- Already enforced: `app.requestSingleInstanceLock()` in `main.js` exits a second launch attempt immediately (`app.exit(0)`), and the `second-instance` handler (`main.js:1023`) focuses/restores the control panel of the existing instance. This is correct behavior today — the rule is that it must never regress.
- Rationale: the app owns a global hotkey registration, a SQLite connection, and lazily-owned sidecar ports (Qdrant, ONNX worker) — a second instance would collide with all three.
- Any spec touching app startup, window creation, or the relaunch/update path must explicitly confirm the single-instance lock and the `second-instance` focus handler are still intact.

### 5. Graceful degradation — optional components never take the app down

- Every optional native binary, sidecar process, or platform integration (Qdrant, the ONNX worker, whisper.cpp/Parakeet engines, native mic/key listeners, GNOME/Hyprland/KDE D-Bus shortcuts, Linux clipboard tools) must have a defined fallback. Its failure or absence must never crash the app or block its core function (record → transcribe → paste). This generalizes the pattern already used for search (Qdrant → FTS5) and hotkeys (push-to-talk → tap mode).
- Any spec introducing a new optional dependency must state its fallback path in the design; `pr-reviewer` treats a missing fallback as a violation, not a nice-to-have.

### 6. Migration safety — upgrades never lose user data

- Any change to a settings key, localStorage schema, database schema/column, or persisted file format must ship a migration path in the same spec. Existing user data (transcription history, settings, custom dictionary, API keys, notes, hotkeys) must survive the upgrade untouched or be transformed forward — never silently reset or dropped. `postMigrationDetector.js` (the one-time bundle-ID migration) is the precedent to follow, not a one-off exception specific to that rename.
- The spec's Validation Plan must include a test that exercises the old format/value through the upgrade path and asserts the data survives — this is a specific case of the mandatory regression-test rule above, not an exemption from it.
- `pr-reviewer` FAILs any diff that renames or restructures a storage key or schema without an accompanying migration.

### 7. Data retention — operational data persists; only collected/ephemeral data is user-controlled and auto-purged

- **Never auto-expunged (operational data, persisted indefinitely, deletion only ever user-initiated)**: Personal Notes content, everything related to Meeting recordings — both transcripts/summaries AND the raw meeting audio file itself — and the custom Dictionary. This is not "collected data" in the privacy sense; it's the product's own operational state, and auto-deleting any of it would be a data-loss bug, not a privacy feature. This is a deliberate change from today's code: `meetingAudioStorage.js`'s `cleanupExpiredAudio()` currently auto-purges meeting audio via the same `audioRetentionDays` setting as dictation audio — that must stop; meeting audio gets no automatic expiry at all.
- **Eligible for user-controlled retention + auto-purge (collected/ephemeral data)**: dictation audio recordings (`audioRetentionDays` setting, `audioStorageManager.cleanupExpiredAudio()`), the SQLite transcription-history text (today only has a manual "Clear All", no age-based auto-expiry — gap to fill), and debug log files (today have no rotation/retention at all — gap to fill).
- Every item in the second category must have (a) a user-facing setting controlling its retention window and (b) an automatic background purge honoring that setting — a "Clear All" button alone does not satisfy this rule.
- **Known bug, scope now expanded**: `ipcHandlers.js`'s `_setupAudioCleanup()` today hardcodes `DEFAULT_RETENTION_DAYS = 30` for both dictation and meeting audio, ignoring the user's actual `audioRetentionDays` setting entirely. Fixing it must also remove meeting audio from that cleanup path altogether per this premise, not just make it respect the setting for meeting audio too.
- Any spec touching data storage must state explicitly which category (operational vs. collected) new data falls into, and must never introduce auto-expiry for operational data.

## Architecture Overview

### Core Technologies

- **Frontend**: React 19, TypeScript, Tailwind CSS v4, Vite
- **Desktop Framework**: Electron 41 with context isolation
- **Database**: better-sqlite3 for local transcription history
- **UI Components**: shadcn/ui with Radix primitives
- **Speech Processing**: whisper.cpp + NVIDIA Parakeet (via sherpa-onnx) + OpenAI API
- **Audio Processing**: FFmpeg (bundled via ffmpeg-static)
- **Node.js**: 26 (pinned in `.nvmrc` — CI reads it via `node-version-file`, do NOT regenerate `package-lock.json` with a different major version)

### Key Architectural Decisions

1. **Dual Window Architecture**:
   - Main Window: Minimal overlay for dictation (draggable, always on top)
   - Control Panel: Full settings interface (normal window)
   - Both use same React codebase with URL-based routing

2. **Process Separation**:
   - Main Process: Electron main, IPC handlers, database operations
   - Renderer Process: React app with context isolation
   - Preload Script: Secure bridge between processes
   - ONNX Utility Process: hosts all `onnxruntime-node` inference (text embeddings, speaker embeddings, fbank). Lazy-spawned on first use via `src/helpers/onnxWorkerClient.js` → `src/workers/onnxWorker.js`. Native crashes (e.g., ORT `bad_alloc`) confine to the worker; main process rejects in-flight requests and respawns with backoff. Stopped in `will-quit`.

3. **Audio Pipeline**:
   - MediaRecorder API → Blob → ArrayBuffer → IPC → File → whisper.cpp
   - Automatic cleanup of temporary files after processing

## File Structure and Responsibilities

### Main Process Files

- **main.js**: Application entry point, initializes all managers
- **preload.js**: Exposes safe IPC methods to renderer via window.api

### Native Resources (resources/)

- **windows-key-listener.c**: C source for Windows low-level keyboard hook (Push-to-Talk)
- **windows-system-audio-helper.c**: C source for WASAPI process-loopback system audio capture (meeting transcription). Excludes EktosWhispr's own process tree, so it hears every app on every output device. Requires Windows 10 2004+; falls back to Chromium display-media loopback when unavailable. Outputs 24 kHz mono s16le PCM on stdout, line-delimited JSON events on stderr (same protocol as linux-system-audio-helper)
- **globe-listener.swift**: Swift source for macOS Globe/Fn key detection
- **bin/**: Directory for compiled native binaries (whisper-cpp, nircmd, key listeners)

### Helper Modules (src/helpers/)

- **audioManager.js**: Handles audio device management
- **autoLearnDictionary.js**: Core auto-learn logic — given the originally-pasted text and the text-monitor's post-edit field value, extracts `{from, to}` correction pairs via `correctionLearner.js`, applies the anti-oscillation guard (see Custom Dictionary §13 below), and persists survivors via `databaseManager.setDictionary()`. Deliberately Electron/IPC-free (only touches the `databaseManager` it's given) so it's unit-testable in isolation — see `test/helpers/autoLearnDictionary.test.js`. Called from `ipcHandlers.js`'s `_processCorrections()`.
- **clipboard.js**: Cross-platform clipboard operations
  - macOS: AppleScript-based paste with accessibility permission check
  - Windows: PowerShell SendKeys with nircmd.exe fallback
  - Linux: Native XTest binary + compositor-aware fallbacks (xdotool, wtype, ydotool)
- **database.js**: SQLite operations for transcription history
- **debugLogger.js**: Debug logging system with file output
- **devServerManager.js**: Vite dev server integration
- **dragManager.js**: Window dragging functionality
- **environment.js**: Environment variable and OpenAI API management
- **hotkeyManager.js**: Global hotkey registration and management
  - Named hotkey slots: `dictation`, `agent` (chat agent overlay), `voiceAgent` (dictation routed straight to the dictation agent), `meeting`
  - Handles platform-specific defaults (GLOBE on macOS, Control+Super on Windows/Linux)
  - Auto-fallback to F8/F9 if default hotkey is unavailable
  - Notifies renderer via IPC when hotkey registration fails
  - Integrates with GnomeShortcutManager for GNOME Wayland support
  - Integrates with HyprlandShortcutManager for Hyprland Wayland support
  - Integrates with KDEShortcutManager for KDE Wayland support
- **gnomeShortcut.js**: GNOME Wayland global shortcut integration
  - Uses D-Bus service to receive hotkey toggle commands
  - Registers shortcuts via gsettings (visible in GNOME Settings → Keyboard → Shortcuts)
  - Converts Electron hotkey format to GNOME keysym format
  - Only active on Linux + Wayland + GNOME desktop
  - D-Bus transport: `@homebridge/dbus-native` (pure JavaScript, no native addons)
- **hyprlandShortcut.js**: Hyprland Wayland global shortcut integration
  - Uses D-Bus service to receive hotkey toggle commands (same `com.ektoswhispr.App` service)
  - Registers shortcuts via `hyprctl keyword bind` (runtime keybinding)
  - Converts Electron hotkey format to Hyprland bind format (`MODS, key`)
  - Only active on Linux + Wayland + Hyprland (detected via `HYPRLAND_INSTANCE_SIGNATURE`)
  - D-Bus transport: `@homebridge/dbus-native` (pure JavaScript, no native addons)
- **kdeShortcut.js**: KDE Wayland global shortcut integration
  - Uses D-Bus to communicate with KGlobalAccel for global hotkey registration
  - Registers hotkeys via `setShortcut`/`doRegister` D-Bus calls on the KGlobalAccel interface
  - Listens for `globalShortcutPressed` signals to trigger callbacks
  - Converts Electron hotkey format to Qt key codes
  - Only active on Linux + KDE desktop (detected via `XDG_CURRENT_DESKTOP`)
  - D-Bus transport: `@homebridge/dbus-native` (pure JavaScript, no native addons)
- **ipcHandlers.js**: Centralized IPC handler registration
- **windowsKeyManager.js**: Windows Push-to-Talk support with native key listener
  - Spawns native `windows-key-listener.exe` binary for low-level keyboard hooks
  - Supports compound hotkeys (e.g., `Ctrl+Shift+F11`, `CommandOrControl+Space`)
  - Emits `key-down` and `key-up` events for push-to-talk functionality
  - Graceful fallback if binary unavailable
- **manualMeetingLauncher.js**: Handles the manual, user-initiated "start a meeting recording" flow (meeting hotkey / a deliberate click). There is no automatic meeting detection — see §16.
- **menuManager.js**: Application menu management
- **tray.js**: System tray icon and menu
- **whisper.js**: Local whisper.cpp integration and model management
- **parakeet.js**: NVIDIA Parakeet model management via sherpa-onnx
- **parakeetServer.js**: sherpa-onnx CLI wrapper for transcription
- **windowConfig.js**: Centralized window configuration
- **windowManager.js**: Window creation and lifecycle management
- **cliBridge.js**: Loopback HTTP server on ports 8200–8219, bearer-token auth (token at `~/.ektoswhispr/cli-bridge.json`), 127.0.0.1-only. Used by the unified CLI to talk to a running desktop app.
- **postMigrationDetector.js**: Detects users returning from the pre-Gizmo bundle ID via a `.bundle-migrated` sentinel in userData; consumed by `ipcHandlers.js` to drive the `PostMigrationOnboarding` modal
- **textEditMonitor.js**: Platform-native text-monitor for the auto-learn feature (see Custom Dictionary §13) — watches the destination field's real, focused value after a paste (AT-SPI2 on Linux, UI Automation on Windows, AXObserver/osascript-polling fallback on macOS). Instantiated once in `main.js`, shared with `windowManager`/`ipcHandlers`. Emits `text-edited` on any change; graceful fallback per platform if the native binary is unavailable.

### React Components (src/components/)

- **App.jsx**: Main dictation interface with recording states
- **ControlPanel.tsx**: Settings, history, model management UI
- **OnboardingFlow.tsx**: Dynamic-length first-time setup wizard (not a fixed step count — e.g. the `localModel` step is conditional). There is no dedicated "name your agent" step; the agent name is only set in Settings, defaulting to `"EktosWhispr"`. There is no "meeting" step (removed along with automatic meeting detection — see §16).
- **PostMigrationOnboarding.tsx**: One-time modal for users returning from the pre-Gizmo bundle ID; reuses `PermissionsSection` to walk through re-granting Microphone, Accessibility, and System Audio. Triggered by `postMigrationDetector.js` (see Helper Modules)
- **SettingsPage.tsx**: Comprehensive settings interface
- **WhisperModelPicker.tsx**: Model selection and download UI
- **ui/**: Reusable UI components (buttons, cards, inputs, etc.)

### React Hooks (src/hooks/)

- **useAudioRecording.js**: MediaRecorder API wrapper with error handling
- **useClipboard.ts**: Clipboard operations hook
- **useDialogs.ts**: Electron dialog integration
- **useHotkey.js**: Hotkey state management
- **useLocalStorage.ts**: Type-safe localStorage wrapper
- **usePermissions.ts**: System permission checks and settings access
  - `openMicPrivacySettings()`: Opens OS microphone privacy settings
  - `openSoundInputSettings()`: Opens OS sound input device settings
  - `openAccessibilitySettings()`: Opens OS accessibility settings (macOS only)
- **useSettings.ts**: Application settings management
- **useWhisper.ts**: Whisper binary availability check

### Services

- **ReasoningService.ts**: AI processing for agent-addressed commands
  - Detects when user addresses their named agent and removes the agent name from final output
  - Provider implementations live in a registry at `src/services/ai/inferenceProviders/index.ts` covering 7 implementations behind 11 registry keys (`openai`/`custom`/`openrouter` → one OpenAI-compatible handler, also used for Tinfoil/Mistral-style OpenAI-compatible endpoints; `anthropic`; `gemini`; `groq`; `local`; `bedrock`/`azure`/`vertex` → one "enterprise" handler; `lan`), each implementing the `InferenceProvider` interface from `types.ts`. There is no `ektoswhispr` cloud provider — this offline fork has no first-party cloud backend.
  - Per-scope LLM config: 4 scopes (`dictationCleanup`, `dictationAgent`, `noteFormatting`, `chatIntelligence`) defined in `src/config/inferenceScopes.ts`
  - `selectResolvedLLMConfig(state, scope)` in `settingsStore.ts` resolves provider/model per scope with fallback chains

### whisper.cpp Integration

- **whisper.js**: Native binary wrapper for local transcription
  - Bundled binaries in `resources/bin/whisper-cpp-{platform}-{arch}`
  - Falls back to system installation (`brew install whisper-cpp`)
  - GGML model downloads from HuggingFace
  - Models stored in `~/.cache/ektoswhispr/whisper-models/`

### NVIDIA Parakeet Integration (via sherpa-onnx)

- **parakeet.js**: Model management for NVIDIA Parakeet ASR models
  - Uses sherpa-onnx runtime for cross-platform ONNX inference
  - Bundled binaries in `resources/bin/sherpa-onnx-{platform}-{arch}`
  - INT8 quantized models for efficient CPU inference
  - Models stored in `~/.cache/ektoswhispr/parakeet-models/`
  - Server pre-warming on startup when `LOCAL_TRANSCRIPTION_PROVIDER=nvidia` is set
  - Provider preference persisted to `.env` via `saveAllKeysToEnvFile()` on server start/stop
  - **GPU behavior differs from Whisper**: Parakeet always attempts CUDA when a GPU is present, with no user-facing CPU/GPU toggle (unlike Whisper, which respects `WHISPER_GPU_MODE`). This is an explicit design decision in the source, not a bug — there is no equivalent env var to force Parakeet onto CPU.

- **Available Models**:
  - `parakeet-tdt-0.6b-v3`: Multilingual (25 languages), ~680MB
  - `parakeet-unified-en-0.6b`: English-only, ~631MB, state-of-the-art EN accuracy (5.91% avg WER on Open ASR Leaderboard)

- **Download URLs**: Models from sherpa-onnx ASR models release on GitHub

Note: `search_notes` (the AI agent's note-search tool) is FTS5 keyword search only; there is no
local or cloud semantic search in this fork. A local Qdrant vector-DB sidecar + MiniLM embedding
pipeline previously backed a hybrid semantic search here but was removed — see
`docs/specs/remove-qdrant-dependency.md` for the removal rationale and
`docs/RECREATION_SPEC.md` §0/§4 for historical details.

### Build Scripts (scripts/)

- **download-whisper-cpp.js**: Downloads whisper.cpp binaries from GitHub releases
- **download-llama-server.js**: Downloads llama.cpp server for local LLM inference
- **download-nircmd.js**: Downloads nircmd.exe for Windows clipboard operations
- **download-windows-key-listener.js**: Downloads prebuilt Windows key listener binary
- **download-sherpa-onnx.js**: Downloads sherpa-onnx binaries for Parakeet support
- **build-globe-listener.js**: Compiles macOS Globe key listener from Swift source
- **build-windows-key-listener.js**: Compiles Windows key listener (for local development)
- **run-electron.js**: Development script to launch Electron with proper environment
- **lib/download-utils.js**: Shared utilities for downloading and extracting files
  - `fetchLatestRelease(repo, options)`: Fetches latest release from GitHub API
  - `downloadFile(url, dest)`: Downloads file with progress and retry logic
  - `extractZip(zipPath, destDir)`: Cross-platform zip extraction
  - `parseArgs()`: Parses CLI arguments for platform/arch targeting
  - Supports `GITHUB_TOKEN` for authenticated requests (higher rate limits)

## Key Implementation Details

### 1. FFmpeg Integration

FFmpeg is bundled with the app and doesn't require system installation:

```javascript
// FFmpeg is unpacked from ASAR to app.asar.unpacked/node_modules/ffmpeg-static/
```

### 2. Audio Recording Flow

1. User presses hotkey → MediaRecorder starts
2. Audio chunks collected in array
3. User presses hotkey again → Recording stops
4. Blob created from chunks → Converted to ArrayBuffer
5. Sent via IPC
6. Main process writes to temporary file
7. whisper.cpp processes file → Result sent back
8. Temporary file deleted

### 3. Local Whisper Models (GGML format)

Models stored in `~/.cache/ektoswhispr/whisper-models/`:

- tiny: ~75MB (fastest, lowest quality)
- base: ~142MB (recommended balance)
- small: ~466MB (better quality)
- medium: ~1.5GB (high quality)
- large: ~3GB (best quality)
- turbo: ~1.6GB (fast with good quality)

### 4. Database Schema

```sql
CREATE TABLE transcriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  original_text TEXT NOT NULL,
  processed_text TEXT,
  is_processed BOOLEAN DEFAULT 0,
  processing_method TEXT DEFAULT 'none',
  agent_name TEXT,
  error TEXT
);
```

### 5. Settings Storage

Settings stored in localStorage with these keys:

- `whisperModel`: Selected Whisper model
- `useLocalWhisper`: Boolean for local vs cloud
- `uiLanguage`: UI display language (separate from transcription language)
- `preferredLanguage`: Selected transcription language code
- `agentName`: User's custom agent name
- `reasoningModel`: Selected AI model for processing
- `reasoningProvider`: AI provider (openai/anthropic/gemini/local)
- `dictationKey`: Custom hotkey configuration
- `onboardingCompleted`: Onboarding completion flag
- `customDictionary`: JSON array of words/phrases for improved transcription accuracy

Secret env vars (16 total: 7 BYOK API keys + 5 enterprise cloud creds + 4 more — `ASSEMBLYAI_API_KEY`, `DEEPGRAM_API_KEY`, `CUSTOM_TRANSCRIPTION_API_KEY`, `CUSTOM_CLEANUP_API_KEY` — see `SECRET_KEYS` in `environment.js`) are encrypted at rest via Electron `safeStorage` and stored as per-key files under `userData/secure-keys/`. They are loaded into `process.env` at startup by `EnvironmentManager.init()`. Renderer reads them via IPC (`get-*-key`) and writes via debounced IPC (`save-*-key`). On Linux without a keyring, secrets fall back to plaintext.

Non-secret env vars persisted to `.env` (via `saveAllKeysToEnvFile()`):

- `LOCAL_TRANSCRIPTION_PROVIDER`: Transcription engine (`nvidia` for Parakeet)
- `PARAKEET_MODEL`: Selected Parakeet model name (e.g., `parakeet-tdt-0.6b-v3`)
- `AUDIO_RETENTION_DAYS`: Local audio retention window in days, mirrored from the renderer's `audioRetentionDays` setting via `get-audio-retention-days`/`save-audio-retention-days` IPC. See "Audio Retention Cleanup" immediately below for its unusual `0` semantics and fallback default.

**Audio Retention Cleanup**: `_setupAudioCleanup()` in `ipcHandlers.js` reads `environmentManager.getAudioRetentionDays()` fresh on every run — once immediately at startup and again every 6 hours — and applies it to **dictation audio only** (`AudioStorageManager.cleanupExpiredAudio()`). Two counter-intuitive, deliberate design decisions here:

- **`audioRetentionDays = 0` means "delete ALL existing dictation audio immediately,"** not "disabled." This is the opposite of what the Settings UI's "Off" label used to imply, and the copy has been updated accordingly. No special-case branch is needed for `0` — the existing cutoff formula (`Date.now() - retentionDays * 86400000`) already deletes everything when `retentionDays` is `0`.
- **The fallback default when `AUDIO_RETENTION_DAYS` has never been persisted is `0`**, not a "safe" positive number — a deliberate privacy-by-default stance (local audio storage is opt-in). Practical consequence: any install where the user never opens Settings → Privacy & Data will have all local dictation audio deleted starting from the first cleanup tick.
- Negative/non-finite (`NaN`/`Infinity`) values are treated as **invalid** and skip deletion for that tick (logged as a warning) — never conflated with the valid, deliberate value `0`. The validity decision is a pure function in `src/helpers/audioCleanupPolicy.js`.
- A narrow startup-ordering safeguard skips only the very first immediate cleanup pass when `AUDIO_RETENTION_DAYS` has never been persisted at all (fresh install, or an existing user's first launch after upgrading to this behavior), giving the renderer's startup settings sync a moment to land before any file is touched. Every subsequent tick, including the immediate one on future restarts, behaves normally. **The main process never self-persists a value to satisfy this safeguard** — `_setupAudioCleanup()` runs before any window (and therefore the renderer's `localStorage`) exists, so writing the `0` fallback there would permanently clobber an existing user's real, never-before-synced preference (e.g. `30`, from before this fix shipped). Establishing the real value is the renderer's job: `initializeSettings()` in `settingsStore.ts` calls `get-audio-retention-sync-state` and, via the pure `resolveAudioRetentionStartupSync()` in `src/helpers/audioRetentionSync.js`, either pulls main's value (if genuinely already persisted) or pushes the renderer's own current value up to main (if not) — the renderer's real prior preference always wins over main's fallback on first sync.

**Meeting audio is permanently exempt from this (or any) automatic expiry**, per the Non-Negotiable Product Premises §7 (Data retention) — it's operational data, not collected/ephemeral data, and is deleted only via user-initiated action: deleting the note itself (`deleteNoteInternal()` → `meetingAudioStorage.deleteAudio()`) or the Settings → Privacy & Data "Clear All Meeting Audio" button (`delete-all-meeting-audio` IPC → `meetingAudioStorage.deleteAllMeetingAudio()`, which also clears the `audio_path` column on affected notes without touching their title/transcript/content). `meetingAudioStorage.cleanupExpiredAudio()` — the function that used to auto-purge meeting audio on the same schedule as dictation audio — has been deleted from the codebase entirely; do not reintroduce an age-based purge for meeting audio. Meeting-audio disk usage is surfaced (file count + total size) via `get-meeting-audio-storage-usage` → `meetingAudioStorage.getStorageUsage()`, mirroring the dictation-audio "Storage Usage" row.

### 6. Language Support

58 languages supported (see src/utils/languages.ts):

- Each language has a two-letter code and label
- "auto" for automatic detection
- Passed to whisper.cpp via -l parameter

### 7. Agent Naming System

- The agent name is set in Settings, not during onboarding (there is no dedicated onboarding step for it) — defaults to `"EktosWhispr"`
- Name stored in localStorage and database
- ReasoningService detects "Hey [AgentName]" patterns
- AI processes command and removes agent reference from output
- Supports multiple AI providers (all models defined in `src/models/modelRegistryData.json`):
  - **OpenAI** (Responses API):
    - GPT-5.5 (`gpt-5.5`) - Latest flagship frontier model, 1M context
    - GPT-5.2 (`gpt-5.2`) - Strong reasoning model
    - GPT-5 Mini (`gpt-5-mini`) - Fast and cost-efficient
    - GPT-5 Nano (`gpt-5-nano`) - Ultra-fast, low latency
    - GPT-4.1 Series (`gpt-4.1`, `gpt-4.1-mini`, `gpt-4.1-nano`) - Strong baseline with 1M context
  - **Anthropic** (Via IPC bridge to avoid CORS):
    - Claude Opus 4.7 (`claude-opus-4-7`) - Most capable Claude model, 1M context
    - Claude Sonnet 4.6 (`claude-sonnet-4-6`) - Balanced performance
    - Claude Haiku 4.5 (`claude-haiku-4-5`) - Fast with near-frontier intelligence
    - Claude Opus 4.6 (`claude-opus-4-6`) - Previous Opus generation, 1M context
    - Claude Sonnet 4.5 (`claude-sonnet-4-5`) - Previous Sonnet generation
    - Claude Opus 4.5 (`claude-opus-4-5`) - Earlier Opus model
  - **Google Gemini** (Direct API integration):
    - Gemini 3.1 Pro (`gemini-3.1-pro-preview`) - Most capable Gemini model
    - Gemini 3 Flash (`gemini-3-flash-preview`) - Ultra-fast, high-capability next-gen model
    - Gemini 2.5 Flash Lite (`gemini-2.5-flash-lite`) - Lowest latency and cost
  - **Local**: GGUF models via llama.cpp (Qwen, Llama, Mistral, GPT-OSS, NVIDIA/Nemotron)

### 8. Model Registry Architecture

All AI model definitions are centralized in `src/models/modelRegistryData.json` as the single source of truth:

```json
{
  "cloudProviders": [...],   // OpenAI, Anthropic, Gemini API models
  "localProviders": [...]    // GGUF models with download URLs
}
```

**Key files:**

- `src/models/modelRegistryData.json` - Single source of truth for all models
- `src/models/ModelRegistry.ts` - TypeScript wrapper with helper methods; `buildReasoningProviders()` derives the reasoning provider list from the registry (there is no separate `src/config/aiProvidersConfig.ts` — that file doesn't exist)
- `src/utils/languages.ts` - Derives REASONING_PROVIDERS from registry
- `src/helpers/modelManagerBridge.js` - Handles local model downloads

**Local model features:**

- Each model has `hfRepo` for direct HuggingFace download URLs
- `promptTemplate` defines the chat format (ChatML, Llama, Mistral)
- Download URLs constructed as: `{baseUrl}/{hfRepo}/resolve/main/{fileName}`
- A model's registry `contextLength` is a *maximum request*, not what's always used at runtime: `llamaServer.js`'s local server starts at a `2048` (`DEFAULT_CONTEXT_CAP`) default per request (including on `prewarmServer()`'s initial pre-warm start, not just `runInference()`'s fresh-start path) and doubles automatically (2048→4096→8192→16384→32768→65536) on a detected context-overflow failure, never exceeding the smaller of `65536` (`MAX_CONTEXT_SIZE`) or the model's own declared `contextLength`; the currently-in-use (possibly already-doubled) context size is tracked per model and reused across an intelligence-GPU-device restart, rather than falling back to the raw registry `contextLength`. KV-cache is quantized to `q8_0` (`--cache-type-k`/`--cache-type-v`) and `--fit on` is added alongside `--n-gpu-layers 99`, both gated on the resolved binary actually supporting the flags (see `docs/specs/llama-server-vram-tuning.md`).

### 9. API Integrations and Updates

**OpenAI Responses API (September 2025)**:

- Migrated from Chat Completions to new Responses API
- Endpoint: `https://api.openai.com/v1/responses`
- Simplified request format with `input` array instead of `messages`
- New response format with `output` array containing typed items
- Automatic handling of GPT-5 and o-series model requirements
- No temperature parameter for newer models (GPT-5, o-series)

**Anthropic Integration**:

- Routes through IPC handler to avoid CORS issues in renderer process
- Uses main process for API calls with proper error handling
- Model IDs use alias format (e.g., `claude-sonnet-4-6` not date-suffixed versions)

**Gemini Integration**:

- Direct API calls from renderer process
- Increased token limits for Gemini 3.1 Pro (2000 minimum)
- Proper handling of thinking process in responses
- Error handling for MAX_TOKENS finish reason

**API Key Persistence**:

- All API keys now properly persist to `.env` file
- Keys stored in environment variables and reloaded on app start
- Centralized `saveAllKeysToEnvFile()` method ensures consistency

### 10. System Settings Integration

The app can open OS-level settings for microphone permissions, sound input selection, and accessibility:

**IPC Handlers** (in `ipcHandlers.js`):

- `open-microphone-settings`: Opens microphone privacy settings
- `open-sound-input-settings`: Opens sound/audio input device settings
- `open-accessibility-settings`: Opens accessibility privacy settings (macOS only)

**Platform-specific URLs**:

| Platform | Microphone Privacy                                                           | Sound Input                                                  | Accessibility                                                                   |
| -------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| macOS    | `x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone` | `x-apple.systempreferences:com.apple.preference.sound?input` | `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility` |
| Windows  | `ms-settings:privacy-microphone`                                             | `ms-settings:sound`                                          | N/A                                                                             |
| Linux    | Manual (no URL scheme)                                                       | Manual (e.g., pavucontrol)                                   | N/A                                                                             |

**UI Component** (`MicPermissionWarning.tsx`):

- Shows platform-appropriate buttons and messages
- Linux only shows "Open Sound Settings" (no separate privacy settings)
- macOS/Windows show both sound and privacy buttons

### 11. Debug Mode

Enable with `--log-level=debug` or `EKTOSWHISPR_LOG_LEVEL=debug` (can be set in `.env`):

- Logs saved to platform-specific app data directory
- Comprehensive logging of audio pipeline
- FFmpeg path resolution details
- Audio level analysis
- Complete reasoning pipeline debugging with stage-by-stage logging

### 12. Windows Push-to-Talk

Native Windows support for true push-to-talk functionality using low-level keyboard hooks:

**Architecture**:

- `resources/windows-key-listener.c`: Native C program using Windows `SetWindowsHookEx` for keyboard hooks
- `src/helpers/windowsKeyManager.js`: Node.js wrapper that spawns and manages the native binary
- Binary outputs `KEY_DOWN` and `KEY_UP` to stdout when target key is pressed/released

**Compound Hotkey Support**:

- Parses hotkey strings like `CommandOrControl+Shift+F11`
- Maps modifiers: `CommandOrControl`/`Ctrl` → VK_CONTROL, `Alt`/`Option` → VK_MENU, `Shift` → VK_SHIFT
- Verifies all required modifiers are held before emitting key events

**Binary Distribution**:

- Prebuilt binary downloaded from GitHub releases (`windows-key-listener-v*` tags)
- Download script: `scripts/download-windows-key-listener.js`
- CI workflow: `.github/workflows/build-windows-key-listener.yml`
- Fallback to tap mode if binary unavailable

**IPC Events**:

- `windows-key-listener:key-down`: Fired when hotkey pressed (start recording)
- `windows-key-listener:key-up`: Fired when hotkey released (stop recording)

### 13. Custom Dictionary

Improve transcription accuracy for specific words, names, or technical terms:

**How it works**:

- User adds words/phrases through Settings → Custom Dictionary
- Words stored as JSON array in localStorage (`customDictionary` key)
- On transcription, words are joined and passed as `prompt` parameter to Whisper
- Works with both local whisper.cpp and cloud OpenAI Whisper API

**Implementation**:

- `src/hooks/useSettings.ts`: Manages `customDictionary` state
- `src/components/SettingsPage.tsx`: UI for adding/removing dictionary words
- `src/helpers/audioManager.js`: Reads dictionary and adds to transcription options
- `src/helpers/whisperServer.js`: Includes dictionary as `prompt` in API request

**Whisper Prompt Parameter**:

- Whisper uses the prompt as context/hints for transcription
- Words in the prompt are more likely to be recognized correctly
- Useful for: uncommon names, technical jargon, brand names, domain-specific terms

**Auto-learn pipeline (learning corrections from the destination field)**:

The custom dictionary also grows automatically by watching what the user _fixes_ after a paste — this is strictly spelling-correction learning (teaching correct spelling of a word/name the user habitually mis-dictates), not a substitution/replacement engine. Actual find/replace is a separate, existing feature (Snippets: `trigger` → `replacement`, app-filtered); building substitution into the dictionary here would be duplicate scope.

- **Final-pasted-text invariant**: `TextEditMonitor.startMonitoring(text, 30000, {targetPid})` is started (500ms after paste, gated on Settings → Auto-Learn) from the `paste-text` IPC handler in `ipcHandlers.js`, using the _exact same_ `text` argument the handler received — never `textToPaste` (which has snippets applied + a trailing smart-spacing space). Since `text` is always `AudioManager.processTranscription()`'s return value, this baseline is already the post-cleanup text whenever Text Cleanup is active (never the pre-cleanup raw transcript), and the raw transcript unchanged whenever cleanup is off/unreachable or bypassed (dictation-agent/voice-agent route, §17). Regression-locked in `test/helpers/pasteTextMonitorInvariant.test.js`.
- **Detecting a correction**: the monitor emits `text-edited` (`{originalText, newFieldValue}`) on any OS-reported change to the focused field. `ipcHandlers.js`'s `_setupTextEditMonitor()` debounces 1500ms (`AUTO_LEARN_DEBOUNCE_MS`) then calls `_processCorrections()`, which delegates to `src/helpers/autoLearnDictionary.js`'s `processAutoLearnCorrections()`. That in turn calls `src/utils/correctionLearner.js`'s `extractCorrections(originalText, fieldValue, existingDictionary)`, which isolates the edited region (exact substring or a ≥30%-overlap sliding word-window — so text typed _after_ the pasted content is never mistaken for a correction), word-aligns via LCS, bails out on rewrites (>50% of words changed), and filters candidates (already in dictionary, duplicate, case-identical, <3 chars, or Levenshtein edit-distance ratio >0.65). Returns `Array<{from, to}>` — `from` is the original mis-transcribed word, `to` is the correction; only `to` is ever added to the dictionary's Whisper-prompt hint list.
- **Anti-oscillation guard**: before persisting a new `{from, to}` pair, checks whether an existing `source = 'learned'` dictionary row already has `word = from` and `learned_from = to` (case-insensitive) — the exact reverse of a previously-learned correction. If so, the pair is skipped (not persisted) and logged at debug level only (`[AutoLearn] Skipped likely oscillation`) — this is a heuristic against simple A↔B flip-flopping, not a guarantee against longer cycles (A→B→C→A); the existing `undo-learned-corrections` IPC and manual dictionary editing remain the escape hatch.
- **`learned_from` column**: nullable `TEXT` column on `custom_dictionary`, populated only when a brand-new `source = 'learned'` row is inserted (via an optional provenance `Map` argument to `DatabaseManager.setDictionary(words, sourceForNewWords, learnedFromByLowerWord)`). Cleared to `NULL` when a `learned` row is promoted to `manual` (user re-types/endorses it). Deliberately excluded from `getPendingDictionary()`'s cloud-sync push payload — it's local-only provenance for this device's oscillation guard and is never applied as a find/replace rule anywhere.

### 14. GNOME Wayland Global Hotkeys

On GNOME Wayland, Electron's `globalShortcut` API doesn't work due to Wayland's security model. EktosWhispr uses native GNOME shortcuts:

**Architecture**:

1. `main.js` enables `GlobalShortcutsPortal` feature flag for Wayland
2. `hotkeyManager.js` detects GNOME + Wayland and initializes `GnomeShortcutManager`
3. `gnomeShortcut.js` creates D-Bus service at `com.ektoswhispr.App`
4. Shortcuts registered via `gsettings` as custom GNOME keybindings
5. GNOME triggers `dbus-send` command which calls the D-Bus `Toggle()` method

**Key Constants**:

- D-Bus service: `com.ektoswhispr.App`
- D-Bus path: `/com/ektoswhispr/App`
- gsettings path: `/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/ektoswhispr/`

**IPC Integration**:

- `get-hotkey-mode-info`: Returns `{ isUsingGnome, isUsingHyprland, isUsingNativeShortcut }` to renderer
- UI hides activation mode selector when `isUsingNativeShortcut` is true
- Forces tap-to-talk mode (push-to-talk not supported)

**Hotkey Format Conversion**:

- Electron format: `F8`, `CommandOrControl+Shift+Space`
- GNOME format: `F8`, `<Control><Shift>space`
- Backtick (`) → `grave` in GNOME keysym format

### 15. Hyprland Wayland Global Hotkeys

On Hyprland (wlroots Wayland compositor), Electron's `globalShortcut` API and the `GlobalShortcutsPortal` feature don't work reliably. EktosWhispr uses native Hyprland keybindings:

**Architecture**:

1. `main.js` enables `GlobalShortcutsPortal` feature flag for Wayland (fallback)
2. `hotkeyManager.js` detects Hyprland + Wayland and initializes `HyprlandShortcutManager`
3. `hyprlandShortcut.js` creates D-Bus service at `com.ektoswhispr.App` (same as GNOME)
4. Shortcuts registered via `hyprctl keyword bind` (runtime keybinding)
5. Hyprland triggers `dbus-send` command which calls the D-Bus `Toggle()` method

**Detection**:

- Primary: `HYPRLAND_INSTANCE_SIGNATURE` environment variable (set by Hyprland)
- Fallback: `XDG_CURRENT_DESKTOP` contains "hyprland"

**Hotkey Format Conversion**:

- Electron format: `Control+Super`, `CommandOrControl+Shift+Space`
- Hyprland format: `CTRL, Super_L`, `CTRL SHIFT, space`
- Modifier-only combos (e.g., `Control+Super`) → `CTRL, Super_L`

**Bind/Unbind Commands**:

- Register: `hyprctl keyword bind "ALT, R, exec, dbus-send --session ..."`
- Unregister: `hyprctl keyword unbind "ALT, R"`
- Bindings are ephemeral (don't survive Hyprland restart) but re-registered on app startup

**Limitations**:

- Push-to-talk not supported (Hyprland `bind` fires a single exec, not key-down/key-up)
- Requires `hyprctl` on PATH (ships with Hyprland)

### 16. Meeting Recording (Manual) and Note Recording

There is no automatic/background meeting detection or "Meeting Detected" notification in
this codebase — that system (process-app detection, sustained-microphone-activity
detection, and the notification prompt it drove) has been removed entirely. (Google
Calendar integration — `googleCalendarManager.js`/`googleCalendarOAuth.js` — was removed
separately and earlier; there is no calendar-aware context either way.)

What remains is a fully manual, user-initiated flow, plus the unrelated Note Recording
feature that happens to share its backend:

**Manual meeting recording**:

- A dedicated `meeting` hotkey slot (Settings → General → "Meeting Hotkey") is the only
  way a meeting recording starts — there is no passive detection proposing it.
- Pressing the hotkey calls `src/helpers/manualMeetingLauncher.js`'s
  `ManualMeetingLauncher.startManualMeeting()`: creates a note in the "Meetings" folder,
  navigates the control panel to it, and the renderer starts the actual recording via the
  "Meeting Transcription" IPC block in `ipcHandlers.js`
  (`meeting-transcription-prepare/-start/-send/-stop/-cancel`), which streams both the
  microphone and system audio, with diarization/speaker identification and optional
  acoustic echo cancellation (`meetingAecManager.js`).
- `ManualMeetingLauncher` also exposes `setMeetingModeActive()` (used when the control
  panel is snapped in/out of meeting layout) and `broadcastToWindows()`. It has no
  detection state, preferences, or notification-response handling — the class was
  deliberately narrowed to only what the manual flow needs.

**Note Recording**: recording audio while creating/editing a Personal Note
(`src/components/notes/PersonalNotesView.tsx` + `src/stores/meetingRecordingStore.ts`)
consumes the exact same `meeting-transcription-*` IPC channels as manual meeting
recording — it is a different UI entry point into the same backend pipeline, not a
separate detection concept.

**System-audio capture** (used by both flows above once a recording has actually
started, never for detection):

- Windows: `windows-system-audio-helper.exe` (WASAPI process-loopback, excludes
  EktosWhispr's own process tree) via `windowsLoopbackAudioManager.js`
- macOS: `AudioTapManager` (Core Audio Process Tap, macOS 14.2+) via `audioTapManager.js`
- Linux: `linux-system-audio-helper` (PipeWire loopback) via `linuxPortalAudioManager.js`

### 17. Voice Agent Hotkey

A dedicated global hotkey that starts a dictation whose transcript is sent straight to the dictation agent as a command — no wake word ("Hey [AgentName]") needed — and that always bypasses the cleanup model. Separate from the chat agent hotkey (`CHAT_AGENT_KEY`), which toggles the agent overlay window.

**Flow**:

1. Hotkey pressed → `voiceAgent` slot callback in `main.js` → `windowManager.sendToggleVoiceAgent()` → `toggle-voice-agent` IPC to the main window
2. `useAudioRecording.js` starts a recording with `audioManager.setVoiceAgentRequested(true)` (any other start resets it to `false`)
3. On transcription, `resolveReasoningRoute` consults `resolveDictationRouteKind()` (`src/helpers/dictationRouting.js`): a voice agent recording always takes the agent route; if the dictation agent is disabled or has no model, the raw transcript is returned — it never falls back to cleanup

**Storage & IPC**:

- Env var: `VOICE_AGENT_KEY` (persisted via `environment.js`), store key: `voiceAgentKey` (no default — user opt-in)
- IPC handlers: `update-voice-agent-hotkey`, `get-voice-agent-key`
- Hotkey slot: `voiceAgent` (tap-to-toggle; GNOME-native slot via `ToggleVoiceAgent` D-Bus method, KDE via KGlobalAccel, otherwise `globalShortcut`)

**UI**:

- Settings → Hotkeys → "Voice Agent Hotkey" (with cross-slot conflict validation)
- Onboarding: optional step right after the dictation hotkey (activation) step
- Requires the dictation agent to be enabled (Settings → AI Models) for the agent route to apply

**Tests**: `test/helpers/dictationRouting.test.js` (run with `node --test`)

## Development Guidelines

### AI Assistant Workflow — Spec-Driven Development (Mandatory)

From now on, every improvement — feature, refactor, or bug fix — starts from a spec, not from code. Never edit application code before a plan exists and its validation approach is defined, even for changes that sound trivial. Three subagents implement this pipeline:

1. **Plan** — invoke `spec-planner` (`.claude/agents/spec-planner.md`) for any new piece of work. It creates or updates a spec under `docs/specs/<slug>.md` (problem, requirements, design, and a Validation Plan describing exactly how the change will be proven correct). It never edits application code. For a bugfix, the Validation Plan must name a concrete automated regression test that fails before the fix and passes after; for a new feature, it must name the automated test(s) that cover the new behavior. "Not testable" is not a default — UI behavior is covered via component/interaction tests (e.g. React Testing Library, Playwright), and native-binary/hardware-dependent behavior is covered by mocking or stubbing the native binary or IPC boundary it crosses, not skipped. A spec may only forgo an automated test when it explicitly documents why none is possible and states the manual validation step instead — this is a rare, reviewed exception, not a routine escape hatch.
   - **Mandatory TL;DR section.** Every spec must open with a short `## TL;DR` section, immediately after `## Status`, before `## Problem / Goal` — plain language, no more than ~15-20 lines, written for someone who will not read the full Design section. It must cover: (a) what's changing, in one or two sentences; (b) the concrete decisions made, as a short bullet list; (c) any blocking open question that needs the project owner's direct decision, called out explicitly and separately from the rest; (d) the practical impact (what the user/product will experience differently). This exists because specs in this repo routinely run to many pages of dense design rationale — the project owner needs a reviewable summary, not the full instrument, to decide `Draft` → `Approved`. The full Design/Validation Plan detail still belongs in the rest of the document for whoever implements it (`spec-executor`) or audits it later — the TL;DR does not replace that, it's a reading aid layered on top.
2. **Approve** — the user reviews the spec. In conversation, whoever is orchestrating this workflow (the assistant) should present the TL;DR content directly in the chat response rather than pointing the user at the file — the point of the TL;DR is to make review possible without opening a multi-page document. Implementation must not start while the spec's `Status` is `Draft` — only on `Approved`.
3. **Execute** — invoke `spec-executor` (`.claude/agents/spec-executor.md`) to implement exactly what the approved spec's Design section describes, run its Validation Plan, update the relevant docs, and mark the spec `Implemented`. It refuses to start on an unapproved or missing spec.
4. **Gate** — invoke `pr-reviewer` (`.claude/agents/pr-reviewer.md`) before any `git commit` or PR (see below). `spec-executor` invokes this itself before reporting work as commit-ready.

`docs/specs/*.md` describes the target state to build toward; `docs/RECREATION_SPEC.md` remains the authoritative record of current/actual behavior (its §0 lists known divergences from this file) and should be kept in sync as specs are implemented.

**Reasoning-depth convention (not mechanically enforced)**: `spec-planner` should reason thoroughly and deeply before drafting a plan — it's the cheapest place to catch a wrong design. `spec-executor` should execute the approved plan directly and efficiently, without re-deliberating decisions the spec already settled. This is a stylistic guideline for whoever/whatever is operating these agents, not a hard setting — a standalone `Agent` tool call has no "effort" parameter; that control only exists for `agent()` calls inside a `Workflow` script (`opts.effort`). Don't invoke `Workflow` for this pipeline by default — it's a heavier, more expensive orchestration mode reserved for when the user explicitly asks for it.

### AI Assistant Workflow — Worktree + PR Required for Every Code Change (Mandatory)

No application code is ever edited directly on `main`, and no commit is ever pushed straight to `main`. This applies to every code change — features, refactors, and bug fixes alike, no matter how small. Docs-only changes (`docs/`, `README`, other markdown) are exempt and may be made directly on the current branch.

1. **Isolate** — before step 3 (Execute) of the spec-driven workflow above, call `EnterWorktree` to create a fresh git worktree branched from the latest `main`. All implementation for that spec happens inside this worktree. Never skip this because the change "looks small" — the rule is per code change, not per perceived size.
2. **Implement** — `spec-executor` does its work inside the worktree as usual.
3. **Gate** — `pr-reviewer` runs inside the worktree (see Pre-Commit/PR Review below).
4. **Ship** — once `pr-reviewer` returns `PASS`, push the worktree's branch and run `gh pr create` immediately, without waiting for further confirmation. Never `git push` to `main` directly, and never merge the PR yourself — merging is the user's call.
5. **Leave the worktree in place** (`ExitWorktree` with `action: "keep"`) until the PR is merged, so the branch and any follow-up fixes remain available. Only remove it if the user asks to clean up.

If `EnterWorktree` reports the session is already inside a worktree, continue there — don't nest another one.

### AI Assistant Workflow — Mandatory Pre-Commit/PR Review

Before creating any git commit or opening/updating a pull request, invoke the `pr-reviewer` subagent (`.claude/agents/pr-reviewer.md`). This is not optional and does not require the user to ask for it.

The `pr-reviewer` agent:

- Runs the test suite (`npm test`), lint (`npm run lint`), typecheck (`npm run typecheck`), format check, and the renderer build
- Reviews the diff for bugs, regressions, and missing test coverage
- Verifies every bugfix and every new feature in the diff ships with a new or updated automated regression test, per the Validation Plan requirement above — **FAILs** the review if one is missing, unless the spec documents an explicit, reviewed exception for why no automated test was possible
- Checks the diff against the [Non-Negotiable Product Premises](#non-negotiable-product-premises) (privacy, idle RAM/CPU budget, sub-500ms raw-transcription budget) — **FAILs** on any violation
- Guarantees the code follows this document (CLAUDE.md) and `docs/RECREATION_SPEC.md` (the authoritative "what the code actually does" spec — see its §0 for known divergences from this file) as a hard pass/fail gate, not an advisory note
- Returns a `PASS`/`FAIL` verdict

Only proceed with `git commit` / `gh pr create` after a `PASS`. On `FAIL`, fix the reported issues and re-run the agent rather than committing anyway. Per the Worktree + PR rule above, `git commit` happens inside the dedicated worktree and `gh pr create` follows automatically on `PASS` — never commit or push directly to `main`.

### Internationalization (i18n) — REQUIRED

All user-facing strings **must** use the i18n system. Never hardcode UI text in components.

**Setup**: react-i18next (v15) with i18next (v25). Translation files in `src/locales/{lang}/translation.json`.

**Supported languages**: en-US and pt-BR only (`src/locales/en/` and `src/locales/pt/`). This is a deliberate project policy — the app previously supported 9 UI languages (en, es, fr, de, pt, it, ru, zh-CN, zh-TW), but the other 7 locale directories have already been removed from the repository; only `en` (en-US) and `pt` (pt-BR) exist and are maintained/shipped as UI languages today. Do not reintroduce the removed locale files — every new UI string only needs a translation key in these two.

**How to use**:

```tsx
import { useTranslation } from "react-i18next";

const { t } = useTranslation();
// Simple: t("notes.list.title")
// With interpolation: t("notes.upload.using", { model: "Whisper" })
```

**Rules**:

1. Every new UI string must have a translation key in `en/translation.json` and `pt/translation.json` (the only two maintained UI languages — see "Supported languages" above)
2. Use `useTranslation()` hook in components and hooks
3. Keep `{{variable}}` interpolation syntax for dynamic values
4. Do NOT translate: brand names (EktosWhispr, Pro), technical terms (Markdown, Signal ID), format names (MP3, WAV), AI system prompts
5. Group keys by feature area (e.g., `notes.editor.*`, `referral.toasts.*`)

### Adding New Features

1. **New IPC Channel**: Add to both ipcHandlers.js and preload.js
2. **New Setting**: Update useSettings.ts and SettingsPage.tsx
3. **New UI Component**: Follow shadcn/ui patterns in src/components/ui
4. **New Manager**: Create in src/helpers/, initialize in main.js
5. **New UI Strings**: Add translation keys to both maintained language files (`en`, `pt` — see i18n section above)
6. **New Sidecar Binary**: Add download script in `scripts/`, add to `prebuild*` scripts in package.json, add manager in `src/helpers/`, initialize in `main.js`. Spawn the child with `detached: process.platform !== "win32"` so it has its own process group on Unix. Right after spawn call `sidecarPidFile.write(name, child.pid)` and on `close` call `sidecarPidFile.clear(name)`. Add the binary fragment to `EXPECTED_BINARY_FRAGMENTS` in `sidecarReaper.js`. Register a stop function via `sidecarRegistry.register(name, () => manager.stop())` in `registerSidecars()` — that single registration replaces the old `will-quit` line.

### Testing Checklist

- [ ] Test both local and cloud processing modes
- [ ] Verify hotkey works globally
- [ ] Check clipboard pasting on all platforms
- [ ] Test with different audio input devices
- [ ] Verify whisper.cpp binary detection
- [ ] Test all Whisper models
- [ ] Check agent naming functionality
- [ ] Test custom dictionary with uncommon words
- [ ] Verify Windows Push-to-Talk with compound hotkeys
- [ ] Test GNOME Wayland hotkeys (if on GNOME + Wayland)
- [ ] Test Hyprland Wayland hotkeys (if on Hyprland + Wayland)
- [ ] Verify activation mode selector is hidden on GNOME Wayland and Hyprland Wayland
- [ ] Press the meeting hotkey and verify a note is created in the "Meetings" folder and recording starts (manual flow — there is no automatic meeting detection to test)
- [ ] Start a Note Recording from Personal Notes and verify it produces a transcript
- [ ] Create a note about "quarterly revenue projections", search via agent for "revenue" — should match by keyword (FTS5 only; a semantically-related but keyword-different query like "financial forecast" is expected to NOT match)

### Common Issues and Solutions

1. **No Audio Detected**:
   - Check FFmpeg path resolution
   - Verify microphone permissions
   - Check audio levels in debug logs

2. **Transcription Fails**:
   - If the error toast says the whisper-server binary is missing, try the in-toast
     "Download" action first — it downloads and installs the missing binary at runtime
     into `userData/bin/` (see `src/helpers/whisperBinaryInstaller.js`) without needing a
     reinstall. Only fall back to `npm run download:whisper-cpp` (dev-only) if that fails.
   - Ensure whisper.cpp binary is available
   - Check model is downloaded
   - Check temporary file creation
   - Verify FFmpeg is executable

3. **Clipboard Not Working**:
   - macOS: Check accessibility permissions (required for AppleScript paste)
   - Linux: Native `linux-fast-paste` binary (XTest) is tried first, works for X11 and XWayland apps
     - X11: xdotool fallback if native binary unavailable
     - GNOME/KDE Wayland: xdotool (XWayland apps) → ydotool (requires ydotoold daemon)
     - wlroots Wayland (Sway, Hyprland): wtype → xdotool → ydotool
   - Windows: PowerShell SendKeys (built-in) or nircmd.exe (bundled)

4. **Build Issues**:
   - Use `npm run pack` for unsigned builds (CSC_IDENTITY_AUTO_DISCOVERY=false)
   - Signing requires Apple Developer account
   - ASAR unpacking needed for FFmpeg
   - Run `npm run download:whisper-cpp` before packaging (current platform)
   - Use `npm run download:whisper-cpp:all` for multi-platform packaging
   - afterSign.js automatically skips signing when CSC_IDENTITY_AUTO_DISCOVERY=false
   - **Lockfile**: Always use Node 26 when running `npm install` (matches CI, per `.nvmrc`). If your local Node version differs, use `nvm exec 26 npm install`. Running `npm install` with a different major version will produce an incompatible `package-lock.json` that breaks `npm ci` in CI.

5. **Windows Push-to-Talk Binary**:
   - Prebuilt binary downloaded automatically on Windows during build
   - If download fails, push-to-talk falls back to tap mode
   - To compile locally: install Visual Studio Build Tools or MinGW-w64
   - CI workflow (`.github/workflows/build-windows-key-listener.yml`) auto-builds on push to main

6. **Manual Meeting Recording Not Starting**:
   - Confirm a "Meeting Hotkey" is registered under Settings → General
   - Check debug logs under the `"meeting"` category for `startManualMeeting`/note-creation errors
   - System audio capture issues are separate — see system-audio-helper troubleshooting below

7. **`search_notes` not finding a note by meaning**: this is expected — local/cloud semantic
   search was removed (see `docs/specs/remove-qdrant-dependency.md`); the AI agent's `search_notes`
   tool and the agent conversation search are FTS5 keyword matchers only, with no understanding of
   synonyms or paraphrasing.

### Platform-Specific Notes

**macOS**:

- Requires accessibility permissions for clipboard (auto-paste)
- Requires microphone permission (prompted by system)
- Uses AppleScript for reliable pasting
- Notarization needed for distribution
- Shows in dock with indicator dot when running (LSUIElement: false)
- whisper.cpp bundled for both arm64 and x64
- System settings accessible via `x-apple.systempreferences:` URL scheme

**Windows**:

- No special accessibility permissions needed
- Microphone privacy settings at `ms-settings:privacy-microphone`
- Sound settings at `ms-settings:sound`
- NSIS installer for distribution
- whisper.cpp bundled for x64
- **Push-to-Talk**: Native key listener binary (`windows-key-listener.exe`) enables true push-to-talk
  - Uses Windows Low-Level Keyboard Hook (`WH_KEYBOARD_LL`)
  - Supports compound hotkeys (e.g., `Ctrl+Shift+F11`)
  - Prebuilt binary auto-downloaded from GitHub releases
  - Falls back to tap mode if unavailable

**Linux**:

- Multiple package manager support
- Standard XDG directories
- AppImage for distribution
- whisper.cpp bundled for x64
- No standardized URL scheme for system settings (user must open manually)
- Privacy settings button hidden in UI (not applicable on Linux)
- Recommend `pavucontrol` for audio device management
- **Clipboard paste tools** (at least one required for auto-paste):
  - **X11**: `xdotool` (recommended)
  - **Wayland** (non-GNOME): `wtype` (requires virtual keyboard protocol) or `xdotool` (works via XWayland, recommended for Electron apps)
  - **GNOME Wayland**: `xdotool` for XWayland apps only (native Wayland apps require manual paste)
  - Terminal detection: Auto-detects terminal emulators and uses Ctrl+Shift+V
  - Fallback: Text copied to clipboard with manual paste instructions
- **GNOME Wayland global hotkeys**:
  - Uses native GNOME shortcuts via D-Bus and gsettings (no special permissions needed)
  - Hotkeys visible in GNOME Settings → Keyboard → Shortcuts → Custom
  - Default fallback: `F8` when `Control+Super` cannot be registered
  - Push-to-talk unavailable (GNOME shortcuts only fire single toggle event)
  - Falls back to X11/globalShortcut if GNOME integration fails
  - D-Bus transport: `@homebridge/dbus-native` (pure JavaScript, no native addons)

## Code Style and Conventions

- Use TypeScript for new React components
- Follow existing patterns in helpers/
- Descriptive error messages for users
- Comprehensive debug logging
- Clean up resources (files, listeners)
- Handle edge cases gracefully

## Performance Considerations

- Whisper model size vs speed tradeoff
- Audio blob size limits for IPC (10MB)
- Temporary file cleanup
- Memory usage with large models
- Process timeout protection (5 minutes)

## Security Considerations

- API keys and enterprise cloud creds (16 secrets total) encrypted at rest via Electron `safeStorage` → OS keychain (Keychain / DPAPI / libsecret), stored as per-key files in `userData/secure-keys/`. Linux without a keyring falls back to plaintext (Electron default). Closed in #629.
- Context isolation enabled
- No remote code execution
- Sanitized file paths
- Limited IPC surface area

## Future Enhancements to Consider

- Streaming transcription support
- Custom wake word detection
- ~~Multi-language UI~~ (implemented via react-i18next — scaled back to 2 maintained UI languages, en-US and pt-BR, per current project policy; see i18n section above)
- Cloud model selection
- Batch transcription
- Export formats beyond clipboard
