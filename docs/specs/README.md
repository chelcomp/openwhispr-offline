# Specs

One file per planned feature/refactor/fix, produced and maintained by the `spec-planner` / `spec-executor` agents (see [CLAUDE.md](../../CLAUDE.md), "AI Assistant Workflow — Spec-Driven Development"). Filename: kebab-case slug of the change, e.g. `voice-agent-hotkey.md`.

See [`../README.md`](../README.md) for the full documentation index.

## Status values

- `Draft` — written by `spec-planner`, not yet approved. `spec-executor` must not implement it.
- `Approved` — reviewed and approved by the user. Ready for `spec-executor`.
- `Implemented` — code lands, validation passed, docs updated. Set by `spec-executor`.

## Relationship to other docs

- `docs/specs/*.md` — target state to build toward (forward-looking).
- [`docs/RECREATION_SPEC.md`](../RECREATION_SPEC.md) — authoritative record of current/actual code behavior, including documented divergences from `CLAUDE.md` (see its §0).
- [`CLAUDE.md`](../../CLAUDE.md) — architecture/behavior reference for the app as a whole.

When a spec here is implemented, update the relevant sections of the other two docs in the same change, per the spec's own Validation Plan.
