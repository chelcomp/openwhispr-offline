# Conventions

## IPC (Critical)

Every new IPC channel MUST be registered in both:

1. `src/helpers/ipcHandlers.js` (main process handler)
2. `preload.js` (exposes method to renderer via `window.api`)

Context isolation is enabled — renderer cannot access Node APIs directly.

## i18n (Required for all UI strings)

- Never hardcode user-facing strings in components
- Use `useTranslation()` hook: `const { t } = useTranslation()`
- Add keys to the **two** maintained locale files only: `src/locales/en/translation.json` and `src/locales/pt/translation.json` (en-US / pt-BR). The other 7 upstream locales (es, fr, de, it, ru, zh-CN, zh-TW) were removed — do NOT recreate them.
- Group keys by feature area (e.g., `notes.editor.*`, `referral.toasts.*`)
- Do NOT translate: brand names, technical terms (Markdown), format names (MP3), AI system prompts
- Run `npm run i18n:check` to validate all keys present (checks en + pt only)

## Secrets & Env Vars

- **16 secrets** (7 BYOK API keys + 5 enterprise creds [Bedrock×3, Azure, Vertex] + 4 [ASSEMBLYAI, DEEPGRAM, CUSTOM_TRANSCRIPTION, CUSTOM_CLEANUP]): encrypted via `safeStorage` → `userData/secure-keys/{key}` files
- Non-secret env vars (e.g., `LOCAL_TRANSCRIPTION_PROVIDER`, `PARAKEET_MODEL`, hotkey slots, retention days): persisted to `.env` via `saveAllKeysToEnvFile()`
- Renderer reads secrets via IPC (`get-*-key`), writes via debounced IPC (`save-*-key`)
- Never hardcode secrets; never log them

## New Sidecar Binaries (checklist)

1. Add download script in `scripts/`
2. Add to `prebuild*` scripts in `package.json`
3. Create manager in `src/helpers/`; initialize in `main.js`
4. Spawn with `detached: process.platform !== "win32"` (own process group on Unix)
5. Call `sidecarPidFile.write(name, child.pid)` after spawn; `sidecarPidFile.clear(name)` on `close`
6. Add binary fragment to `EXPECTED_BINARY_FRAGMENTS` in `sidecarReaper.js`
7. Register stop fn: `sidecarRegistry.register(name, () => manager.stop())` in `registerSidecars()` — replaces old `will-quit` listener
   NOTE: Qdrant was removed — do not add a Qdrant sidecar.

## TypeScript

- New React components: TypeScript (`.tsx`)
- Main process helpers: JavaScript (`.js`) — mixed codebase
- `src/tsconfig.json` governs renderer; run `npm run typecheck` to verify

## AI Model Registry

Single source of truth: `src/models/modelRegistryData.json`. Derive configs from `ModelRegistry.ts` — do not duplicate model IDs inline.

## Inference Scopes

4 scopes: `dictationCleanup`, `dictationAgent`, `noteFormatting`, `chatIntelligence`. Each has independent provider/model/mode settings in store. `noteFormatting` falls back to `dictationCleanup`. Resolver: `selectResolvedLLMConfig(state, scope)` in `settingsStore.ts`.

## Hotkey Slots

Named slots: `dictation`, `agent` (chat overlay), `voiceAgent` (direct-to-agent), `meeting`. Managed by `src/helpers/hotkeyManager.js`. Platform fallbacks: GNOME Wayland uses D-Bus + gsettings; Hyprland uses `hyprctl keyword bind`; KDE uses KGlobalAccel. Push-to-talk not supported on Wayland.

## Clipboard (Platform-specific)

- macOS: AppleScript (requires accessibility permission)
- Windows: PowerShell SendKeys → nircmd fallback
- Linux: native XTest binary → xdotool → wtype → ydotool chain

## Wayland Global Shortcuts

Electron `globalShortcut` does not work on Wayland. Platform detection: GNOME (`XDG_CURRENT_DESKTOP`), Hyprland (`HYPRLAND_INSTANCE_SIGNATURE`), KDE. Each has a dedicated manager in `src/helpers/`.
