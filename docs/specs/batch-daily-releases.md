# Batch Daily Releases (At Most One Automatic Release Per Day)

## Status
Implemented

## TL;DR

- **What's changing**: `auto-release.yml` (the workflow that produces the `chore(release): x.y.z`
  commits) currently fires on **every push to `main`**, so every merged PR gets its own patch bump,
  tag, and downstream full Windows build/publish. This spec switches its trigger to a **daily cron**
  (plus `workflow_dispatch` for manual/on-demand use) and adds an explicit "were there any commits
  since the last release tag?" gate, so it releases **at most once per calendar day, and only if
  there's something new to release**.
- **Concrete decisions**:
  - This repo's release mechanism is a **fully custom bash script inside a GitHub Actions job** —
    not semantic-release, release-please, standard-version, or changesets (none of those tools,
    their config files, or their devDependencies exist in this repo). It unconditionally runs
    `npm version patch --no-git-tag-version`, commits, tags `vX.Y.Z`, and pushes both — every time
    the job runs, with no "nothing to release" awareness. That means the standard advice ("just
    switch to a cron trigger, the tool already no-ops cleanly") does **not** apply as-is here — a new
    explicit gate step has to be added, since none exists today.
  - Trigger changes from `on: push: branches: [main]` to `on: schedule` (one daily cron entry,
    proposed `0 3 * * *` UTC) `+ workflow_dispatch` (with a `force` boolean input for manual/testing
    use, bypassing the gate).
  - New step compares the latest `v*.*.*` tag against `HEAD` on `main` (`git rev-list <tag>..HEAD
    --count`); if zero commits and `force` wasn't set, the job logs "nothing to release" and exits
    cleanly (green, no-op) instead of bumping/tagging/pushing.
  - The now-meaningless `github.event.head_commit.message` loop-prevention guard (doesn't apply to
    `schedule`/`workflow_dispatch` events anyway) is removed — the new gate fully subsumes its intent.
  - `release.yml` (tag-push-triggered full signed build + GitHub Release publish) and
    `build-and-notarize.yml` are **untouched** — the tag-push trigger chain works identically
    regardless of whether the tag was pushed by a cron-triggered or push-triggered run.
  - Versioning scheme itself (always `patch`, no conventional-commit major/minor detection,
    no `CHANGELOG.md` generation) is unchanged — out of scope.
- **No blocking open question.** One non-blocking judgment call: the exact cron hour (`03:00 UTC`
  proposed) is a placeholder the project owner can adjust at `Approved` time.
- **Practical impact**: today, `main` got **12 separate releases on 2026-07-19 alone**
  (`chore(release): 0.0.3` through `0.0.14` — confirmed via `git log`), each one also triggering the
  full signed Windows build/publish in `release.yml`. After this change, at most one release (and
  therefore at most one `release.yml` full-build run) happens per day, only on days with at least one
  new commit on `main`, and the version number in an install therefore changes at most once daily
  instead of once per merged PR. Anyone needing an out-of-cycle release (e.g. an urgent hotfix) can
  still get one immediately via manual `workflow_dispatch`.

## Problem / Goal

`auto-release.yml` triggers on every push to `main` (i.e., every merged PR, since PRs are merged as
single pushes to `main`) and unconditionally bumps the patch version, commits `chore(release): x.y.z`,
tags it, and pushes the tag. That tag push in turn triggers `release.yml`, which downloads all native
binaries, builds and signs the full Windows installer set (`nsis` + `portable`), and publishes a
GitHub Release (`--publish always`). Confirmed empirically: `git log --oneline --format="%ad %s"
--date=short -- package.json` shows **12 release commits on a single day** (2026-07-19:
`0.0.3` → `0.0.14`), each presumably having kicked off its own full `release.yml` build/publish.

This is wasteful in two ways: (1) it produces a confusing, rapidly-incrementing version history with
no relationship to meaningful milestones, and (2) it re-runs the most expensive workflow in the repo
(full signed Windows packaging + publish) once per merge instead of once per day, compounding the CI
cost problem already being addressed for PR-time builds in the sibling spec
`docs/specs/speed-up-pr-ci.md` (read for background; not edited by this spec — that spec explicitly
excludes `auto-release.yml`/`release.yml` from its own scope).

The user's request: batch the automatic release process so it fires **at most once per calendar
day**, and **only** on days where there's actually a new, unreleased commit on `main` since the last
release — not unconditionally, and not more than daily.

## Requirements

- **R1 — Daily-cron trigger.** `auto-release.yml`'s `on:` block changes from `push: branches: [main]`
  to a `schedule` trigger with exactly one cron entry (proposed `0 3 * * *`, i.e. 03:00 UTC daily —
  see Open Questions for adjustability) plus `workflow_dispatch`. The `push`-to-`main` trigger is
  removed entirely — merging a PR no longer, by itself, causes a release.
- **R2 — "Nothing to release" gate.** Add an explicit step, run before any version-bump/commit/tag
  work, that determines whether there is at least one commit on `main` since the most recent
  `v*.*.*` tag (via `git rev-list <latest-tag>..HEAD --count`, or equivalent). If the count is `0`
  (no new commits) and the run was not manually forced (R4), the job must log a clear "nothing to
  release since <tag>, skipping" message and end successfully without creating a bump commit, tag,
  or push. If no `v*.*.*` tag exists at all yet (bootstrap edge case), treat this as "there are
  unreleased commits" (proceed), preserving today's behavior for a brand-new repo/tag history.
- **R3 — Downstream chain preserved.** No change to `release.yml`'s trigger (`push: tags:
  "v*.*.*"` + `workflow_dispatch`) or to `build-and-notarize.yml`. The tag push produced by a
  cron-triggered (or manually-dispatched) `auto-release.yml` run must be a genuine `git push
  origin <tag>` using the existing `secrets.GH_TOKEN` (a PAT, not the default `GITHUB_TOKEN` —
  required because pushes authenticated with the default token don't trigger other workflows), so
  `release.yml` fires exactly as it does today. This requires no design change — only confirmation
  the existing checkout step's `token: secrets.GH_TOKEN` is left untouched.
- **R4 — Manual/on-demand override stays available.** `workflow_dispatch` on `auto-release.yml`
  accepts an optional `force` boolean input (default `false`). When `force` is `true`, R2's gate is
  bypassed and the release proceeds even with zero new commits since the last tag. This is both the
  emergency-release escape hatch (a maintainer needing an out-of-cycle release doesn't have to wait
  for the next day's cron) and the mechanism this spec's own Validation Plan uses to exercise the
  no-op path on demand without waiting a full day.
- **R5 — Retire the now-dead loop-prevention guard.** Remove the job-level `if:
  "!startsWith(github.event.head_commit.message, 'chore(release):')"` condition. It only ever
  existed to stop the workflow from re-triggering itself on the release commit's own push — a
  concern that doesn't apply to `schedule`/`workflow_dispatch` events (`github.event.head_commit` is
  unset for both) and is fully subsumed by R2 anyway: once a commit is released and tagged, `HEAD`
  and the latest tag point at the same commit, so the very next run's R2 gate already reports zero
  new commits and no-ops, with no special-casing of the commit message required.
- **R6 — No versioning-scheme change.** `npm version patch --no-git-tag-version` stays exactly as
  today: unconditional patch bump, no conventional-commit parsing, no major/minor detection, no
  `CHANGELOG.md` generation. Only the trigger and the gate change.
- **R7 — Not a CDE/production-data change.** This is a CI/release-infrastructure change only; it
  touches no application runtime code, no customer data, no payment/AML/KYC data, and introduces no
  new network listener or telemetry. None of the Non-Negotiable Product Premises (privacy,
  idle-resource budget, transcription-speed budget, single-instance, graceful degradation, migration
  safety, data retention) are implicated — noted explicitly so `pr-reviewer` doesn't have to
  re-derive this from a workflow-YAML-only diff.

## Non-goals

- Adopting `semantic-release`, `release-please`, `standard-version`, or `changesets`. Confirmed none
  are in use today (no config files, no devDependencies); introducing one would be a much larger
  change (conventional-commit enforcement, `CHANGELOG.md` generation, potentially different
  versioning semantics) than "batch the existing script to daily" calls for.
- Generating or updating `CHANGELOG.md`. Not done today by any workflow; not added here.
- Any change to `release.yml`'s or `build-and-notarize.yml`'s triggers, jobs, or steps.
- Deduplicating `build-and-notarize.yml`'s per-merge `push`-to-`main` runs. That workflow still runs
  once per feature-branch merge regardless of this change (it has its own independent `push` trigger,
  untouched here) — reducing *that* frequency, if ever desired, is a separate, larger scope decision
  than "batch the release commit/tag/publish cadence," and overlaps with the sibling
  `speed-up-pr-ci.md` spec's territory (which itself explicitly excludes `auto-release.yml`/
  `release.yml`). Not duplicated or extended here.
- Enforcing the daily cap on manually-dispatched (`force`) runs. A human explicitly running
  `workflow_dispatch` is a deliberate action, not the "automatic" cadence the user's request was
  about — see Design/Open Questions for the reasoning.
- Any change to `package.json`'s current `0.0.x` version numbering itself (e.g. resetting, bumping
  to reflect a different scheme) — out of scope, purely a cadence/trigger change.

## Design

### Current mechanism (confirmed by reading the live files, not assumed)

- `.github/workflows/auto-release.yml` — job `bump-and-tag`, triggered by `on: push: branches:
  [main]`, guarded by `if: "!startsWith(github.event.head_commit.message, 'chore(release):')"`.
  Steps: checkout (`fetch-depth: 0`, `token: secrets.GH_TOKEN`) → setup Node 26 →
  `npm version patch --no-git-tag-version` → commit `chore(release): <version>` → `git tag -a
  v<version>` → `git push origin main` → `git push origin v<version>`.
- `.github/workflows/release.yml` — triggered by `push: tags: ["v*.*.*"]` + `workflow_dispatch`.
  Downloads all native binaries, runs `npm run build:win -- --publish always`, which builds the
  signed `nsis` + `portable` Windows targets and publishes a GitHub Release via electron-builder's
  GitHub provider.
- `.github/workflows/build-and-notarize.yml` — triggered independently by `push: branches: [main,
  develop]` + `pull_request: branches: [main]` + `workflow_dispatch`; unrelated to and unaffected by
  this spec (confirmed: it does not consume `auto-release.yml`'s output, it has its own `push`
  trigger on `main` that fires on every merge regardless of release cadence).
- No `CHANGELOG.md` writes anywhere in this chain, and no conventional-commit-based version-type
  selection — every release commit bumps `patch`, confirmed by the flat `npm version patch` call and
  the `git log` evidence in Problem/Goal.

### Changes to `.github/workflows/auto-release.yml`

**Trigger block**: replace the `on: push: branches: [main]` block with two trigger keys:

- `schedule`, containing exactly one entry: `cron: '0 3 * * *'` (03:00 UTC daily — see Open
  Questions for the "why this hour, and is it adjustable" note).
- `workflow_dispatch`, with one input: `force` (`type: boolean`, `required: false`, `default:
  false`, description along the lines of "Release even if there are no new commits since the last
  tag (for testing or an out-of-cycle release)").

**Job-level `if:` condition**: remove entirely (R5) — no replacement job-level condition is needed;
the new step-level gate (below) does the work.

**New step, "Check for unreleased commits"**, inserted after the checkout step (and can run before
or after "Setup Node.js" — ordering between those two doesn't matter, since the check only needs
`git`, already available on the runner):

- Ensures tags are available locally (the existing checkout step's `fetch-depth: 0` already pulls
  full history including tags via `actions/checkout@v4`'s default `fetch-tags: true`; an explicit
  `git fetch --tags` in this step is optional belt-and-suspenders, not required).
- Finds the most recent tag matching `v*.*.*` reachable in the repo (e.g. via `git tag --list
  'v*.*.*' --sort=-v:refname`, taking the first line). If none exists, treats the situation as "there
  are unreleased commits" unconditionally (bootstrap case — matches today's implicit behavior, since
  today's script has never had to consider "no tag exists yet" as a skip condition).
- If a tag was found, counts commits reachable from `HEAD` (the checked-out `main`) that are not
  reachable from that tag (`git rev-list <tag>..HEAD --count`).
- Produces a step output (e.g. `has_changes`, `true`/`false`) that is `true` when: no tag exists yet,
  OR the commit count is greater than zero, OR the `workflow_dispatch` `force` input is `true`.
  `false` otherwise.
- When the result is `false`, logs a clear, human-readable line identifying the tag it compared
  against and that zero new commits were found, so a skipped day is self-explanatory from the
  Actions run log alone (no need to read the workflow file to understand why nothing happened).

**Existing steps "Bump patch version" and "Commit and push tag"**: both gain a condition — they run
only when the check step's `has_changes` output is `true`. When it's `false`, both steps are skipped
(shown as "skipped" in the Actions UI, not failed), and the job as a whole completes successfully
with no commit, tag, or push produced.

**Unaffected**: the checkout step's `token: secrets.GH_TOKEN` (still required so the eventual tag
push triggers `release.yml` — the default `GITHUB_TOKEN` does not trigger other workflows on push, so
this must not be changed to the default token), the `permissions: contents: write` block, the Node
setup step, and the exact bump/commit/tag/push commands themselves (R6 — no versioning-scheme
change).

### `release.yml` / `build-and-notarize.yml`

No file changes. `release.yml`'s `push: tags: ["v*.*.*"]` trigger fires identically regardless of
whether the tag was pushed by a `schedule`-triggered or `workflow_dispatch`-triggered run of
`auto-release.yml` — GitHub Actions triggers workflows off the underlying git ref-push event, not off
what triggered the workflow that performed the push. `build-and-notarize.yml` is entirely independent
(its own `push`-to-`main` trigger, unrelated to release cadence) and is out of scope here (see
Non-goals).

## Validation Plan

### Automated

No local GitHub Actions runner exists in this environment, and this repo's `node --test` harness
(`test/helpers/*.test.js`, `test/utils/*.test.js`) has no precedent for exercising
`.github/workflows/*.yml` content or `schedule`/`cron` trigger semantics — this is a CI-config-only
change with no application code touched. Per CLAUDE.md's documented, reviewed exception to the
"every change needs an automated regression test" rule (the same exception already invoked by the
sibling `speed-up-pr-ci.md` spec for the same class of change): **the proof for this spec is a real,
live GitHub Actions run**, exercised via `workflow_dispatch` in the implementing PR before merge (or
immediately after, against `main`) — malformed YAML (bad cron syntax, bad `on:` block, bad step
`if:` expression) fails immediately and visibly; the specific behavioral claims (gate correctly
detects zero vs. nonzero unreleased commits; `force` bypasses the gate; the tag push still triggers
`release.yml`) are only observable by watching real runs, not by static inspection of the diff.

### Manual

Per CLAUDE.md's mandatory Worktree + PR workflow, this change lands via a dedicated branch and PR;
that PR is the vehicle for the following checks:

1. On the implementation branch (before or after merge — `workflow_dispatch` works either way since
   it can target any ref), manually trigger `Auto Release` from the Actions tab with `force` left at
   its default (`false`). Confirm behavior depends on whether there are genuinely unreleased commits
   at that moment:
   - If there are unreleased commits (e.g. this very implementation PR's merge commit, once merged):
     confirm the "Check for unreleased commits" step reports a nonzero count and `has_changes=true`,
     and that "Bump patch version"/"Commit and push tag" both run, producing a new
     `chore(release): x.y.z` commit, a new `vX.Y.Z` tag, and both being pushed to `main`.
   - Immediately trigger `workflow_dispatch` a second time, right after step 1's run completes, with
     no new commits landed in between. Confirm the check step now reports zero unreleased commits and
     `has_changes=false`, and that "Bump patch version"/"Commit and push tag" both show as *skipped*
     in the Actions UI — no new commit, tag, or push is produced. This is the concrete proof of R2's
     no-op path, not just the happy path.
2. Trigger `workflow_dispatch` a third time with `force=true` while there are still zero unreleased
   commits (immediately after step 1's second run). Confirm the gate is bypassed — the check step
   reports `has_changes=true` (due to `force`) even with a zero commit count — and a new release is
   produced despite nothing new having landed. This proves R4.
3. In the Actions tab, confirm the tag pushed in step 1 shows a corresponding `Release` (`release.yml`)
   run that was triggered by that tag push, and that it completes its full signed build/publish as it
   does today — proving R3 (downstream chain intact, unaffected by the trigger-type change upstream).
4. Confirm the workflow file's `schedule` entry is accepted by GitHub (visible without error under
   the workflow's "..." → view file, or simply by the workflow appearing correctly in the Actions
   tab's workflow list with no YAML-parse warning) — this is the "malformed cron syntax fails
   immediately" check called out above.
5. Confirm no `push`-to-`main` event (e.g. an unrelated, later PR merge in the same day) triggers
   `Auto Release` at all any more — check the Actions run history after a subsequent, unrelated PR
   merges to `main` and confirm no new `Auto Release` run appears until the next scheduled cron tick
   (or another manual dispatch).

### Docs

- `docs/RECREATION_SPEC.md` §7.9 ("CI (`.github/workflows/`)"): update the one-line description of
  `auto-release.yml` — currently "`auto-release.yml` (bump patch automático em push main)" — to
  describe the new daily-cron (`+ workflow_dispatch` with `force`) trigger and the "only if there are
  unreleased commits since the last tag" gate, so this section stays accurate to the new trigger
  type and no-op behavior.
- `docs/README.md`: no changes expected — it does not enumerate individual CI workflow behavior
  today (confirmed, same conclusion the sibling `speed-up-pr-ci.md` spec reached for its own changes);
  verify at execution time per its own "keeping this map accurate" note regardless.
- `CLAUDE.md`: no changes expected — CLAUDE.md does not currently mention `auto-release.yml`,
  `release.yml`, or the release process at all, so there is nothing stale to correct.

## Open Questions

- **Non-blocking**: the exact cron hour (`0 3 * * *` UTC proposed, chosen as a low-traffic time that
  post-dates a typical US workday and pre-dates a typical EU workday, so a given day's release
  reflects everything merged the previous day rather than racing an in-flight merge) is a judgment
  call, not a hard requirement — the project owner can pick any single fixed UTC hour at `Approved`
  time without changing the design.
- **Non-blocking, stated as a decision rather than left open**: manually-dispatched (`force=true` or
  otherwise) runs are intentionally exempt from the "once per day" cap — a maintainer can trigger as
  many manual releases in one day as they want. Flagging this explicitly in case the project owner
  wants manual dispatch to also respect the daily cap (which would remove the emergency-release
  escape hatch this design otherwise relies on) — the default assumption here is that "automatically"
  in the original request refers to the unattended/scheduled path, not deliberate human action.
