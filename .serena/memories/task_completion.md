# Task Completion Checklist

Before marking any feature/fix done, verify applicable items:

## Code Quality

- [ ] `npm run typecheck` passes (renderer TypeScript)
- [ ] `npm run lint` passes (root + src/)
- [ ] `npm run i18n:check` passes if any UI strings were added/changed (checks en + pt only)

## New UI Strings

- [ ] All user-facing strings use `t("key")` via `useTranslation()` — no hardcoded text
- [ ] Keys added to the **two** locale files only: `src/locales/en/translation.json` and `src/locales/pt/translation.json` (do NOT recreate the 7 removed upstream locales: es, fr, de, it, ru, zh-CN, zh-TW)

## IPC Changes

- [ ] New channel registered in `src/helpers/ipcHandlers.js`
- [ ] Same channel exposed in `preload.js`

## Settings Changes

- [ ] New setting added to `useSettings.ts`
- [ ] UI added to `src/components/SettingsPage.tsx`

## New AI Models

- [ ] Added to `src/models/modelRegistryData.json` only (single source of truth)

## Sidecar Binary (if added)

- [ ] Download script in `scripts/`
- [ ] Added to `prebuild*` in `package.json`
- [ ] `sidecarRegistry.register()` call in `registerSidecars()` in `main.js`
- [ ] Fragment in `EXPECTED_BINARY_FRAGMENTS` in `sidecarReaper.js`
      NOTE: Qdrant was removed — do not reintroduce a Qdrant sidecar or embedding model.

## Tests

- [ ] `npm test` passes (runs test/helpers + test/utils + test/models + test/components via node --test)
- [ ] For dictation routing changes: `test/helpers/dictationRouting.test.js` specifically

## Secrets

- [ ] No secrets hardcoded or logged
- [ ] New secrets follow safeStorage pattern (not `.env`)
- [ ] Non-secret persistent env vars use `saveAllKeysToEnvFile()`

## Platform Considerations

- [ ] Clipboard behavior correct on macOS/Windows/Linux
- [ ] Hotkey works on Wayland (GNOME/Hyprland/KDE) if hotkey-related
- [ ] Native binary paths use `{platform}-{arch}` suffix pattern
