# Debug Log File Recreation After External Deletion

## Status
Implemented

> Approved by project owner on 2026-07-23 ("aprovado.. faça").

## TL;DR
- **What's changing**: `src/helpers/debugLogger.js` (main-process debug logger) currently opens its log file's write stream exactly once, in `initializeFileLogging()`. If a user (or antivirus, or a "clear logs" script) deletes the physical log file while the app is still running with debug logging on, the stream holds a dangling handle forever — every subsequent debug log line is silently swallowed, and the file is never recreated on disk.
- **The fix**: before each of the two places that write to the stream, check whether the log file still exists and, if not, recreate the stream (same file path, append mode), creating `logs/` again first if that was removed too.
- **Concrete decisions**:
  - Add one private method, `ensureLogStream()`, called immediately before both existing write sites (the `write()` method and the `console` interceptor installed by `interceptConsole()`).
  - Recreates to the *same* `this.logFile` path — never a new timestamped filename.
  - Recreates the `logs/` directory first (`recursive: true`) in case the whole directory, not just the file, was removed.
  - Ends the stale stream object before opening the new one, so no file descriptor leaks across repeated recreations (its `end()` is async and not guaranteed complete before the new stream opens — handled by the error listener below, not by waiting for it).
  - Hard reentrancy guard: `ensureLogStream()` must never call back into `this.debug()`/`this.info()`/`this.write()`/intercepted `console.*` (that would immediately recurse through the same write path it's being called from). Any marker line it wants to emit goes straight to the freshly-opened stream via a raw `.write()` call, gated by a boolean flag.
  - Every newly-created stream gets an `'error'` event listener that swallows the error and nulls out `this.logStream` — `createWriteStream()` failures (bad permissions, disk full, a Windows delete-pending race with the stream it's replacing) surface asynchronously as stream events, not thrown exceptions, so a bare try/catch around the open call is not enough to guarantee the app never crashes from this.
  - No re-running of `interceptConsole()` or the full `initializeFileLogging()` startup header — `ensureLogStream()` only reopens the handle.
  - No new setting, no new IPC channel, no user-visible behavior change while the file is intact (the check is a cheap `fs.existsSync` per write, only reachable when file logging is already on).
- **Blocking open question**: None — the design is fully specified by the bug report and requires no product decision.
- **Practical impact**: a user who deletes the debug log file mid-session (manually, or via disk cleanup tooling) while `--log-level=debug` is active will see logging resume into a freshly recreated file at the same path, instead of losing all further debug output for that session with no indication anything went wrong.

## Problem / Goal

`DebugLogger` (`src/helpers/debugLogger.js`) opens its log file's `fs.WriteStream` exactly once, inside `initializeFileLogging()`:

```
this.logStream = fs.createWriteStream(this.logFile, { flags: "a" });
```

This happens once per app session (guarded by `this.fileLoggingEnabled`). Two places subsequently write to `this.logStream`:

- `write(level, message, meta, scope, source)` (the logger's core method, called by `debug()`/`info()`/`warn()`/`error()`/etc.) — writes via `if (this.logStream) this.logStream.write(logLine);`
- The `console.*` interceptor installed by `interceptConsole()` — writes via `self.logStream.write(...)` inside the closure returned by `makeInterceptor`.

Node's `fs.WriteStream` does not track whether the underlying file still exists on disk once opened; it holds a file descriptor from the original `open()` call. If the log file is deleted while the stream is still open (user deletes it by hand, an AV/cleanup tool removes it, `logs/` itself is wiped), writes to that stream **still succeed at the Node API level** (no error is thrown) but the OS silently drops them — on POSIX the descriptor points to an unlinked inode; the effect on Windows is equivalent (writes go nowhere useful once the file handle is orphaned) — while the deleted file is never recreated on disk. The user gets a debug session with a real `--log-level=debug` flag active and functioning `console`/`write()` calls that appear to succeed, but no log file to inspect afterward, and no error surfaced anywhere.

Goal: whenever the logger is about to write and file logging is active, verify the target file still exists and — if not — transparently recreate it (and its parent directory) at the same path, so debug logging is self-healing across an external deletion without requiring an app restart.

## Requirements

- R1: Add a private method `ensureLogStream()` on `DebugLogger` that is called immediately before every stream write, at both existing write sites (`write()`'s `this.logStream.write(logLine)` call, and the interceptor closure's `self.logStream.write(...)` call inside `interceptConsole()`).
- R2: `ensureLogStream()` must be a no-op whenever file logging is not active — i.e. when `this.fileLoggingEnabled` is falsy or `this.logFile` is unset. It must not attempt to enable file logging itself (that remains `initializeFileLogging()`/`ensureFileLogging()`'s job) and must not throw if called before file logging has ever been initialized.
- R3: When file logging is active, `ensureLogStream()` must recreate the stream whenever `this.logStream` is missing (falsy) OR the file at `this.logFile` no longer exists on disk (`!fs.existsSync(this.logFile)`). When the file exists and a stream is already open, `ensureLogStream()` must do nothing beyond the existence check (cheap no-op path).
- R4: Recreation must target the exact same path already stored in `this.logFile` — never generate a new timestamped filename. This preserves the invariant that `getLogPath()` keeps returning a stable, predictable path for the whole app session.
- R5: Recreation must first ensure the parent `logs/` directory exists (recreating it with `recursive: true` if the whole directory was removed, not just the file), mirroring the same directory-creation step `initializeFileLogging()` already performs, before opening the new write stream with append (`"a"`) flags.
- R6: Before opening the replacement stream, any existing (stale) `this.logStream` reference must be ended, so repeated recreation events don't leak file descriptors/stream objects over a long-running session.
- R6a: Every stream created by `ensureLogStream()` must have an `'error'` event listener attached that swallows the error and sets `this.logStream = null`, so that an asynchronous failure to (re)open the file (permissions, disk full, a Windows delete-pending race with the stream being replaced) degrades to the existing "no stream → writes silently no-op" behavior instead of crashing the process via an unhandled stream `'error'` event.
- R7: `ensureLogStream()` (and anything it calls) must never re-enter the logger's own write path — it must not call `this.debug()`, `this.info()`, `this.write()`, `this.log()`, or the currently-intercepted `console.*` methods, directly or indirectly. Any diagnostic marker line about the recreation event must be written directly to the newly-opened `this.logStream` via a raw `.write()` call, and only under a boolean guard flag (e.g. `this._ensuringStream`) that short-circuits any reentrant call into `ensureLogStream()` itself while one recreation is in progress.
- R8: `ensureLogStream()` must not re-run `interceptConsole()` (console patching stays a one-time, already-completed step tracked by `this._consoleIntercepted`) and must not re-emit `initializeFileLogging()`'s startup header (`"Debug logging enabled"` / `"System Info"` block) — it only reopens the file handle.
- R9: No change to log-level resolution/gating (`resolveLogLevel()`, `refreshLogLevel()`, `shouldLog()`), line formatting/timestamps, `close()`, or any public method signature. The only new surface is the private `ensureLogStream()` method and its two call sites.

## Non-goals

- Not changing where the log file lives, its naming scheme (`debug-<timestamp>.log`), or its rotation policy (there is none today, and none is being added here — the existing gap around debug-log retention noted in CLAUDE.md's Data Retention premises is separate scope, not touched by this fix).
- Not adding a new user-facing setting or IPC channel; recreation is fully internal and silent (aside from the optional marker line written directly into the recreated file itself).
- Not adding throttling/debouncing around the per-write `fs.existsSync` check — debug logging is opt-in and off the idle-budget hot path (see "Non-Negotiable Product Premises compliance" in Design below); add this only if a later, evidence-based report shows it matters.
- `close()` is explicitly out of scope and unchanged. Note one resulting edge case as accepted, not a bug: `close()`'s own `this.log("Debug logger closing")` call goes through `write()` → `ensureLogStream()` like any other log call, so if the file was deleted right before shutdown, the final "closing" line causes a legitimate recreation of the file (containing just that one line) rather than being silently dropped. This is consistent with the fix's intent and does not need special-casing.
- Not handling the case where `this.logFile`'s directory is unwritable/permissions-denied with any new user-facing error surfacing — `ensureLogStream()` catches and swallows this (falling back to a disabled `this.logStream = null` state, per Design steps 4e/4f and "Non-Negotiable Product Premises compliance" below) rather than crashing the app, but no toast/notification/IPC event is added to tell the user their debug log stopped working.

## Design

### Overview

`DebugLogger` gains one new private method, `ensureLogStream()`, and two new call sites for it — immediately before each of the two places that currently write to `this.logStream`. No other method changes.

### `ensureLogStream()` behavior, in order

1. **Early exit**: if `this.fileLoggingEnabled` is falsy, or `this.logFile` is not set, return immediately — file logging isn't active, nothing to ensure.
2. **Reentrancy short-circuit**: if the guard flag (e.g. `this._ensuringStream`) is already `true`, return immediately — a recreation is already in progress higher up the call stack; do not attempt a nested recreation.
3. **Decide whether recreation is needed**: recreation is required when either `this.logStream` is falsy, or `fs.existsSync(this.logFile)` is `false`. If neither condition holds (stream exists and file exists), return immediately — this is the steady-state, cheap-check-only path required by R3/R6.
4. **Recreate**, with the guard flag set for the duration of this block (cleared in a `finally`, so any thrown error during recreation still releases the guard):
   a. If a stale `this.logStream` reference exists, end it (release the old handle) before proceeding.
   b. Ensure the parent directory of `this.logFile` exists, recreating it recursively if it was removed.
   c. Open a new write stream to the same `this.logFile` path in append mode, assign it to `this.logStream`.
   d. Optionally, write a single raw marker line directly to the newly-opened stream object (not through any logger method) noting that the log file was recreated after external deletion, with a timestamp — this is the only logging of the event, and it must not route through `write()`/`debug()`/`console`.
   e. Wrap the *synchronous* part of steps (a)-(d) — directory creation and the `createWriteStream()` call itself — in a try/catch mirroring `initializeFileLogging()`'s existing catch pattern: on a synchronous failure (e.g. `mkdirSync` throwing), leave `this.logStream` as `null` rather than letting the exception escape `ensureLogStream()`.
   f. **`createWriteStream()`'s own failures are asynchronous, not synchronous** — a bad path, a permissions problem, a disk-full condition, or (on Windows specifically) reopening a path whose previous handle is still mid-`end()` (see the Windows delete-pending note below) surface as an `'error'` **event** on the returned stream object some time after `createWriteStream()` returns, not as a thrown exception the try/catch in (e) can catch. The design must therefore attach an `.on('error', ...)` listener to every stream `ensureLogStream()` creates, whose handler swallows the error (no rethrow, no crash) and sets `this.logStream = null` so subsequent writes fall back to today's existing "no stream → no-op" behavior via the `if (this.logStream)` / `if (self.logStream)` guards at the call sites. This listener is what actually makes the "never crash the app" guarantee in Non-Negotiable Premise §5 true — a try/catch alone is not sufficient, since an unhandled `'error'` event on a stream with no listener is a Node uncaught exception (process-crashing) by default.
   g. **Ordering note on ending the stale stream (step a)**: `this.logStream.end()` is itself asynchronous — it does not guarantee the underlying file descriptor is closed by the time step (c) opens a new stream to the same path. On most platforms this is harmless (the OS allows multiple open handles to the same path), but it means step (a) should be treated as "signal the old stream to close" rather than "guaranteed closed before step (c) runs" — the `'error'` handler from (f) is the safety net if reopening races the old handle's teardown, not a guarantee this spec relies on eliminating.

### Call sites

- In `write()`, call `this.ensureLogStream()` immediately before the existing `if (this.logStream) { this.logStream.write(logLine); }` block (i.e. right after the console-forwarding block, before the file-write guard). The existing `if (this.logStream)` check remains as-is afterward, since recreation can still leave `this.logStream` null on failure per step 4e.
- In `interceptConsole()`'s `makeInterceptor` closure, call `self.ensureLogStream()` immediately before the existing `if (self.logStream) { self.logStream.write(...) }` block, same reasoning.

### What does not change

- `initializeFileLogging()` — unchanged; it remains the one-time (per session) path that first turns file logging on, picks the timestamped filename, and emits the startup header. It does not need to call `ensureLogStream()` itself since it already creates the stream fresh.
- `ensureFileLogging()`, `resolveLogLevel()`, `refreshLogLevel()`, `shouldLog()`, `getLogPath()`, `close()`, `restoreConsole()` — unchanged.
- File naming scheme, timestamp format, log line format — unchanged.
- `interceptConsole()` itself (the one-time patch of `console.log`/`warn`/`error`/`info`) — unchanged; `ensureLogStream()` never re-invokes it.

### Non-Negotiable Product Premises compliance

- **§2 Performance (idle budget)**: no change to idle-time behavior — debug logging is off by default (`--log-level=debug`/`EKTOSWHISPR_LOG_LEVEL=debug` opt-in only), so the added `fs.existsSync` check per write only executes when a user has explicitly turned on verbose logging, which is already outside the idle-budget hot path this premise targets.
- **§3 Speed (sub-500ms transcription)**: not touched — `debugLogger` writes are already off the transcription critical path; this change doesn't add any new call into that path.
- **§5 Graceful degradation**: a failed recreation attempt (e.g. permissions issue, disk full, a Windows delete-pending race — see Design step 4f/4g) is caught — synchronous failures via try/catch, asynchronous `createWriteStream` failures via a required `'error'` event listener on every stream `ensureLogStream()` creates — and leaves `this.logStream` as `null`, falling back to today's already-existing "logging silently no-ops" behavior rather than crashing the process via an unhandled stream `'error'` event. The app's core function is never put at risk by a logging subsystem failure.
- **§6 Migration safety**: not applicable — no settings key, schema, or persisted file format changes; the log file's path/naming scheme is identical before and after this fix.
- **§7 Data retention**: not applicable — this fix doesn't change retention policy for debug logs (still no rotation/auto-expiry, a separate known gap); it only makes the existing file more likely to actually exist as expected during a session.

## Validation Plan

### Automated

Add a new test file `test/helpers/debugLoggerRecreate.test.js`, run with `node --test` (already covered by the `test/helpers/*.test.js` glob in `npm test`).

Follow the existing electron-stubbing pattern used by `test/helpers/audioStorage.test.js` (stub `require("electron")` via `Module._load` interception before requiring the module under test, pointing `app.getPath("userData")` at a fresh `fs.mkdtempSync` temp directory). Two important deltas from that existing pattern, specific to `debugLogger.js`'s actual requirements — verify these empirically while writing the test, don't assume the audioStorage stub is sufficient as-is:

- `initializeFileLogging()` returns early without creating a stream if `app.isReady()` is falsy, and separately calls `app.getAppPath()` for the startup "System Info" log line. The fake `electron` module must therefore provide `app.isReady: () => true` and `app.getAppPath: () => <some string>` in addition to `getPath`, or initialization will either no-op or throw partway through (caught internally, leaving `fileLoggingEnabled` false) — either failure mode would make the test pass without exercising the real code path. Confirm via the test itself that `fileLoggingEnabled` becomes `true` and `getLogPath()` returns a non-null path after triggering initialization, before proceeding to the deletion scenario.
- `debugLogger` is a module-level singleton (constructed once at `require` time) whose log level is resolved once in its constructor from `process.argv`/`EKTOSWHISPR_LOG_LEVEL`/`LOG_LEVEL`. The test must set `process.env.EKTOSWHISPR_LOG_LEVEL = "debug"` (or set `process.argv` to include `--log-level=debug`) *before* `require("../../src/helpers/debugLogger")` runs, then call `ensureFileLogging()` (or make any `debug()`/`info()` call, which internally attempts init) to turn file logging on. Since it's a singleton shared across all test cases in the file, read the current log path via `getLogPath()` in each case rather than assuming a fresh instance — don't try to re-`require` a second independent instance.

**Async-flush requirement (applies to every case below)**: `debugLogger` writes through an async `fs.WriteStream`, unlike the synchronous `fs.writeFileSync` calls the `audioStorage.test.js` pattern being borrowed from uses. A logging call (`debugLogger.info(...)`, etc.) returns before the underlying `write()`/`open()` has necessarily flushed to disk, and the recreation path adds two more async operations in front of that (ending the stale stream, opening the new one) before a write actually lands. Do not assert on file contents immediately after a logging call with a bare synchronous `fs.readFileSync`/`fs.existsSync` — that races the flush and will produce an intermittent, timing-dependent failure that looks like a broken fix rather than a flaky test. Instead, each assertion must wait for the write to actually land: either capture the `WriteStream.write()` callback / listen for the stream's `'drain'`/`'finish'` event around the write under test, or poll (short interval, bounded total timeout) until `fs.existsSync(logFilePath)` is true and `fs.readFileSync(logFilePath, "utf8")` contains the expected line, then assert. Since `ensureLogStream()` is invoked internally by `debugLogger`'s own methods rather than being called directly by the test, polling-until-contains is the simpler option and should be preferred unless the executor finds a clean way to hook the internal stream's events from the test.

Required test cases:

1. **File deleted mid-session, single file removed**: with file logging enabled (temp dir, debug level), call a logging method (e.g. `debugLogger.info("line one")`), then poll/wait per the async-flush requirement above until the file exists and contains "line one". Then `fs.unlinkSync(logFilePath)` to simulate external deletion. Call a logging method again (e.g. `debugLogger.info("line two")`). Assert, waiting per the async-flush requirement: (a) the file exists again at the same path (`getLogPath()` unchanged), and (b) its contents include "line two" (the second write actually landed, proving the recreated stream is live, not just an empty file).
2. **Entire `logs/` directory removed**: same setup, but instead of unlinking just the file, `fs.rmSync(logsDir, { recursive: true, force: true })` to remove the whole parent directory. Write again via a logging method. Waiting per the async-flush requirement, assert the directory and file both exist again at the same path, and the new write landed in the recreated file.
3. **Steady-state no-op** (regression guard against over-triggering): with the file intact and a stream already open, write two lines back-to-back without any deletion in between; wait for both to flush and assert both land in the same file with no unexpected duplicate recreation-marker lines between them (i.e. recreation logic doesn't fire when nothing was deleted).
4. **No reentrancy/infinite loop**: assert that triggering a recreation (case 1 or 2 above) completes and returns normally — i.e. the test itself terminates without needing a timeout/hang workaround, and any polling loop used for the async-flush requirement above has a bounded timeout (fails loudly rather than hanging the test runner) so a real regression to an infinite write→ensure→recreate→write recursion shows up as a clear timeout failure, not a stuck CI job. This is documented in a comment as guarding specifically against the write → ensureLogStream → recreate → (accidental) this.debug(...) → write → ... recursion described in the bug report.

Document in the test file, as a comment, that case 1's core premise — `fs.existsSync()` reporting `false` after `fs.unlinkSync()` on an open, still-referenced file handle — is empirically verified by this test on the CI/dev platform it runs on (this repo's primary/CI platform is Windows). On Windows specifically, the mechanism is "delete-pending": `fs.unlinkSync` on a file with an open handle doesn't remove it immediately, it marks it pending deletion until the last handle closes, after which `existsSync` starts reporting `false` — running the test on Windows is what actually exercises this path realistically, including the race where `ensureLogStream()` reopens the same path while the old handle's `end()` is still tearing down (see Design step 4g), which is exactly why the `'error'`-event handler in Design step 4f exists as the safety net. If `existsSync()` were ever observed to still report `true` well past a reasonable poll window on some platform (e.g. a filesystem/OS combination that resolves the check via a stale cached stat rather than a fresh one), the `existsSync`-triggered design in this spec would need to be reconsidered (e.g. switching to an `fs.watch` on the file or catching write errors instead) — the test is deliberately load-bearing on this point, not decorative.

### Manual

1. Launch the app with `--log-level=debug` (or set `EKTOSWHISPR_LOG_LEVEL=debug` in `.env` and restart).
2. Locate the log file (`docs/guides/DEBUG.md`'s "Log File Locations" table — e.g. `%APPDATA%\EktosWhispr\logs\debug-*.log` on Windows).
3. With the app still running, delete that log file directly in a file explorer/terminal.
4. Trigger any action that logs (e.g. press the dictation hotkey, open Settings).
5. Confirm the log file reappears at the same filename/path and contains fresh log lines from step 4 onward (earlier lines from before the deletion are gone, which is expected and fine — recreation is not a backup/restore feature).
6. Repeat, but delete the entire `logs/` folder instead of just the file, and confirm both the folder and file come back the same way.

### Docs

- `CLAUDE.md` §11 ("Debug Mode"): no change required — log file location, naming, and enablement instructions are unchanged; this is an internal resilience fix, not a behavior visible in that section's description.
- `docs/RECREATION_SPEC.md` (its `debugLogger.ensureFileLogging()` reference near §1.2.7, line ~109): no change required for the same reason — the described boot-time behavior (`ensureFileLogging()` called once during `initializeCoreManagers()`) is untouched; only the previously-undocumented "what happens if the file is deleted mid-session" gap is closed, which wasn't described as any particular behavior in either doc before this fix.
- `docs/guides/DEBUG.md`: no change required — file location/enablement instructions remain accurate.

## Open Questions

None. The bug, root cause, and required fix behavior are fully specified by the report this spec is based on.
