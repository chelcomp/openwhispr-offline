# Remove Qdrant Vector-Database Dependency

## Status
Approved

Approved directly by the project owner in conversation ("faça a remoção do qdrant", alpha-stage context confirmed) — not inferred by any subagent.

## Problem / Goal

EktosWhispr currently ships a Qdrant sidecar (Rust binary), a local ONNX text-embedding path
(`all-MiniLM-L6-v2`), and a hybrid FTS5+vector "Reciprocal Rank Fusion" search used only by the
AI agent's `search_notes` tool (plus a dead conversation-search code path, see below). The project
owner wants this entire dependency removed: local search should revert to FTS5 keyword search
only, which already exists today as the fallback tier and needs no new code to become the sole
tier.

Verified scope (current code, not assumptions):

- `src/helpers/qdrantManager.js` — Qdrant sidecar process manager (spawn, health-check, stop).
  Port range 6333–6350, storage at `~/.cache/ektoswhispr/qdrant-data/`.
- `src/helpers/localEmbeddings.js` — wraps the ONNX worker's `text.load`/`text.embed` requests to
  embed text with `all-MiniLM-L6-v2` (384-dim). Model resolved from (in order) the packaged
  `resourcesPath/bin/all-MiniLM-L6-v2/`, the dev-tree `resources/bin/all-MiniLM-L6-v2/`, or
  `~/.cache/ektoswhispr/embedding-models/all-MiniLM-L6-v2/`.
- `src/helpers/vectorIndex.js` — singleton wrapping `@qdrant/js-client-rest`. Manages **two**
  collections: `notes` (used by the agent's note search) and `conversation_chunks` (intended for
  agent-conversation search — see dead-code finding below). Depends on
  `src/helpers/conversationChunker.js` for the latter.
- `scripts/download-qdrant.js` (downloads the Qdrant binary per platform/arch) and
  `scripts/download-minilm.js` (downloads `model.onnx` + `tokenizer.json` from HuggingFace).
- The `@qdrant/js-client-rest` npm dependency (`package.json`, `package-lock.json`).
- The semantic-search branch inside `src/services/tools/searchNotesTool.ts` (the actual file —
  not under a `tools/` directory outside `services/`). Today it runs two strategies in order:
  local semantic (RRF, via `window.electronAPI.semanticSearchNotes`) then FTS5 keyword (via
  `window.electronAPI.searchNotes`). After removal it must call FTS5 keyword search directly —
  one strategy, no fallback chain, no RRF.
- `resources/bin/qdrant-*` binaries, `electron-builder.json`'s `extraResources` filter entry
  `"qdrant-*"`, and every `prestart`/`predev`/`predev:main`/`prebuild`/`prebuild:mac`/
  `prebuild:win`/`prebuild:linux`/`prepack`/`predist` npm script in `package.json` that calls
  `npm run download:qdrant` and/or `npm run download:embedding-model`, plus the
  `download:qdrant`/`download:qdrant:all`/`download:embedding-model` script entries themselves.
- `src/helpers/sidecarReaper.js`'s `EXPECTED_BINARY_FRAGMENTS.qdrant` entry, and
  `main.js`'s `sidecarRegistry.register("qdrant", () => qdrantManager.stop())` call site plus the
  `QdrantManager` construction (`main.js:603-609`, including the `global.__qdrantManager` handoff).
  **Decision (settled, see Design §6): delete the reaper entry too — the project owner has
  confirmed full removal, including this fragment, given the app's current alpha stage.**
- Local data directories `~/.cache/ektoswhispr/qdrant-data/` and
  `~/.cache/ektoswhispr/embedding-models/` — see Design §7 for the one-time cleanup mechanism.
- `.gitignore`'s `.qdrant-initialized` line (already-orphaned sentinel — grep confirms no code
  references it; safe to delete outright, independent of the rest of this change).

### Dead-code finding (must inform the Design, not be silently "fixed" as a side effect)

`this.vectorIndex` is read in three places in `src/helpers/ipcHandlers.js`
(`db-delete-agent-conversation`, `db-add-agent-message`, `db-semantic-search-conversations`) via
`this.vectorIndex?.isReady?.()`, but **`this.vectorIndex` is never assigned anywhere** — the
`IpcHandlers` constructor (`ipcHandlers.js:354`) only assigns from the `managers` argument, and
`vectorIndex` is not one of them. Every one of those three call sites has always evaluated
`undefined?.isReady?.()` → `undefined` (falsy) at runtime, in every shipped build. Conversation
semantic search (`db-semantic-search-conversations`, `searchConversations()` in `vectorIndex.js`,
the `conversation_chunks` Qdrant collection, `CommandSearch.tsx`'s call to
`semanticSearchConversations`) has therefore **never actually run** — it has silently always
fallen through to `databaseManager.searchAgentConversations()` (FTS5-equivalent keyword search on
conversations). This means removing it is behavior-neutral: no user has ever received a semantic
conversation-search result from this code path.

`src/helpers/conversationChunker.js` (and its test, `test/helpers/conversationChunker.test.js`) has
no other caller besides `vectorIndex.js` — once `vectorIndex.js` is deleted it becomes dead code
and should be deleted too.

## Requirements

- **R1.** Delete `src/helpers/qdrantManager.js`, `src/helpers/localEmbeddings.js`,
  `src/helpers/vectorIndex.js`, `src/helpers/conversationChunker.js`,
  `test/helpers/conversationChunker.test.js`, `scripts/download-qdrant.js`,
  `scripts/download-minilm.js`.
- **R2.** Remove the `@qdrant/js-client-rest` dependency from `package.json` and regenerate
  `package-lock.json` (using Node 26, per CLAUDE.md's lockfile rule).
- **R3.** Remove all `qdrant`/`embedding-model` download steps from every npm script in
  `package.json` (`prestart`, `predev`, `predev:main`, `prebuild`, `prebuild:mac`, `prebuild:win`,
  `prebuild:linux`, `prepack`, `predist`), and delete the
  `download:qdrant`/`download:qdrant:all`/`download:embedding-model` script entries.
- **R4.** Remove the `"qdrant-*"` filter entry from `electron-builder.json`'s `extraResources`
  block, and delete any bundled `resources/bin/qdrant-*` binaries and
  `resources/bin/all-MiniLM-L6-v2/` model files present in the working tree.
- **R5.** `main.js`: delete the `QdrantManager` require/construction, the
  `sidecarRegistry.register("qdrant", ...)` call, the `global.__qdrantManager` assignment, and the
  now-stale `let qdrantManager = null;` declaration and its comment.
- **R6.** `src/helpers/ipcHandlers.js`: delete `_ensureQdrantReady()`, `_asyncVectorUpsert()`,
  `_asyncVectorDelete()`, the `db-semantic-search-notes`, `db-semantic-reindex-all`, and
  `db-semantic-search-conversations` IPC handlers, and every call site of the above (including the
  three dead `this.vectorIndex?.isReady?.()` checks in the agent-conversation handlers and the
  `_asyncVectorUpsert`/`_asyncVectorDelete` calls inside note create/update/delete handlers).
  `db-search-notes` and `db-search-agent-conversations` (plain FTS5/keyword) are untouched and
  remain the sole search paths.
- **R7.** `preload.js`: remove `semanticSearchNotes`, `semanticReindexAll`,
  `onSemanticReindexProgress`, `semanticSearchConversations` bridges.
- **R8.** `src/types/electron.ts`: remove the corresponding `semanticSearchNotes`,
  `semanticReindexAll`, `onSemanticReindexProgress`, `semanticSearchConversations` type
  declarations.
- **R9.** `src/services/tools/searchNotesTool.ts`: replace the two-strategy fallback chain
  (`executeLocalSearch(..., true)` then `executeLocalSearch(..., false)`) with a single direct call
  to `window.electronAPI.searchNotes(query, limit)` (FTS5). Drop the now-meaningless
  `semantic ? " (semantic search)" : ""` suffix in `displayText`. Leave the `useCloudSearch` option
  and `SearchToolOptions` interface untouched — they are pre-existing dead parameters unrelated to
  Qdrant (see Non-goals); do not use this change to also clean those up.
- **R10.** `src/components/chat/useChatStreaming.ts`: `buildRAGContext()` currently gates and calls
  `window.electronAPI.semanticSearchNotes`. Change it to gate on and call
  `window.electronAPI.searchNotes` instead, preserving the existing RAG behavior (inject
  `<note id title>` blocks) but sourced from FTS5 keyword results instead of semantic results.
- **R11.** `src/components/CommandSearch.tsx`: the conversations-mode search branch currently calls
  `window.electronAPI?.semanticSearchConversations?.(query, 20)`. Change it to call
  `window.electronAPI?.searchAgentConversations?.(query, 20)` (mirroring the notes-mode branch a
  few lines below it, which already calls the plain `searchNotes`).
- **R12.** `src/helpers/sidecarReaper.js`: delete the `qdrant: ["qdrant"]` entry from
  `EXPECTED_BINARY_FRAGMENTS` as part of the full removal. See Design §6 for the accepted-risk
  rationale (alpha stage, no meaningful installed base to protect).
- **R13.** Add a one-time, best-effort cleanup that deletes
  `~/.cache/ektoswhispr/qdrant-data/` and `~/.cache/ektoswhispr/embedding-models/` for users
  upgrading from a version that had Qdrant, guarded by a sentinel so it only runs once. See
  Design §7.
- **R14.** Delete the orphaned `.qdrant-initialized` line from `.gitignore` (dead entry, no code
  reference — confirmed via repo-wide grep).
- **R15.** Update `CLAUDE.md`, `docs/RECREATION_SPEC.md`, and `docs/network-allowlist.md` per the
  Validation Plan's Docs subsection.
- **R16.** Do not remove or modify the ONNX utility-process architecture
  (`src/workers/onnxWorker.js`, `src/helpers/onnxWorkerClient.js`), the `onnxruntime-node`
  dependency, or the `speaker.load`/`speaker.extract`/`ping`/`shutdown` handlers and the
  fbank/FFT/mel-filterbank code they depend on. Only the `text.load` and `text.embed` handlers
  (and their associated `textSession`/`textTokenizer`/`buildTextTokenizer`/`tokenizeText`/
  `meanPoolAndNormalize`/`TEXT_EMBED_MAX_TOKENS`/`TEXT_EMBED_DIM` module-level state and helper
  functions in `onnxWorker.js`) are Qdrant/embedding-specific and should be deleted. Verify at
  implementation time that no other current or planned feature calls `text.load`/`text.embed`
  before deleting (this spec's research found none — `localEmbeddings.js` is the only caller of
  record).

## Non-goals

- Do not touch the `useCloudSearch` parameter of `searchNotesTool.ts` or add/remove any actual
  cloud search step — that parameter is pre-existing dead code unrelated to Qdrant (this offline
  fork has no cloud search backend), and removing it is unrelated scope creep for this change.
- Do not change `speaker.load`/`speaker.extract` (speaker diarization embeddings) or fbank
  computation in `onnxWorker.js` — shared infrastructure, out of scope.
- Do not change the `notes_fts`/FTS5 schema, triggers, or `DatabaseManager.searchNotes()` /
  `DatabaseManager.searchAgentConversations()` implementations — they already exist and already
  work standalone; this spec only removes the semantic layer that wrapped them.
- Do not attempt a broader "local data retention policy" review. Only clean up the two
  Qdrant/embedding-model directories this change makes orphaned (R13); no other retention-policy
  work is in scope here.
- No broader `sidecarReaper.js` refactor beyond removing the `qdrant` fragment itself — the other
  entries (`parakeet`, `whisper`, `llama`, `diarization`) and the reaper's general mechanism are
  untouched.

## Design

### 1. Files to delete outright

- `src/helpers/qdrantManager.js`
- `src/helpers/localEmbeddings.js`
- `src/helpers/vectorIndex.js`
- `src/helpers/conversationChunker.js`
- `test/helpers/conversationChunker.test.js`
- `scripts/download-qdrant.js`
- `scripts/download-minilm.js`
- Any `resources/bin/qdrant-*` binary files and `resources/bin/all-MiniLM-L6-v2/` present in the
  working tree (these are build artifacts, not hand-maintained source, but should not ship or
  linger in the repo/working copy).

### 2. `main.js`

Remove:
- `let qdrantManager = null;` (module-level declaration, line ~216).
- The block at lines ~603–609:
  ```
  // Qdrant starts lazily on first semantic search (ensureQdrantReady in ipcHandlers.js).
  const QdrantManager = require("./src/helpers/qdrantManager");
  qdrantManager = new QdrantManager();
  sidecarRegistry.register("qdrant", () => qdrantManager.stop());
  ...
  global.__qdrantManager = qdrantManager;
  ```
  (Confirm no other reference to the `qdrantManager` local or `global.__qdrantManager` remains
  anywhere in `main.js` before deleting the declaration — grep first, since JS hoisting means a
  stray later reference would otherwise silently become `undefined` instead of throwing.)

Add, near the other one-time startup migration checks (see `postMigrationDetector.js` for the
established sentinel-file pattern used in this codebase), a call to the new one-time cleanup
described in Design §7.

### 3. `src/helpers/ipcHandlers.js`

Remove:
- `_ensureQdrantReady()` (lines ~443–458).
- `_asyncVectorUpsert(note)` / `_asyncVectorDelete(noteId)` (lines ~526–542), and every call site:
  the three `_asyncVectorUpsert` calls inside the note-save/update handlers and the three
  `_asyncVectorDelete` calls inside the note-delete handlers (confirmed call sites at the time of
  this research: lines ~1309, ~1361, ~1380 for upsert; ~1481, ~1676, ~1705, ~7255 for delete —
  re-grep at implementation time since line numbers will have shifted after earlier deletions in
  this same file).
- The `db-semantic-search-notes` handler (~1395–1439) and `db-semantic-reindex-all` handler
  (~1441–1452).
- The `db-semantic-search-conversations` handler (~1632–1654).
- The three dead `this.vectorIndex?.isReady?.()` blocks inside `db-delete-agent-conversation`,
  `db-add-agent-message`, and (the now-deleted) `db-semantic-search-conversations` handler bodies —
  these currently no-op today (see Problem/Goal's dead-code finding) so removing them changes
  nothing observable; just delete the dead branches and keep the surrounding
  `databaseManager.*` calls that were always the effective behavior.

Do not touch `db-search-notes` or `db-search-agent-conversations` — these plain-keyword handlers
are the ones everything now routes through.

### 4. `preload.js` / `src/types/electron.ts`

Remove the four bridge functions (`semanticSearchNotes`, `semanticReindexAll`,
`onSemanticReindexProgress`, `semanticSearchConversations`) from `preload.js`, and their matching
type declarations from `src/types/electron.ts` (two locations: the notes-API block around line
~669 and the agent-conversations block around line ~1297).

### 5. Renderer call sites

- `src/services/tools/searchNotesTool.ts`: collapse `execute()` to call `executeLocalSearch(query,
  limit)` once (drop the `semantic` boolean parameter entirely, since there is only one search
  path now), which internally calls `window.electronAPI.searchNotes(query, limit)`. Remove the
  `strategies` array/loop and the try/catch fallback-chain machinery — it's no longer needed with
  a single search path (a single try/catch around the one call, matching the existing
  `catch (error)` message shape, is sufficient). Remove the `" (semantic search)"` suffix from
  `displayText`.
- `src/components/chat/useChatStreaming.ts`: change the guard `if
  (!window.electronAPI?.semanticSearchNotes) return "";` and the call
  `window.electronAPI.semanticSearchNotes(userText, RAG_NOTE_LIMIT)` to use
  `window.electronAPI?.searchNotes` / `window.electronAPI.searchNotes(userText,
  RAG_NOTE_LIMIT)`. No other change to `buildRAGContext()`'s snippet-building logic.
- `src/components/CommandSearch.tsx`: change `window.electronAPI?.semanticSearchConversations?.
  (query, 20)` to `window.electronAPI?.searchAgentConversations?.(query, 20)`.

### 6. `sidecarReaper.js` — remove the `qdrant` fragment (settled decision)

`reapStaleSidecars()` runs at the start of every launch, reads leftover PID-file entries written
by a *previous* run (`userData/sidecar-pids/*.pid`, via `sidecarPidFile.js`), and kills any
still-alive process whose real command line matches `EXPECTED_BINARY_FRAGMENTS[name]` — this is
what safely cleans up a sidecar that didn't get a graceful shutdown (e.g. the app crashed or was
force-killed) on the *previous* run.

This research identified a real edge case: a user upgrading from a pre-removal version could have
a genuinely-orphaned Qdrant process left over from before they updated. If
`EXPECTED_BINARY_FRAGMENTS.qdrant` is deleted in the same release that removes `QdrantManager`,
`reapStaleSidecars()`'s `fragments` lookup returns `undefined` for that leftover `"qdrant"` PID
entry, so the `if (fragments && isProcessAlive(pid))` guard short-circuits and the function falls
straight to `sidecarPidFile.clear(name)` **without killing the process** — the orphaned process
would keep running until the user manually kills it or reboots.

**Decision: delete the `qdrant` fragment anyway, in this change, alongside everything else.** The
project owner has explicitly weighed this tradeoff and accepted it: EktosWhispr is still in alpha,
with no meaningful installed base of users who could be running a pre-removal build with a Qdrant
sidecar already spawned. The residual risk (a handful of alpha testers, at most, ending up with an
unreaped orphaned `qdrant` process after upgrading) is judged smaller than the cost of carrying
special-case reaper code indefinitely for a dependency that no longer exists anywhere else in the
codebase. Delete `qdrant: ["qdrant"]` from `EXPECTED_BINARY_FRAGMENTS` alongside the rest of the
removal — no phased/deferred approach.

**Revisit this if circumstances change**: if this removal ships *after* EktosWhispr reaches a
stable/GA release with a real installed base, the calculus above no longer holds and a future spec
touching `sidecarReaper.js` should re-examine whether a transitional keep-the-fragment period (or
an explicit one-time orphan sweep, independent of the PID-file mechanism) is warranted instead.

### 7. One-time cleanup of orphaned local data directories

Add a small helper (new file, e.g. `src/helpers/qdrantDataCleanup.js`, or inline in `main.js` if
spec-executor judges it too small to warrant a new file — either is acceptable) following the
existing sentinel-file pattern used by `src/helpers/postMigrationDetector.js`:

- Sentinel file: a dedicated marker (e.g. `.qdrant-removed`) written to `app.getPath("userData")`,
  analogous to `postMigrationDetector.js`'s `.bundle-migrated` sentinel.
- On startup, if the sentinel does not exist: best-effort, non-blocking (`fs.rm(..., {recursive:
  true, force: true})`, not `fs.rmSync`, so it never delays app boot) delete of
  `~/.cache/ektoswhispr/qdrant-data/` and `~/.cache/ektoswhispr/embedding-models/`, then write the
  sentinel regardless of whether the directories existed or the delete fully succeeded (matching
  `postMigrationDetector.js`'s "best-effort" comment style — if userData isn't writable, this is
  attempted again next launch, which is acceptable since the delete itself is idempotent).
- This must run unconditionally on all platforms (unlike `postMigrationDetector.js`'s
  `darwin`-only bundle migration) since Qdrant/embedding-model directories exist on every platform.
- Do not gate this on whether the Qdrant binary/model files are actually present — always attempt
  the delete once; `fs.rm` with `force: true` is a no-op if the path doesn't exist.
- Log via `debugLogger` (info level, non-fatal) so it's visible in debug mode but never surfaces to
  the user.

### 8. Package/build wiring

- `package.json`: remove `"@qdrant/js-client-rest": "^1.12.0"` from `dependencies`; remove
  `download:qdrant`, `download:qdrant:all`, `download:embedding-model` script entries; strip
  `&& npm run download:qdrant` and `&& npm run download:embedding-model` (and the
  `-- --for-build` variant used by `prebuild`) from every script listed in Requirements R3.
  Regenerate `package-lock.json` with Node 26 (`nvm exec 26 npm install` per CLAUDE.md's lockfile
  rule) in the same change.
- `electron-builder.json`: remove the `"qdrant-*"` string from the `extraResources[].filter` array
  (currently alongside `whisper-cpp-*`, `sherpa-onnx-*`, etc.).
- `nix/package.nix`: the qdrant mention there (line ~39, a comment: `# libstdc++/libgomp for
  bundled whisper/llama/sherpa/qdrant`) should be updated to drop "qdrant" from the comment list —
  cosmetic, but keep it accurate.
- `.gitignore`: delete the `.qdrant-initialized` line (R14) — confirmed dead already, unrelated to
  the rest of the removal but caught by this research pass.

## Validation Plan

### Automated

- **New test — `test/helpers/searchNotesFts5.test.js`** (or a name spec-executor prefers,
  consistent with existing `test/helpers/*.test.js` conventions): follow the exact
  electron-mocking pattern already established in `test/helpers/secretKeys.test.js` (override
  `Module._load` to return a fake `{ app: { getPath: () => <tmp dir> } }` for `require("electron")`
  before requiring `src/helpers/database.js`). Then:
  1. Instantiate `DatabaseManager` (its constructor auto-runs `initDatabase()` against the fake
     `userData` path — no explicit `.init()` call needed).
  2. Call `saveNote("Quarterly Numbers", "Some quarterly revenue projections for next year",
     "personal")` (or equivalent signature) to insert a note.
  3. Call `searchNotes("revenue", 10)` and assert the note is returned (proves FTS5 keyword search
     works standalone, with no vector/semantic layer involved).
  4. Call `searchNotes("nonexistent-term-xyz", 10)` and assert an empty array (keyword search
     correctly returns no results for unrelated terms — this is the "no more semantic
     understanding" behavior change worth pinning down: `search_notes` after this change is a pure
     keyword matcher only, e.g. "financial forecast" will **not** match a note about "revenue
     projections" the way semantic search used to; document this explicitly as an expected,
     accepted regression in the PR description, not something to "fix").
  5. Regression guard, in the same test file: assert none of `src/helpers/qdrantManager.js`,
     `src/helpers/localEmbeddings.js`, `src/helpers/vectorIndex.js`,
     `src/helpers/conversationChunker.js` exist on disk (`fs.existsSync` → `false`), and that
     `fs.readFileSync("src/helpers/ipcHandlers.js", "utf8")` contains no occurrence of
     `require("./vectorIndex")`, `require("./localEmbeddings")`, `require("./qdrantManager")`,
     `db-semantic-search-notes`, `db-semantic-reindex-all`, or `db-semantic-search-conversations`.
     This is what proves "nothing attempts to reach a now-nonexistent Qdrant process/port" and "no
     dangling health-checks" without needing to spin up Electron's IPC layer.
- **Update `npm test`** (`node --test "test/helpers/*.test.js" "test/utils/*.test.js"`) — run the
  full suite after the change; it must stay green with the new test included and
  `conversationChunker.test.js` removed.
- **`npm run typecheck`** (`cd src && tsc --noEmit`) — must pass after editing
  `searchNotesTool.ts`, `useChatStreaming.ts`, `CommandSearch.tsx`, and `electron.ts`.
- **`npm run lint`** — must pass on all touched files.
- Manually grep the final diff for `qdrant`/`Qdrant`/`@qdrant`/`vectorIndex`/`localEmbeddings`
  outside of `docs/` and `CLAUDE.md`'s/`RECREATION_SPEC.md`'s prose (which will still mention it
  historically, per the Docs subsection below) to confirm no stray reference survives in source,
  `package.json`, `package-lock.json`, or `electron-builder.json`.

### Manual

1. Run `npm run predev` (or the platform-appropriate prebuild script) and confirm it completes
   without attempting to download Qdrant or the embedding model, and without erroring on the now
   removed script names.
2. Launch the app in dev mode. Confirm no `qdrant`-related debug log lines appear at any point
   during startup or first use of the AI agent (previously: `"qdrant started successfully"` would
   appear lazily on first semantic search — it must never appear now).
3. Open the AI agent chat, create a note titled "Quarterly Numbers" with content mentioning
   "revenue projections", then ask the agent to search notes for "revenue" — confirm it finds the
   note via `search_notes` (FTS5 keyword match). Then ask it to search for "financial forecast" (a
   semantically-related but keyword-different phrase) — confirm it does **not** find the note,
   which is the expected, accepted post-removal behavior (previously it would have matched via
   semantic search).
4. Confirm the agent conversation search (Command Search / conversation search UI) still finds
   conversations by keyword (`CommandSearch.tsx`'s conversations-mode search).
5. Confirm `~/.cache/ektoswhispr/qdrant-data/` and `~/.cache/ektoswhispr/embedding-models/` are
   absent after a fresh app launch on a machine that previously had them populated by an older
   build (simulate by creating dummy files in both paths before launch, then confirming they're
   gone after one launch, and that a `.qdrant-removed`-style sentinel now exists in the app's
   `userData` directory).
6. Confirm the packaged build (`npm run pack`) does not include any `qdrant-*` binary or
   `all-MiniLM-L6-v2/` model files under the installed app's resources.

### Docs

- **`CLAUDE.md`**:
  - Remove the entire "Local Semantic Search (Qdrant + MiniLM)" section (currently the section
    right after the Helper Modules list, roughly lines 227–266 — covers Architecture, Pipeline,
    Search fallback chain, Storage, Dependencies, Dev setup).
  - In "Helper Modules (src/helpers/)", remove the `qdrantManager.js`, `localEmbeddings.js`, and
    `vectorIndex.js` bullet entries (currently lines 162–164).
  - In "Build Scripts (scripts/)", remove the `download-qdrant.js` and `download-minilm.js`
    entries (currently lines 264–265).
  - In "Non-Negotiable Product Premises" §1 (Privacy), edit the sentence "Existing loopback-only
    sidecars (`cliBridge.js` on ports 8200–8219, the Qdrant sidecar) are already compliant..." to
    drop the Qdrant clause entirely (it no longer exists — currently line 20).
  - In §2 (Performance), edit "New background work should follow the same lazy-spawn approach used
    by `QdrantManager` and the ONNX utility process" to reference only the ONNX utility process
    (currently line 27) — the lazy-spawn precedent for future background work should point to a
    pattern that still exists.
  - In §4 (Single instance), edit the rationale sentence "lazily-owned sidecar ports (Qdrant, ONNX
    worker)" to drop "Qdrant," (currently line 40).
  - In the Testing Checklist, remove the three Qdrant/semantic-search bullets (currently lines
    734–736: "Create a note about...", "Verify Qdrant starts lazily...", "Kill Qdrant process
    manually...").
  - In "Common Issues and Solutions", remove or rewrite item 7 "Local Semantic Search Not Working"
    (currently lines ~778–786) — since the feature no longer exists, either delete the item
    outright (and renumber) or replace it with a one-line note that semantic search was removed
    and `search_notes` is FTS5-only, per the reader's judgment on which reads better in context.
  - Add a line to the top-level narrative (wherever CLAUDE.md's authors judge fits — e.g. a short
    note near "Local Whisper Models" or wherever search is otherwise discussed) stating plainly:
    "`search_notes` is FTS5 keyword search only; there is no local or cloud semantic search in this
    fork."
- **`docs/RECREATION_SPEC.md`**:
  - §0 items 1, 2, and 3 (the three Qdrant/embedding/searchNotesTool divergence entries) describe
    behavior of a subsystem that no longer exists. Do not just delete them — replace their content
    with a short note that the entire local-semantic-search subsystem (Qdrant sidecar, MiniLM
    embeddings, hybrid RRF search) was removed as of this change, pointing to this spec file, and
    that `search_notes`/agent conversation search are now FTS5-only. Keep the "historical
    reference" framing consistent with the rest of §0's intro paragraph.
  - §4 ("Banco de Dados, Notas e Busca Semântica"): remove or rewrite §4.2 (Qdrant Sidecar), §4.3
    (Embeddings Locais ONNX) — but **keep §4.3.1** (the shared ONNX worker architecture
    description), rewriting it to drop the `text.load`/`text.embed` half and keep the
    `speaker.load`/`speaker.extract` half — §4.4 (Índice Vetorial), and §4.5 (Fluxo Híbrido FTS5 +
    Qdrant → RRF). Rewrite §4.6 (`searchNotesTool.ts`) to describe the new single-strategy FTS5
    behavior. Rewrite §4.7 (IPC de Notas e Semântica) to drop the Qdrant replication mention.
    Update the section 4 header/index entry title if "Busca Semântica" no longer applies.
  - §7 (Build/Packaging): remove the `download-qdrant.js`/`download-minilm.js` table rows, the
    qdrant/embedding-model mentions in the `predev`/`prebuild*` script descriptions, the
    `@qdrant/js-client-rest` dependency mention, and the `qdrant-*` `extraResources` mention.
  - The `EXPECTED_BINARY_FRAGMENTS`/`reapStaleSidecars` mention (§1, "sidecar" bullet list) should
    drop the `qdrant: ["qdrant"]` entry from the documented fragment list, matching its removal
    from the source (cross-reference this spec for the accepted-risk rationale, in case a future
    reader wonders why no reaper entry exists for a dependency that once shipped).
- **`docs/network-allowlist.md`**: in the "Required for local model downloads" table, remove "and
  Qdrant binaries" from the GitHub row's Purpose column, and remove "and embedding model downloads"
  from the HuggingFace row's Purpose column (both currently reference Qdrant/MiniLM downloads that
  no longer happen).
- **`docs/README.md`**: no structural change expected (no doc file is being added/removed/moved by
  this spec), but re-check its "Not general documentation" and doc-map bullets in case any of them
  reference Qdrant by name — none were found during this research pass, but re-verify at
  implementation time since the map must stay accurate per its own "Keeping this map accurate"
  rule.

## Open Questions

- **Should the one-time data-directory cleanup (Design §7) also attempt to remove the Qdrant
  binary files themselves from `resources/bin/` on a user's already-installed copy**, or is it
  sufficient that a fresh install/update via the installer simply won't include them going forward
  (electron-builder's `extraResources` filter change handles this for new installs, but an
  in-place auto-update might leave old `resources/bin/qdrant-*` files sitting in the previous
  version's unpacked resources directory until the next full reinstall)? This depends on how
  EktosWhispr's auto-updater (`electron-updater`) handles resource directory replacement on
  update, which is outside this spec's research — flagging for the user/spec-executor to confirm
  the updater's actual behavior before deciding whether extra cleanup logic is needed here or is
  already handled by the updater's own install-directory replacement.
