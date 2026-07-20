# Suggested Commands

## Development

```bash
npm run dev          # Start renderer (Vite) + main (Electron) concurrently; predev runs compile:native + download:meeting-aec-helper
npm run dev:renderer # Vite only
npm run start        # Electron without Vite hot-reload
```

## Building

```bash
npm run build:win    # Windows installer (prebuild downloads all binaries + models)
npm run build:mac    # macOS (add :arm64 / :x64 for single arch)
npm run build:linux  # Linux AppImage + deb (+ :appimage/:deb/:rpm/:tar variants)
npm run pack         # Unsigned unpacked dir build (CSC_IDENTITY_AUTO_DISCOVERY=false)
```

## Testing & Quality

```bash
npm test                  # node --test on test/helpers + test/utils + test/models, and (via tsxRegister) test/components
npm run typecheck         # tsc --noEmit in src/
npm run quality-check     # format:check + typecheck
npm run lint              # eslint (root + src/)
npm run format            # eslint --fix + prettier --write
npm run i18n:check        # verify all translation keys present in en + pt (NOT 9 languages)
```

## Asset Downloads (run manually if missing)

```bash
npm run download:whisper-cpp        # current platform (add :all for every platform)
npm run download:llama-server       # llama.cpp server
npm run download:sherpa-onnx        # Parakeet/sherpa runtime (add :cuda for CUDA)
npm run download:meeting-aec-helper
npm run download:whisper-vad-model
npm run download:diarization-models -- --output-dir resources/bin/diarization-models
npm run download:nircmd             # Windows clipboard helper
npm run download:windows-key-listener
npm run download:windows-system-audio-helper
npm run download:windows-fast-paste
npm run download:text-monitor
```

NOTE: `download:qdrant` and `download:embedding-model` were REMOVED — Qdrant/semantic search is gone.

## Native Compilation

```bash
npm run compile:native   # Compiles all native C/Swift sources (runs automatically in predev/prebuild)
```

## Notes

- `predev` and `prebuild*` run `compile:native` + binary/model downloads automatically
- `GITHUB_TOKEN` env var increases GitHub API rate limits for download scripts
- Use `npm run pack` for quick local testing without code signing
- Use **Node 26** (matches `.nvmrc`); running `npm install` with a different major regenerates an incompatible `package-lock.json`
