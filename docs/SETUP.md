# Development Setup

This guide covers building and running EktosWhispr from source. For end-user install
instructions see [`../README.md`](../README.md) (Quick start) and
[`guides/LOCAL_WHISPER_SETUP.md`](guides/LOCAL_WHISPER_SETUP.md) (model setup).

## Prerequisites

| Requirement | Notes                                                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js     | Version pinned in [`.nvmrc`](../.nvmrc) (currently `26`). Run `nvm use` to match. `package.json` sets `engines.node >= 26`.                             |
| Git         | Any recent version.                                                                                                                                     |
| C compiler  | Only needed to build native helpers locally. If absent, prebuilt binaries are downloaded automatically (see [Native binaries](#native-binaries) below). |
| FFmpeg      | Bundled via `ffmpeg-static` — no system install required.                                                                                               |

Platform build tools (only if compiling native helpers yourself):

- **Windows**: Visual Studio Build Tools (MSVC) **or** MinGW-w64 (GCC/Clang).
- **macOS**: Xcode Command Line Tools (`xcode-select --install`).
- **Linux**: `build-essential` plus `libssl-dev` (for `better-sqlite3` / native addons).

## Install

```bash
git clone https://github.com/chelcomp/ektoswhispr-offline.git
cd ektoswhispr-offline
npm install          # postinstall runs `electron-builder install-app-deps`
```

Use Node 26 exactly to avoid producing an incompatible `package-lock.json` (CI reads it via
`npm ci`). On a different major version, run `nvm exec 26 npm install`.

## Run in development

```bash
npm run dev
```

`dev` runs the Vite renderer and the Electron main process concurrently. The `predev` hook
compiles native helpers and downloads the meeting AEC helper automatically.

For the main process only:

```bash
npm run dev:main      # electron with --dev flag
npm run dev:renderer  # vite dev server only
```

## Native binaries

Several platform-specific helpers are required at runtime (key listeners, paste helpers,
system-audio capture, text monitors, the macOS audio tap, meeting AEC). They are produced by
`npm run compile:native`, which runs every `compile:*` script in `package.json`:

```bash
npm run compile:native
```

Each `build-*.js` script in `scripts/` follows the same strategy
(see `scripts/build-windows-key-listener.js` for the canonical example):

1. If the binary already exists and is newer than its C/source file, skip.
2. Otherwise try to **compile from source** locally (MSVC → MinGW-w64 → Clang on Windows;
   `clang`/`gcc` on macOS/Linux).
3. If no compiler is available, **download a prebuilt binary** from the project's GitHub
   releases (via the matching `download-*.js` script).
4. If neither works, warn and let the feature fall back gracefully — this never fails the build.

Prebuilt-only downloads (no local source counterpart) are also available directly:

```bash
npm run download:whisper-cpp          # current platform
npm run download:whisper-cpp:all      # all platforms (packaging)
npm run download:llama-server
npm run download:sherpa-onnx          # add :cuda for CUDA build
npm run download:nircmd               # Windows clipboard helper
npm run download:windows-key-listener
npm run download:windows-system-audio-helper
npm run download:windows-fast-paste
npm run download:meeting-aec-helper
npm run download:whisper-vad-model
npm run download:diarization-models -- --output-dir resources/bin/diarization-models
```

Compiled output lands in `resources/bin/`. Source lives under `resources/`
(e.g. `resources/windows-key-listener.c`).

## Debug logging

Set `--log-level=debug` (CLI flag) or `EKTOSWHISPR_LOG_LEVEL=debug` (env / `.env`) to enable
verbose logging. See [`guides/DEBUG.md`](guides/DEBUG.md) for log-file locations and categories.

## Packaging

```bash
npm run build            # renderer build + electron-builder (current platform)
npm run build:mac        # .dmg (x64 + arm64)
npm run build:win        # .exe NSIS installer
npm run build:linux      # .AppImage / .deb / .rpm (see build:linux:* variants)
npm run pack             # unsigned --dir build (CSC_IDENTITY_AUTO_DISCOVERY=false)
```

The `prebuild*` / `prepack` / `predist` hooks compile native helpers and download every
required binary and model before `electron-builder` runs. Windows release builds additionally
pull `nircmd`, the Windows fast-paste, key-listener, and system-audio helpers.

## Quality gates

Run before opening a PR (also enforced by `pr-reviewer`):

```bash
npm run lint
npm run format
npm run typecheck        # cd src && tsc --noEmit
npm test
```

See [`TESTING.md`](TESTING.md) for the test layout and [`DEPENDENCIES.md`](DEPENDENCIES.md)
for the full dependency list.
