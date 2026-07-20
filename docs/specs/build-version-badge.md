# Build Version Badge (App Version + Git Commit Hash)

## Status
Implemented

## TL;DR
- Adds a small, non-intrusive badge in the bottom-left corner showing the app version and the short git commit hash the running build was compiled from, to speed up support/troubleshooting.
- Decisions made:
  - Reuses the existing `get-app-version` IPC (`window.electronAPI.getAppVersion()` → `app.getVersion()`) for the version — no new IPC channel needed.
  - Captures the git short hash at **build time** via a new Vite `define` (`__GIT_COMMIT_HASH__`, computed with `git rev-parse --short HEAD` inside `src/vite.config.mjs`), baked into the renderer bundle. Falls back to `"unknown"` if `.git` isn't present at build time (e.g. a source archive with no git history) — this never breaks the build or the app.
  - Shown in the **Control Panel** (all views — Home, Notes, Dictionary, Snippets, Upload, Transform, Settings), replacing/consolidating the version text that already exists in `ControlPanelSidebar.tsx`'s footer (which shows only the version, in the wrong corner) into one shared, bottom-left-corner badge.
  - Shown in the **main dictation overlay** too, per the request, but **deliberately suppressed while the overlay is in its idle 96×96 base size** (Non-Negotiable Premise: dictation UX must not be cluttered) — it only appears once the overlay has expanded (menu/toast states, ≥240×280), at very low contrast and `pointer-events-none`, so it never sits over the record button or blocks dragging.
  - Not shown on the Agent overlay, Update-Notification overlay, or Transcription-Preview overlay — these are small transient popups, not persistent "screens," and CLAUDE.md's overlay-size table confirms they're all comparably small/frameless; adding chrome there raises the same clutter risk as the base dictation overlay without the payoff (they're not typically where users get "stuck" needing to report a version).
- No blocking open question — this is additive UI-only work with an existing IPC to build on.
- Practical impact: anyone taking a screenshot of either window (overlay once expanded, or any Control Panel screen) now has the version + short git hash visible for support/troubleshooting, without it interfering with dictation or settings usage.

## Problem / Goal
Support/troubleshooting currently has no fast way to tell, from a screenshot or screen-share, exactly which build a user is running — `ControlPanelSidebar.tsx` shows the semantic version only (`v0.0.19`), and there's no git commit hash anywhere in the UI. Multiple builds can share the same `package.json` version between releases (e.g. mid-development, or a hotfix branch), so the version alone is often not enough to pin down the exact code a user has. Surfacing the git short hash next to the version, visibly and consistently across the app's windows, closes that gap.

## Requirements
1. A shared `VersionBadge` component displays `v{version} ({gitHash})` (or a graceful partial when either piece is unavailable — see Design) in the bottom-left corner of:
   - The Control Panel window, across all of its views (Home, Notes, Dictionary, Snippets, Upload, Transform, Settings) — i.e. a single fixed-position element at the Control Panel's shell level, not duplicated per view.
   - The main dictation overlay window, but only while it is in an expanded state (menu open or toast visible) — never at the idle 96×96 base size.
2. The git short hash is captured at build time from `git rev-parse --short HEAD` and baked into the renderer bundle as a compile-time constant; it must not require a network call or any runtime IPC round-trip to the main process.
3. If `.git` is unavailable at build time (e.g. building from a git-history-less archive), the build must still succeed, with the badge falling back to a fixed placeholder (`"unknown"`) for the hash portion rather than crashing or showing `undefined`.
4. The app version portion continues to come from the existing `get-app-version` IPC (`app.getVersion()`), which already exists and is already consumed by `ControlPanelSidebar.tsx` and `useUpdater.ts` — no new IPC channel.
5. The existing version-only text in `ControlPanelSidebar.tsx`'s footer is removed and replaced by the new shared badge, so the Control Panel doesn't show the version twice in two different corners.
6. The badge must be non-interactive (`pointer-events-none`) wherever it could otherwise sit over draggable regions or interactive controls, in both windows.
7. The badge text is selectable/copyable for troubleshooting (e.g. via a `title` attribute with the full string, so a user can screenshot or hover-copy it) without needing new UI chrome (no button, no modal).

## Non-goals
- No "copy to clipboard" button or dedicated diagnostics/about screen — this is a passive, always-visible label only.
- No change to the update-check/version-comparison logic in `useUpdater.ts` or `updater.js`.
- No git branch name, build date/timestamp, or CI run ID in the badge — hash + version only, per the user's explicit ask.
- No badge on the Agent overlay, Update-Notification overlay, or Transcription-Preview overlay (see TL;DR rationale).
- No new IPC channel; no new persisted setting.

## Design

### Non-Negotiable Product Premises compliance
- **Privacy**: purely local/build-time data (version + git hash of the running build); no network call, no telemetry. Compliant.
- **Performance (idle budget)**: no new timer/polling — the badge reads `GIT_COMMIT_HASH` as a static import (already in memory, zero cost) and calls the existing `getAppVersion()` IPC once on mount, exactly like `ControlPanelSidebar.tsx` already does today. No measurable RAM/CPU impact.
- **Speed (sub-500ms transcription budget)**: not on the audio/transcription path at all; the overlay-variant badge only affects the expanded (menu/toast) visual states, never the record→transcribe→paste flow itself.
- **Single instance**: unaffected.
- **Graceful degradation**: if `git rev-parse` fails at build time (no `.git`), or if `getAppVersion()`'s IPC promise rejects/resolves without a `version` field at runtime, the badge renders whatever partial information it has (see fallback rules below) — it never throws, never blocks rendering of the window it's in.
- **Migration safety**: no settings/schema/storage changes at all.
- **Data retention**: not applicable — no data is collected, stored, or persisted by this feature.

### Build-time git hash capture (`src/vite.config.mjs`)
Inside the existing `defineConfig(({ mode }) => { ... })` function (same place `envDir`/`env` are already resolved), compute the short git hash once by shelling out to `git rev-parse --short HEAD` (Node's `child_process.execSync`, run with `cwd` set to the repo root — the same `envDir` already computed a few lines above — and wrapped in a `try/catch`; on failure/absence of git, fall back to the literal string `"unknown"`). Add a top-level `define` key to the returned Vite config object: `__GIT_COMMIT_HASH__: JSON.stringify(<the resolved hash or "unknown">)`. This mirrors the existing `write-runtime-env` plugin's pattern of baking build-time values into the output, just via `define` instead of a written JSON file, since this value only needs to be readable from renderer JS, not from a static asset.

Add the corresponding ambient type declaration to `src/vite-env.d.ts`: `declare const __GIT_COMMIT_HASH__: string;` (next to the existing `/// <reference types="vite/client" />` and module declarations already there), so `tsc --noEmit` (the `typecheck` npm script) doesn't fail on the new global.

### New pure utility module: `src/utils/buildInfo.ts`
Framework/Electron-free, following the same "pure logic, unit-testable in isolation" pattern already used by `src/helpers/autoLearnDictionary.js` and `src/utils/correctionLearner.js`. Exports:
- `GIT_COMMIT_HASH: string` — resolves to `__GIT_COMMIT_HASH__` when the Vite define is present, or the literal `"dev"` when it's `undefined` (covers any non-Vite consumer, e.g. a future test harness that imports this module without going through the Vite build — mirrors the existing `typeof __X__ !== "undefined"` guard idiom already common for Vite-defined globals).
- `formatVersionBadgeLabel(version: string | null | undefined, gitHash: string): string` — a pure formatting function with these explicit, testable rules:
  - Both present → `"v{version} ({gitHash})"` (e.g. `"v0.0.19 (a1b2c3d)"`).
  - `version` missing/falsy, `gitHash` present and not `"unknown"`/`"dev"` → `"({gitHash})"` (hash-only, no leading `v`).
  - `gitHash` is `"unknown"` or `"dev"` (i.e. not a real resolved hash), `version` present → `"v{version}"` (version-only, hash portion silently omitted rather than shown as noise).
  - Both missing/placeholder → empty string `""` (caller renders nothing rather than an empty badge shell).

### New shared component: `src/components/VersionBadge.tsx`
- Props: `variant: "controlPanel" | "overlay"`, and for the overlay variant only, `visible: boolean` (the mounting window passes in whether the overlay is currently in an expanded state — see below).
- On mount, calls `window.electronAPI?.getAppVersion?.()` exactly as `ControlPanelSidebar.tsx` does today (same optional-chaining/catch-and-ignore-on-failure pattern), stores the resolved `version` in local state.
- Computes its label via `formatVersionBadgeLabel(version, GIT_COMMIT_HASH)` from `buildInfo.ts`; renders nothing (`null`) if the computed label is empty.
- Rendering, `variant="controlPanel"`: `fixed bottom-2 left-3` (relative to the Control Panel window viewport), small/low-contrast text (matching the existing sidebar footer's `text-[11px] text-muted-foreground/70` styling being removed from `ControlPanelSidebar.tsx`), `pointer-events-none` on the wrapping element with `title={label}` on the text node itself so a user can still hover for a full-string tooltip/select-and-copy; `z-[60]` for this variant — deliberately *above* Radix Dialog's `z-50` overlay/content (used by `SidebarModal.tsx`, which backs `SettingsModal.tsx`), so the badge remains visible while the Settings modal (or any other `z-50` dialog) is open, rather than being hidden behind its full-screen overlay. This is safe because the badge is a `pointer-events-none` text label with no interactive surface — it never intercepts clicks meant for the modal or anything else above it, so there is no actual stacking conflict despite the numerically high value.
- QA follow-up fix: `ControlPanelSidebar.tsx`'s footer container (`SupportDropdown` + Settings button) originally used `pb-2`, placing its content at the same vertical position (`bottom-2`) as the `VersionBadge`, causing visual overlap between the badge text and the Settings button. Changed to `pb-7` to open enough clearance for the badge without touching the button.
- Rendering, `variant="overlay"`: identical styling but only rendered at all when `visible` is `true`; additionally `opacity-30` at rest (further de-emphasized versus the Control Panel variant, since this sits over an always-on-top window the user is actively dictating with), `hover:opacity-90` transition for readability on demand, still fully `pointer-events-none` so hovering the corner never intercepts a drag or click meant for the record button.

### Mount points
- `src/components/ControlPanel.tsx`: mount `<VersionBadge variant="controlPanel" />` once at the top-level shell (outside the per-view `activeView` switch, so it's present across Home/Notes/Dictionary/Snippets/Upload/Transform/Settings without duplicating it seven times).
- `src/App.jsx`: mount `<VersionBadge variant="overlay" visible={...} />` at the root render, passing `visible` from whatever existing state App.jsx already tracks for its expanded/menu/toast sizes (the same state that currently drives which `WINDOW_SIZES` entry — `BASE` vs `WITH_MENU`/`WITH_TOAST`/`EXPANDED` — the window is resized to, per `src/helpers/windowConfig.js`). `visible` should be `false` whenever the overlay is at `WINDOW_SIZES.BASE` (96×96) and `true` for any larger state.
- `src/components/ControlPanelSidebar.tsx`: remove the existing `appVersion` state, its `getAppVersion()` effect, and the `v{appVersion}` paragraph — this responsibility moves entirely to the new shared `VersionBadge` mounted once in `ControlPanel.tsx`, so the Control Panel doesn't show the version in two different corners.

### Files touched
- `src/vite.config.mjs` (git hash capture + `define`)
- `src/vite-env.d.ts` (ambient `__GIT_COMMIT_HASH__` declaration)
- `src/utils/buildInfo.ts` (new, pure)
- `src/components/VersionBadge.tsx` (new)
- `src/components/ControlPanel.tsx` (mount badge)
- `src/App.jsx` (mount badge, wire `visible`)
- `src/components/ControlPanelSidebar.tsx` (remove now-redundant version footer)
- i18n: the badge itself has no translatable copy (it's a raw version/hash string, exempt from i18n same as brand names/format names per CLAUDE.md's i18n rules) — no `translation.json` changes needed.

## Validation Plan

### Automated
- New test file `test/utils/buildInfo.test.js` (run via the existing `node --test` harness, using the same native-TypeScript-stripping `await import(".../buildInfo.ts")` pattern already used by `test/utils/bedrockRegions.test.js`), asserting `formatVersionBadgeLabel`'s rules from Design:
  - `formatVersionBadgeLabel("0.0.19", "a1b2c3d")` → `"v0.0.19 (a1b2c3d)"`.
  - `formatVersionBadgeLabel(null, "a1b2c3d")` → `"(a1b2c3d)"`.
  - `formatVersionBadgeLabel("0.0.19", "unknown")` → `"v0.0.19"`.
  - `formatVersionBadgeLabel("0.0.19", "dev")` → `"v0.0.19"`.
  - `formatVersionBadgeLabel(null, "unknown")` → `""`.
  - `formatVersionBadgeLabel(undefined, undefined as unknown as string)` → `""` (defensive, shouldn't throw).
  - `GIT_COMMIT_HASH` resolves to `"dev"` when imported outside a Vite-defined context (i.e. exactly as `node --test` will import it, confirming the `typeof __GIT_COMMIT_HASH__ !== "undefined"` guard doesn't throw a `ReferenceError` under plain Node).
- No automated component-render test is added for `VersionBadge.tsx`/its mount points — this repo has no React component-rendering test harness (no `vitest`/`jsdom`/`@testing-library/react` in `package.json`, confirmed by inspection; `npm test` only runs plain-Node `node --test` against `test/helpers/*.test.js` and `test/utils/*.test.js`, none of which render JSX). Introducing that test infra is out of scope for this UI-only spec. All actual JSX rendering logic in `VersionBadge.tsx` is intentionally kept to prop-driven visibility (`visible`) and calling the already-existing, already-untested-at-the-component-level `getAppVersion()` IPC pattern — the only genuinely new *logic* (the label-formatting rules and the fallback hash constant) is fully covered by the pure-function test above, per this repo's documented exception for native-binary/hardware/render-harness gaps. Manual steps below cover the actual on-screen behavior.

### Manual
1. Run `npm run dev` (or equivalent dev launch) from inside a git checkout; confirm the terminal/build doesn't error.
2. Open the Control Panel; confirm a small `v{version} ({hash})` label appears in the bottom-left corner, is present and identical across every sidebar view (Home, Notes, Dictionary, Snippets, Upload, Transform) and inside Settings, and does not appear twice (confirm the old sidebar-footer version line is gone).
3. Hover the badge; confirm a tooltip/title shows the full label and the badge does not intercept clicks on anything beneath/near it.
4. Trigger the dictation overlay's expanded state (open its menu, or trigger a toast) and confirm the badge appears in its bottom-left corner, dim by default, more visible on hover, `pointer-events-none` (drag and the record button still work normally with the mouse positioned over the badge's corner).
5. Return the dictation overlay to its idle 96×96 state and confirm the badge is not rendered at all.
6. Temporarily rename/move `.git` (or build from a fresh export without git history) and rebuild; confirm the build still succeeds and the badge falls back to version-only (no `"unknown"` noise) per the formatting rule, then restore `.git`.
7. Confirm the Agent overlay, Update-Notification overlay, and Transcription-Preview overlay show no badge.

### Docs
- No `CLAUDE.md` section currently documents version display; no update strictly required, but if `spec-executor` finds the "Agent Naming System"/window-architecture sections a natural place to mention this, a one-line pointer is welcome (not required for `Implemented` status).
- `docs/RECREATION_SPEC.md`: no known current-behavior divergence created by this change; no update required.

## Open Questions
None blocking. (Non-blocking note for the project owner: if branch name or build date ever becomes useful for support, that would be a follow-up spec — deliberately out of scope here per the user's explicit ask for version + hash only.)
