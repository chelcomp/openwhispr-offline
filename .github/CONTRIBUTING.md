# Contributing to EktosWhispr (offline fork)

This is an independent offline-first fork of [EktosWhispr](https://github.com/EktosWhispr/ektoswhispr).
It strips cloud-only features and adds capabilities specific to fully local operation
(meeting audio recording, app-scoped snippets, local text transforms, active-app detection).

This fork evolves independently — no upstream merges are planned.

## Filing issues

- Bugs and feature requests: open an issue in **this repository**.
- For transcription or audio problems, attaching debug logs is a huge help — see
  [`docs/guides/DEBUG.md`](../docs/guides/DEBUG.md) for how to enable debug logging and where the log files
  live, and [`docs/guides/TROUBLESHOOTING.md`](../docs/guides/TROUBLESHOOTING.md) for common fixes to try first.

## Reporting security issues

**Please do not open public issues for security vulnerabilities.**
Follow the process in [`docs/SECURITY.md`](../docs/SECURITY.md).

## Contributing code

The short version:

1. Fork the repo and create a feature branch off `main`.
2. Make your change, keeping the diff focused.
3. Run `npm run lint` and `npm run format` before opening a PR.
4. Open a pull request against this repo's `main` branch and fill in the description
   so reviewers can see the "why".

### Local setup

| Requirement | Notes                                                                             |
| ----------- | --------------------------------------------------------------------------------- |
| Node.js     | Version pinned in [`.nvmrc`](../.nvmrc) (currently `26`). Use `nvm use` to match. |
| Install     | `npm install`                                                                     |
| Run dev     | `npm run dev`                                                                     |
| Lint        | `npm run lint`                                                                    |
| Format      | `npm run format`                                                                  |
| Build       | `npm run build` (or `build:mac` / `build:win` / `build:linux`)                    |

Platform-specific setup, model downloads, and packaging details are in
[`README.md`](../README.md) and [`docs/guides/LOCAL_WHISPER_SETUP.md`](../docs/guides/LOCAL_WHISPER_SETUP.md).

See [`docs/README.md`](../docs/README.md) for a full index of this repo's documentation.

## Thanks

Thanks for taking the time to contribute.
