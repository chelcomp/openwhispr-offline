# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.7.x   | :white_check_mark: |
| < 1.7   | :x:                |

## Reporting a Vulnerability

**Please do not open public issues for security vulnerabilities.**

Use [GitHub's private vulnerability reporting](https://github.com/chelcomp/ektoswhispr-offline/security/advisories/new)
to submit a report.

We will acknowledge your report within **48 hours** and aim to release a fix
within **7 days** for critical issues.

## Scope

The following are in scope:

- Remote code execution via crafted audio files or transcription output
- Privilege escalation through native binaries (key listeners, paste helpers)
- Credential exposure (API keys, OAuth tokens, database credentials)
- Cross-site scripting (XSS) in the Electron renderer
- Insecure IPC between main and renderer processes
- Supply chain attacks via dependencies or native compilation

Out of scope:

- Issues requiring physical access to an already-unlocked machine
- Denial of service against the local application
- Social engineering

## Security Model

- **Local-first audio processing** — Audio is transcribed on-device using
  whisper.cpp or nvidia parakeet. Recordings are not sent to external servers unless explicitly
  configured by the user.
- **Credential storage** — API keys provided by users (BYOK) and enterprise
  cloud credentials (AWS, Azure, Vertex) are encrypted at rest using
  Electron's `safeStorage` API, which delegates to the OS keychain (Keychain
  on macOS, DPAPI on Windows, libsecret on Linux). Encrypted blobs are stored
  under `userData/secure-keys/`. Non-secret preferences (regions, endpoints,
  hotkeys, flags) continue to live in `.env`. On Linux systems without a
  keyring, secrets fall back to plaintext to match Electron's default
  behavior.
- **Native binaries** — Platform-specific helpers (key listeners, paste
  utilities) are compiled from source during the build process.
- **Context isolation** — The Electron renderer runs with context isolation
  enabled and a restricted preload bridge.

## Supply Chain & Build Integrity

EktosWhispr is built from source in CI; nothing is pulled from an untrusted host at runtime
unless the user explicitly configures a cloud provider.

- **Native helpers** — Key listeners, paste helpers, system-audio capture, text monitors, the
  macOS audio tap, and the meeting AEC helper are compiled from C/Swift source in `resources/`
  during the build (`npm run compile:native`). If no local compiler is available, a prebuilt
  binary is downloaded from the project's **own GitHub releases** (see
  [`DEPENDENCIES.md`](DEPENDENCIES.md)). The build degrades gracefully when a helper is
  missing — it never fails the build or pulls from a third-party mirror.
- **npm dependencies** — Pinned via `package-lock.json` and installed with `npm ci` in CI.
  `npm audit` is part of the change-quality gates. Only the pinned Node major (`.nvmrc`,
  currently 26) is used, so the lockfile stays reproducible.
- **External models** — whisper.cpp, llama.cpp, sherpa-onnx/Parakeet, VAD, and diarization
  assets are fetched from project GitHub releases or the upstream model hosts named in
  `package.json` scripts. Speech/models are downloaded **on demand from the app's Settings
  screen**, not automatically at launch.
- **Credential handling** — See _Security Model_ above. Secrets never transit the supply chain;
  only encrypted blobs (or, on keyring-less Linux, OS-default plaintext) touch disk.
- **Updates** — App updates use `electron-updater`. Per the project's privacy premise, version
  checks are user-visible and user-controlled — there is no silent background update fetch.

If you discover a supply-chain concern (a compromised dependency, a tampered release asset, or
a build step that reaches an unexpected host), treat it as an in-scope vulnerability under
_Scope_ above and report it through the private advisory process.

## Disclosure Policy

We follow coordinated disclosure. Once a fix is released, we will credit
reporters in the changelog (unless they prefer to remain anonymous).
