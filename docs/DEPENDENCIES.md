# Dependencies

EktosWhispr has three dependency layers: npm packages, native binaries built from source or
downloaded as prebuilt executables, and on-demand model downloads. All are version-pinned and
resolved through `npm ci` in CI.

## Version pinning

| Mechanism | File                                        | Effect                                                                                |
| --------- | ------------------------------------------- | ------------------------------------------------------------------------------------- |
| Node.js   | [`.nvmrc`](../.nvmrc)                       | Pinned major (currently `26`). `package.json` `engines.node >= 26`.                   |
| Lockfile  | `package-lock.json`                         | Exact npm tree. **Do not regenerate with a different Node major** — CI uses `npm ci`. |
| Electron  | `package.json` → `devDependencies.electron` | Drives the runtime + bundled Chromium.                                                |

## npm packages (key groups)

Notable runtime dependencies (full list in `package.json`):

- **Desktop**: `electron` (41/43 in devDeps), `better-sqlite3`, `electron-updater`.
- **AI / transcription**: `ai` + `@ai-sdk/*` (openai, anthropic, google, groq, azure,
  amazon-bedrock, google-vertex), `onnxruntime-node`, `tinfoil`.
- **Editor / UI**: `react` 19, `react-dom`, `react-i18next`, `tiptap/*`, `shadcn-ui`,
  `tailwindcss` v4, `zustand`, `kysely`, `better-auth`, `zod`.
- **Audio**: `ffmpeg-static` (bundled, no system FFmpeg needed).

Dev tooling: `vite`, `typescript`, `eslint` 10, `prettier`, `electron-builder`, `concurrently`.

## Native binaries

Produced by `npm run compile:native` (or downloaded as a fallback). Source under `resources/`,
output in `resources/bin/`.

| Helper                       | Source                                    | Compile script               | Prebuilt download                      |
| ---------------------------- | ----------------------------------------- | ---------------------------- | -------------------------------------- |
| Windows key listener         | `resources/windows-key-listener.c`        | `compile:winkeys`            | `download:windows-key-listener`        |
| Windows fast paste           | `resources/windows-fast-paste.*`          | `compile:winpaste`           | `download:windows-fast-paste`          |
| Windows system-audio helper  | `resources/windows-system-audio-helper.c` | (via `prebuild:win`)         | `download:windows-system-audio-helper` |
| macOS Globe/Fn listener      | `resources/globe-listener.swift`          | `compile:globe`              | —                                      |
| macOS fast paste             | `resources/macos-fast-paste.*`            | `compile:fast-paste`         | —                                      |
| macOS audio tap              | `resources/audio-tap-manager.*`           | `compile:audio-tap`          | —                                      |
| Linux key listener           | `resources/linux-key-listener.*`          | `compile:linuxkeys`          | —                                      |
| Linux fast paste             | `resources/linux-fast-paste.*`            | `compile:linux-paste`        | —                                      |
| Linux system-audio helper    | `resources/linux-system-audio-helper.*`   | `compile:linux-system-audio` | —                                      |
| Text monitor (all platforms) | `resources/*-text-monitor.*`              | `compile:text-monitor`       | `download:text-monitor`                |
| Media remote (Linux)         | `resources/media-remote.*`                | `compile:media-remote`       | —                                      |
| Meeting AEC helper           | (`scripts/build-meeting-aec-helper.js`)   | —                            | `download:meeting-aec-helper`          |

`nircmd` (Windows clipboard) is Windows-only and download-only (`download:nircmd`).

Build strategy per binary (see `scripts/build-windows-key-listener.js`): try local compile →
fall back to prebuilt download → otherwise warn and let the feature degrade gracefully. The
build never fails when a native helper is unavailable.

## External model downloads (on demand)

Fetched from project GitHub releases or upstream sources, not from npm:

| Asset                  | Script                           | Used by                  |
| ---------------------- | -------------------------------- | ------------------------ |
| whisper.cpp binaries   | `download:whisper-cpp` (`:all`)  | Local Whisper STT        |
| llama.cpp server       | `download:llama-server`          | Local LLM reasoning      |
| sherpa-onnx + Parakeet | `download:sherpa-onnx` (`:cuda`) | NVIDIA Parakeet STT      |
| whisper VAD model      | `download:whisper-vad-model`     | Voice-activity detection |
| Diarization models     | `download:diarization-models`    | Speaker diarization      |
| Meeting AEC helper     | `download:meeting-aec-helper`    | Echo cancellation        |

Large language / speech **models** (GGUF, Parakeet `.onnx`, whisper `.bin`) are downloaded
on demand from the app's Settings screen, not at build time.

## Keeping dependencies current

```bash
npm outdated            # list outdated packages
npm audit               # report known vulnerabilities
npm audit fix           # apply compatible fixes
```

Update policy:

1. Bump the version in `package.json`, then `npm install` with Node 26 to refresh the lockfile.
2. Review the changelog for breaking changes, especially for `electron`, `ai`/`@ai-sdk/*`,
   `better-sqlite3`, and `onnxruntime-node` (native addons).
3. Run `npm run lint && npm run typecheck && npm test` before committing.

Supply-chain posture is documented in [`SECURITY.md`](SECURITY.md) (Supply Chain & Build
Integrity).
