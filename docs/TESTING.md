# Testing

EktosWhispr uses Node's built-in test runner (`node --test`) — no external test framework
config is required. Tests live under `test/` and are split by layer.

## Running the suite

```bash
npm test
```

This expands to (see `package.json`):

```bash
node --test "test/helpers/*.test.js" "test/utils/*.test.js" "test/models/*.test.js" \
  && node --test --import ./test/setup/tsxRegister.js "test/components/*.test.js"
```

- **JS helpers / utils / models** run directly under `node --test`.
- **React component tests** (`.test.js` in `test/components/`) run through `tsxRegister.js`,
  which registers `@testing-library/react` + happy-dom so JSX/TSX executes without a separate
  transpile step.

## Layout

| Directory          | What it covers                                                                                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `test/helpers/`    | Pure main-process helpers — audio cleanup policy, retention sync, auto-learn dictionary, dictation routing, hotkey slots, meeting launchers, native listener keys, download/nircmd, archive extraction, etc. |
| `test/utils/`      | Small shared utilities.                                                                                                                                                                                      |
| `test/models/`     | Model registry / provider data.                                                                                                                                                                              |
| `test/components/` | React component behaviour (e.g. `TranscriptionPreviewOverlay.test.js`) via Testing Library.                                                                                                                  |
| `test/setup/`      | Test harness setup (`tsxRegister.js`).                                                                                                                                                                       |

## Running a subset

Run a single file or directory directly — `node --test` accepts globs:

```bash
node --test test/helpers/audioCleanupPolicy.test.js
node --test "test/helpers/*routing*.test.js"
```

Component tests need the tsx register flag:

```bash
node --test --import ./test/setup/tsxRegister.js test/components/TranscriptionPreviewOverlay.test.js
```

## Coverage expectations

Every bug fix and new feature must ship with a regression test (enforced by `pr-reviewer` and
the spec workflow in `CLAUDE.md`). When writing a new helper or changing behaviour:

- Prefer **unit tests that mock the native binary / IPC boundary** over hardware- or
  binary-dependent integration tests.
- A bug fix's test should **fail before the fix and pass after**; a feature's test should
  **cover the new behaviour**.
- Native-binary / OS-API behaviour is covered by stubbing the binary or IPC channel — not
  skipped.

## Related gates

`npm test` is one of the mandatory pre-commit gates alongside:

```bash
npm run lint
npm run typecheck      # cd src && tsc --noEmit
npm run format:check
```

The `pr-reviewer` agent runs all of these before any commit or PR.
