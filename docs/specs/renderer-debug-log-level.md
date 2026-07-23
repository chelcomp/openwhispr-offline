# Renderer debug logs never appear when log level resolution falls back

## Status
Implemented

> Approved by project owner on 2026-07-23 ("faz o ajuste").

## TL;DR
Renderer-side debug logs (including the full LLM prompt via `logReasoning`) never
reach the debug log file, even with debug logging enabled, because
`src/utils/logger.ts`'s `resolveLogLevel()` permanently caches `"info"` the first
time it fails to reach `window.electronAPI.getLogLevel()` (a real early-startup
race against main's `get-log-level` IPC handler). Once cached, every subsequent
renderer debug log — for the rest of the session — is dropped client-side before
it's ever forwarded to main, regardless of the app's real (debug) level.

- What's changing: `resolveLogLevel()` stops permanently latching
  `cachedLevel = "info"` on any non-successful `getLogLevel()` resolution.
  Instead, only a genuinely successful, normalizable level is ever cached;
  every other outcome resets `levelPromise = null` so the *next* renderer log
  call re-queries `getLogLevel()` instead of being stuck at `"info"` forever.
- Key decision (the crux of the fix): the `levelPromise` reset must happen in
  the *outer* `resolveLogLevel()` function, after awaiting the promise —
  **not** inside the inner async IIFE that computes the fallback. Two of the
  three fallback paths (`getLogLevel` unavailable, or throwing synchronously)
  never hit an `await` inside that IIFE, so a reset written inside it gets
  silently clobbered by the outer `levelPromise = (async () => {...})()`
  assignment that runs immediately after the (synchronously-completed) IIFE
  returns. Only the outer-scope reset survives all three fallback paths.
- No blocking open question — this is a narrowly-scoped, already-diagnosed bug
  fix with a clear root cause and reproduction.
- Practical impact: with debug logging enabled, users (and support/engineers
  reading `debug-*.log`) will reliably see renderer `[DEBUG]` lines, including
  the `LOCAL_STREAM_START`/`*_REQUEST` reasoning-stage entries that contain the
  full LLM prompt (system + user messages) — needed to diagnose cleanup/agent
  prompt issues. Today those entries are silently missing whenever the fallback
  race is hit, with no error or indication anything was dropped.

## Problem / Goal

`src/services/ReasoningService.ts` logs the full LLM request at debug level via
`logger.logReasoning(...)` in two places:

- `LOCAL_STREAM_START` (~line 412): `{ model, agentName, messages }` for local
  (llama-server) streaming.
- `` `${providerName.toUpperCase()}_REQUEST` `` (~line 193): `{ endpoint, model,
  hasApiKey, temperature, max_tokens, reasoning_effort, messages }` for cloud
  providers.

Both go through `logger.logReasoning` → `log("debug", stage, details,
"reasoning")` in `src/utils/logger.ts`. That `log()` calls `resolveLogLevel()`
and drops the entry client-side (`shouldLog`) if the resolved level isn't debug
or finer — before ever reaching the main-process IPC forward
(`window.electronAPI.log`).

`resolveLogLevel()` memoizes its result in module-level `cachedLevel` /
`levelPromise`:

```
if (cachedLevel) return cachedLevel;
if (!levelPromise) {
  levelPromise = (async () => {
    if (window.electronAPI?.getLogLevel) {
      try {
        const level = normalizeLevel(await window.electronAPI.getLogLevel());
        if (level) { cachedLevel = level; return level; }
      } catch { /* fall back */ }
    }
    cachedLevel = defaultLevel;   // <-- permanent "info", bug
    return cachedLevel;
  })();
}
return levelPromise;
```

If `getLogLevel()` throws, is unavailable, or returns something
`normalizeLevel()` can't map to a known level (including `undefined`, which is
exactly what happens if the first renderer log fires before main's
`get-log-level` IPC handler — registered in `ipcHandlers.js` — is ready to
answer), the fallback branch runs and sets `cachedLevel = "info"` **forever**.
There is no retry: every future call short-circuits on `if (cachedLevel) return
cachedLevel` at the top of the function, for the remaining lifetime of the
renderer process (or until something calls the *renderer's*
`logger.refreshLogLevel()` — which today has zero call sites anywhere in the
codebase, so nothing ever un-sticks it).

This was regressed by commit `b0c48b6e` ("Standardize logging on log levels
with renderer IPC and .env refresh"), which introduced this caching scheme
while migrating off the old `debugLoggerRenderer.js`.

**Empirical confirmation** (already gathered, not to be re-derived): a real
`debug-*.log` captured with debug logging enabled contains main-process
`[DEBUG]` lines (proving `debugLogger.getLevel()` in main is genuinely
`"debug"`, since `DebugLogger.write()` gates on `shouldLog` — `debugLogger.js`
~line 138 — before writing anything) but **zero** renderer `[DEBUG]` lines —
every renderer entry in that file is `[INFO]` or coarser, and there is no
`LOCAL_STREAM_START` / `*_REQUEST` reasoning marker anywhere in the file. This
is only explainable by the renderer's `cachedLevel` having latched onto
`"info"` early and never recovering, even though main's real level is
`"debug"`.

**Goal**: make the renderer's log-level resolution recover from a failed/racy
first lookup, so a debug-enabled session reliably logs renderer debug output
(most importantly the reasoning-stage prompt dumps) once the real level is
reachable — without introducing unbounded retries or console spam if
`getLogLevel` is genuinely and permanently unavailable (e.g. non-Electron
context).

## Requirements

- `resolveLogLevel()` must not permanently cache a fallback value. When the
  `getLogLevel()` IPC call fails, is unavailable, or returns a value that does
  not normalize to a known `LogLevel`, the function must:
  - return `defaultLevel` ("info") for *that specific call* (so logging
    behavior for the current call is unaffected — no behavior change for
    callers), and
  - leave the module able to retry on the *next* call: neither `cachedLevel`
    nor `levelPromise` may remain set to a value that would cause a subsequent
    call to skip re-invoking `getLogLevel()`.
- Only a level that `normalizeLevel()` accepts from a successful
  `getLogLevel()` response may be cached in `cachedLevel` (unchanged from
  today for the success path).
- No unbounded retry storm: each `log()` call still only resolves the level
  once per call (today's behavior) — the fix changes what gets *cached*
  between calls, not how many times a single call retries.
- The existing `logger.refreshLogLevel()` renderer-side export (already present
  in `src/utils/logger.ts`, currently uncalled) must continue to reset both
  `cachedLevel` and `levelPromise` to `null` — no signature or behavior change
  needed there; it's unrelated to this fix (wiring up a call site for live
  settings-toggle updates is out of scope, see Non-goals) but must not be
  broken by it.
- Once the real level is `"debug"`, subsequent `logger.logReasoning(...)` calls
  from `ReasoningService.ts` must be forwarded to main (`window.electronAPI.log`)
  and land in `debug-*.log`, including the full `messages` array.

## Non-goals

- Not fixing/wiring a call site for the renderer's `logger.refreshLogLevel()`
  to react to a live Settings toggle of debug logging mid-session. That's a
  separate, legitimate follow-up (today toggling debug logging on *after* the
  renderer already resolved a successful, cached `"info"` would still require
  a page reload or explicit `refreshLogLevel()` call to pick up the change) but
  is not what's being fixed here — this spec is scoped to the startup-race /
  permanent-fallback bug specifically, where the process is never a genuinely
  successful resolution.
- Not changing the shape, verbosity, or content of what `ReasoningService.ts`
  logs via `logReasoning` (the `messages` array is already logged in full;
  this spec only ensures the log actually gets through).
- Not touching `src/helpers/debugLogger.js` (the main-process side) — it
  already gates correctly (`write()` checks `shouldLog` before writing) and
  main's `get-log-level` IPC handler already returns the correct level; the
  bug is entirely in the renderer's client-side cache.
- Not changing IPC channel names, the `get-log-level` handler's signature, or
  any settings key.
- Independent of the prompt-template-placeholders work — separate spec,
  branch, and PR.

## Design

**File touched**: `src/utils/logger.ts` only (no other file needs a change for
this fix — `debugLogger.js`, `ipcHandlers.js`, `preload.js`, and
`ReasoningService.ts` are all already correct and untouched).

**Required invariant** (the executor may choose the exact control-flow
mechanism, but the rewritten `resolveLogLevel()` must satisfy this): *after
any call that does not end in a successful, normalizable `getLogLevel()`
response, the next distinct call to `resolveLogLevel()` must re-invoke
`window.electronAPI.getLogLevel()` — it must not short-circuit on either a
stale `cachedLevel` or a stale already-resolved `levelPromise`.* Concretely:

1. `cachedLevel` must only ever be assigned a value obtained from a
   genuinely successful, normalizable `getLogLevel()` response (unchanged from
   today's success branch — no change needed there).
2. On every path that does *not* successfully resolve a level — `window`/
   `electronAPI.getLogLevel` unavailable (no `await` ever reached),
   `getLogLevel()` rejecting, or `getLogLevel()` resolving to a value
   `normalizeLevel()` rejects — the function must still return `defaultLevel`
   ("info") for the *current* call (no behavior change for the caller), but
   must leave `levelPromise` reset to `null` **once execution has returned to
   the outer `resolveLogLevel()` scope**, not merely from inside the inner
   async IIFE.

**Why "inside the IIFE" is the wrong location, and must be avoided**: a naive
implementation that resets `levelPromise = null` as the last statement inside
the `(async () => { ... })()` IIFE is broken for the two fallback paths that
never hit an `await` — `window.electronAPI?.getLogLevel` being falsy
(unavailable), and `getLogLevel()` throwing *synchronously* before any
suspension point. In both cases the IIFE's body runs synchronously to
completion (async functions run synchronously up to their first `await`, and
these paths contain none before the fallback `return`), so the sequence is:
(a) the IIFE executes fully, including its own `levelPromise = null` write,
and produces an already-resolved `Promise` value; (b) *only then* does the
outer assignment `levelPromise = (async () => {...})()` run, overwriting that
`null` back to the newly-created (already-resolved-to-`"info"`) promise
reference. The next distinct call sees a non-null `levelPromise` and returns
the stale resolved value again without ever re-invoking `getLogLevel()` — the
bug persists for these two paths even after the "fix." (The IPC-race path that
was empirically diagnosed — `getLogLevel()` resolving, async, to `undefined`
— does go through a real `await ipcRenderer.invoke(...)`, so a reset placed
inside the IIFE happens to work for that specific path; but the fallback
branch also covers the other, non-awaiting paths, and the fix must cover all
of them, not just the one that was empirically observed.)

**Correct shape**: perform the `levelPromise` reset in the *outer*
`resolveLogLevel()` function body, after `await`-ing the promise it just
created or reused, guarded on `cachedLevel` still being unset (i.e., the
resolution did not succeed) — e.g. capture the resolved value from
`levelPromise`, then check `if (!cachedLevel) { levelPromise = null; }` before
returning that value. This location is reached identically regardless of
whether the inner IIFE suspended at an `await` or ran fully synchronously,
because the outer function always awaits the promise before this line runs.

Concurrency note: if multiple `log()` calls are in flight simultaneously
during the same failed-resolution window, they all await the same in-flight
`levelPromise` and all correctly receive the fallback value for that round —
the reset only needs to affect the *next* round of distinct calls, not calls
already awaiting the current promise.

**No change needed to**:
- `normalizeLevel`, `LOG_LEVELS`, `shouldLog`, `logToConsole`, `log()`, the
  `logger` object's public methods, or `refreshLogLevel()` (already correct;
  the bug is `resolveLogLevel()`'s fallback branch specifically).
- `debugLogger.js` (main process) — `getLevel()`/`shouldLog()`/`write()` are
  already correct; confirmed by the empirical log evidence above (main
  `[DEBUG]` lines present).
- `ipcHandlers.js`'s `get-log-level` handler or `preload.js`'s `getLogLevel`
  bridge — both already correct.
- `ReasoningService.ts`'s two `logger.logReasoning(...)` call sites — already
  logging the full `messages` array; nothing to add there.

**Non-Negotiable Product Premises check**:
- Privacy: no change — debug logging is already opt-in (`--log-level=debug` /
  `EKTOSWHISPR_LOG_LEVEL=debug`) and writes only to a local file
  (`userData/logs/debug-*.log`); this fix does not add any new data collection,
  telemetry, or network call, and the logged `messages` payload never leaves
  the device (same as today, when it does get through).
- Idle RAM/CPU: no change — this only affects whether an already-opt-in debug
  log call is forwarded; no new timers, polling, or background work. The
  fallback retry is bounded (one `getLogLevel()` IPC round-trip per
  subsequent log call until a real level resolves, same cost profile as
  today's single attempt, just no longer permanently skipped).
- Sub-500ms transcription budget: no change — `logReasoning` calls are
  fire-and-forget debug logging, not on the hotkey-release → transcript path
  in a blocking way, and this fix doesn't add any new work to that path beyond
  what already exists (an `await resolveLogLevel()` that was already there).
- Single instance / graceful degradation / migration safety / data retention:
  not applicable — no schema, settings key, storage format, or process
  lifecycle change.

## Validation Plan

- **Automated**: add `test/components/loggerLogLevelFallback.test.js` (runs
  under `node --test --import ./test/setup/tsxRegister.js
  "test/components/*.test.js"` per `package.json`'s `test` script, since
  `src/utils/logger.ts` is a `.ts` module the tsxRegister loader can
  `require()` directly — confirm this by checking how an existing test in
  `test/components/` imports a plain `.ts` helper, e.g.
  `test/components/prompts.screenContext.test.js` or similar, and follow the
  same import style before writing this test).
  - Because `logger.ts` holds module-level `cachedLevel`/`levelPromise` state,
    use `node:test`'s module cache reset (or dynamic `require()` with
    `delete require.cache[require.resolve(...)]` before each test /
    `t.beforeEach`) so each test case gets a fresh module instance rather than
    leaking state between cases.
  - **Case A (retry after async fallback)**: stub `globalThis.window.electronAPI`
    (via happy-dom's registered `window`, already set up by `tsxRegister.js`)
    with a `getLogLevel` mock that rejects (or resolves to `undefined`) on its
    first call, then resolves to `"debug"` on a second call. Call
    `logger.debug("first")` (or directly call the exported behavior via
    `logger.logReasoning`) and assert it is *not* forwarded (no
    `window.electronAPI.log` call recorded, since the fallback resolves to
    `"info"` for that call and `debug < info` per `shouldLog`). Then call
    `logger.debug("second")` (a distinct call) and assert `getLogLevel` was
    invoked a second time and that `window.electronAPI.log` *was* called this
    time with the debug-level entry — proving the module retried instead of
    staying stuck at `"info"`. This is a regression test: it fails against
    today's code (second call would still be swallowed, since `cachedLevel`
    would already be latched to `"info"` from the first call) and passes after
    the fix.
  - **Case A2 (retry after synchronous/no-await fallback — required, do not
    skip)**: repeat the same two-call shape as Case A, but for the first call
    make the fallback path never suspend at an `await` at all — either delete/
    unset `window.electronAPI.getLogLevel` entirely (so
    `window.electronAPI?.getLogLevel` is falsy) or make it a function that
    **throws synchronously** (not an async function that rejects) — then
    restore/replace `window.electronAPI` (or just `getLogLevel`) before the
    second call so it resolves to `"debug"`. Assert the same outcome as Case
    A: the second, distinct call must still re-invoke `getLogLevel` and get
    forwarded at debug level. This case exists specifically because a fix that
    only resets `levelPromise` *inside* the inner async IIFE (rather than in
    the outer `resolveLogLevel()` scope, after awaiting) passes Case A but
    fails Case A2 — the IIFE runs fully synchronously on these paths (no
    `await` reached before its `return`), so its internal `levelPromise = null`
    write is clobbered by the outer `levelPromise = (async () => {...})()`
    assignment that runs immediately afterward. Case A2 is the test that
    actually locks out that specific wrong implementation; Case A alone does
    not, since the IPC-invoke path it exercises always suspends at a real
    `await` and happens to work either way.
  - **Case B (successful resolution still caches)**: stub `getLogLevel` to
    resolve to `"debug"` on the very first call. Call `logger.debug(...)`
    twice and assert `getLogLevel` was only invoked **once** (proving the
    success path still memoizes as before — no behavior regression on the
    happy path) and both calls were forwarded via `window.electronAPI.log`.
  - Assert behavior via the observable `window.electronAPI.log` invocation
    count/arguments (i.e., whether a debug log was actually forwarded) rather
    than reaching into `logger.ts`'s private `cachedLevel`/`levelPromise`
    module state directly, since those aren't exported — this keeps the test
    robust to internal refactors as long as the observable retry behavior
    holds.
- **Manual**: with debug logging enabled (`--log-level=debug` or
  `EKTOSWHISPR_LOG_LEVEL=debug` in `.env`), run one real dictation with Text
  Cleanup (or the dictation/voice agent) enabled against either a local model
  or a cloud provider, then open the newest `debug-*.log` under the app's
  `userData/logs/` directory and confirm a `LOCAL_STREAM_START` (local) or
  `<PROVIDER>_REQUEST` (cloud) line is present and its `meta`/details include
  the full `messages` array (system + user content) — not just an `[INFO]`-only
  renderer log stream. This is the real gate: the IPC-timing race that causes
  the bug is not reliably reproducible in an automated test, so this manual
  step is what actually confirms the fix in a real running app, per repo
  convention ("always run app + summarize after implementing").
- **Docs**: no `CLAUDE.md`/`RECREATION_SPEC.md` section documents this
  internal caching behavior today, so none needs updating once this lands —
  confirmed by grep (no "log level"/"debugLogger"/"logger.ts" hits describing
  `resolveLogLevel`'s caching in either file). `docs/guides/DEBUG.md` describes
  user-facing enable/where-logs-live behavior only, which doesn't change.

## Open Questions

None — the root cause, exact fix location, and validation approach are all
already established from source inspection and the empirical log evidence
above.
