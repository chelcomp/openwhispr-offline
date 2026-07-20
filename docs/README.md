# Documentation Map

Index of every doc in this repo — what it's for, who reads it, and when it goes stale. Read this file first; it tells you which other file actually answers your question instead of guessing from a filename.

## Start here

| Doc                                  | Purpose                                                                                                                                                                                       |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`../README.md`](../README.md)       | Project overview, features, screenshots, quick start, download links.                                                                                                                         |
| [`../CLAUDE.md`](../CLAUDE.md)       | Technical reference for AI assistants: architecture, file responsibilities, IPC, conventions, and the mandatory spec-driven / pre-commit-review workflow. Read this before touching any code. |
| [`../CHANGELOG.md`](../CHANGELOG.md) | Version history.                                                                                                                                                                              |

## Ground truth vs. target state — read this before trusting any architecture doc

Two documents describe "what the app does," at different points in time, and they can disagree:

- [`RECREATION_SPEC.md`](RECREATION_SPEC.md) — **current/actual behavior**, reverse-engineered directly from the source by independent research passes. Its **§0 "Divergências Importantes vs. CLAUDE.md"** lists every place CLAUDE.md's description doesn't match the real code. When CLAUDE.md and RECREATION_SPEC.md disagree, trust RECREATION_SPEC.md and the code itself.
- [`specs/`](specs/) — **target state to build toward**. One file per planned feature/refactor/fix, produced by the `spec-planner` agent and implemented by `spec-executor`. See [`specs/README.md`](specs/README.md) for the `Draft`/`Approved`/`Implemented` status convention.

`CLAUDE.md` is the day-to-day reference and should be kept in sync as specs land, but it is not the authority on current behavior — RECREATION_SPEC.md and the source are.

## Reference (operational / security)

| Doc                                            | Purpose                                                                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| [`network-allowlist.md`](network-allowlist.md) | Outbound hosts the app contacts, by feature — for firewall/proxy/DNS-filter configuration.                               |
| [`SECURITY.md`](SECURITY.md)                   | Vulnerability reporting process and security model (credential storage, context isolation, scope).                       |
| [`DEPENDENCIES.md`](DEPENDENCIES.md)           | npm packages, native binaries (built vs. downloaded), and on-demand model downloads — version pinning and update policy. |

## Guides (end users / support)

| Doc                                                              | Purpose                                                                                           |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [`guides/TROUBLESHOOTING.md`](guides/TROUBLESHOOTING.md)         | Symptom → fix table for the most common issues, per platform.                                     |
| [`guides/DEBUG.md`](guides/DEBUG.md)                             | How to enable verbose logging and where log files live, per platform.                             |
| [`guides/LOCAL_WHISPER_SETUP.md`](guides/LOCAL_WHISPER_SETUP.md) | Local whisper.cpp model setup, selection, and troubleshooting.                                    |
| [`SETUP.md`](SETUP.md)                                           | Building/running from source: prerequisites, native binary compilation, packaging, quality gates. |

## Contributing

| Doc                                                        | Purpose                                                                             |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [`../.github/CONTRIBUTING.md`](../.github/CONTRIBUTING.md) | How to file issues, report security problems, and submit PRs.                       |
| [`TESTING.md`](TESTING.md)                                 | Test layout (`test/`), how to run the suite and subsets, and coverage expectations. |

## AI agents (`.claude/agents/`)

These are the subagents this repo's harness uses for spec-driven development. See [`../CLAUDE.md`](../CLAUDE.md) ("AI Assistant Workflow" sections) for how they chain together.

| Agent                                                                      | Role                                                                                                                                     |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| [`../.claude/agents/spec-planner.md`](../.claude/agents/spec-planner.md)   | Plans a change: writes/updates a spec under `specs/`. Never touches application code.                                                    |
| [`../.claude/agents/spec-executor.md`](../.claude/agents/spec-executor.md) | Implements an `Approved` spec, runs its Validation Plan, then hands off to `pr-reviewer`.                                                |
| [`../.claude/agents/pr-reviewer.md`](../.claude/agents/pr-reviewer.md)     | Pre-commit/PR gate: tests, lint, typecheck, build, bug review, and documentation compliance (this map + CLAUDE.md + RECREATION_SPEC.md). |

## Not general documentation (tool-specific state — don't edit by hand)

- `.serena/memories/` — Serena MCP's own project memory, not part of this doc set.
- `agent-skills/ektoswhispr-cli/SKILL.md` — Claude Skill reference for scripting against the desktop app's local loopback bridge (`src/helpers/cliBridge.js`). This offline fork has no cloud API — do not reintroduce cloud/remote-backend documentation here without verifying it against real source first (see the divergence note above).

## Keeping this map accurate

Whenever a doc is added, moved, or removed: update this file in the same change. When a `docs/specs/*.md` entry is marked `Implemented`, make sure `CLAUDE.md` and `RECREATION_SPEC.md` were updated to match (per that spec's Validation Plan) — this map assumes both stay current.
