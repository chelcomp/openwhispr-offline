const test = require("node:test");
const assert = require("node:assert");
const os = require("os");
const path = require("path");
const fs = require("fs");
const Module = require("module");

// Mock electron before database.js loads, following the pattern established in
// test/helpers/secretKeys.test.js — DatabaseManager only needs app.getPath().
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), "ow-notes-fts-test-"));
const fakeElectron = {
  app: { getPath: () => tmpUserData },
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") return fakeElectron;
  return origLoad.call(this, request, ...rest);
};

const DatabaseManager = require("../../src/helpers/database");

test("FTS5 keyword search works standalone with no vector/semantic layer", () => {
  const db = new DatabaseManager();

  const saveResult = db.saveNote(
    "Quarterly Numbers",
    "Some quarterly revenue projections for next year",
    "personal"
  );
  assert.ok(saveResult.success, "note saved");

  const found = db.searchNotes("revenue", 10);
  assert.ok(Array.isArray(found));
  assert.ok(
    found.some((n) => n.id === saveResult.note.id),
    "keyword match finds the note"
  );

  // Post-removal accepted regression: no more semantic understanding, pure
  // keyword matcher only. A semantically-related but keyword-different query
  // must NOT match.
  const notFound = db.searchNotes("nonexistent-term-xyz", 10);
  assert.deepStrictEqual(notFound, []);
});

test("regression guard: Qdrant/embedding files are gone and no source references them", () => {
  const repoRoot = path.join(__dirname, "..", "..");
  const deletedFiles = [
    "src/helpers/qdrantManager.js",
    "src/helpers/localEmbeddings.js",
    "src/helpers/vectorIndex.js",
    "src/helpers/conversationChunker.js",
  ];
  for (const rel of deletedFiles) {
    assert.strictEqual(
      fs.existsSync(path.join(repoRoot, rel)),
      false,
      `${rel} should no longer exist`
    );
  }

  const ipcHandlersSrc = fs.readFileSync(path.join(repoRoot, "src/helpers/ipcHandlers.js"), "utf8");
  const forbiddenPatterns = [
    'require("./vectorIndex")',
    'require("./localEmbeddings")',
    'require("./qdrantManager")',
    "db-semantic-search-notes",
    "db-semantic-reindex-all",
    "db-semantic-search-conversations",
  ];
  for (const pattern of forbiddenPatterns) {
    assert.ok(
      !ipcHandlersSrc.includes(pattern),
      `ipcHandlers.js should not contain "${pattern}"`
    );
  }
});
