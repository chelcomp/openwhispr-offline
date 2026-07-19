const test = require("node:test");
const assert = require("node:assert/strict");

const { processAutoLearnCorrections } = require("../../src/helpers/autoLearnDictionary.js");

/**
 * Minimal in-memory stand-in for DatabaseManager's dictionary surface, mirroring
 * the diff-based upsert semantics of the real setDictionary() closely enough to
 * exercise processAutoLearnCorrections() end-to-end without a real SQLite DB
 * (the DB-level provenance/migration behavior itself is covered separately in
 * test/helpers/dictionaryProvenance.test.js).
 */
function createFakeDatabaseManager(seedRows = []) {
  // rows: [{ word, source, learned_from }]
  const rows = seedRows.map((r) => ({ learned_from: null, ...r }));
  const setDictionaryCalls = [];

  return {
    rows,
    setDictionaryCalls,
    getDictionary() {
      return rows.map((r) => r.word);
    },
    getDictionaryWithProvenance() {
      return rows.map((r) => ({ ...r }));
    },
    setDictionary(words, sourceForNewWords, learnedFromByLowerWord) {
      setDictionaryCalls.push({ words: [...words], sourceForNewWords, learnedFromByLowerWord });
      const existingByLower = new Map(rows.map((r) => [r.word.toLowerCase(), r]));
      for (const word of words) {
        const lower = word.toLowerCase();
        if (existingByLower.has(lower)) continue;
        const learnedFrom =
          sourceForNewWords === "learned" && learnedFromByLowerWord
            ? learnedFromByLowerWord.get(lower) || null
            : null;
        const row = { word, source: sourceForNewWords, learned_from: learnedFrom };
        rows.push(row);
        existingByLower.set(lower, row);
      }
      return { success: true };
    },
  };
}

test("a genuine correction is persisted into the dictionary with learned_from provenance", () => {
  const db = createFakeDatabaseManager([]);

  const result = processAutoLearnCorrections({
    originalText: "Shunade came to visit",
    newFieldValue: "Sinead came to visit",
    databaseManager: db,
  });

  assert.deepEqual(result.learned, ["Sinead"]);
  assert.deepEqual(result.skippedOscillations, []);

  assert.equal(db.setDictionaryCalls.length, 1);
  const call = db.setDictionaryCalls[0];
  assert.ok(call.words.includes("Sinead"));
  assert.equal(call.sourceForNewWords, "learned");
  assert.equal(call.learnedFromByLowerWord.get("sinead"), "Shunade");

  const savedRow = db.rows.find((r) => r.word === "Sinead");
  assert.ok(savedRow, "expected Sinead to be persisted");
  assert.equal(savedRow.source, "learned");
  assert.equal(savedRow.learned_from, "Shunade");
});

test("no correction detected: dictionary is left untouched", () => {
  const db = createFakeDatabaseManager([]);

  const result = processAutoLearnCorrections({
    originalText: "hello world",
    newFieldValue: "hello world",
    databaseManager: db,
  });

  assert.deepEqual(result.learned, []);
  assert.equal(db.setDictionaryCalls.length, 0);
});

test("oscillation guard: exact reverse of a previously-learned correction is skipped", () => {
  // Previously learned: "Sinead" replacing "Shunade" (word="Sinead", learned_from="Shunade").
  const db = createFakeDatabaseManager([
    { word: "Sinead", source: "learned", learned_from: "Shunade" },
  ]);

  // Now the user "corrects" Sinead back to Shunade in a new dictation — the exact reverse pair.
  const result = processAutoLearnCorrections({
    originalText: "Sinead came to visit",
    newFieldValue: "Shunade came to visit",
    databaseManager: db,
  });

  assert.deepEqual(result.learned, []);
  assert.equal(result.skippedOscillations.length, 1);
  assert.deepEqual(result.skippedOscillations[0], { from: "Sinead", to: "Shunade" });

  // The dictionary must not flip back — no setDictionary call, "Sinead" row unchanged.
  assert.equal(db.setDictionaryCalls.length, 0);
  const sineadRow = db.rows.find((r) => r.word === "Sinead");
  assert.equal(sineadRow.learned_from, "Shunade");
});

test("oscillation guard is case-insensitive on both word and learned_from", () => {
  const db = createFakeDatabaseManager([{ word: "sinead", source: "learned", learned_from: "shunade" }]);

  const result = processAutoLearnCorrections({
    originalText: "meeting with Sinead today",
    newFieldValue: "meeting with Shunade today",
    databaseManager: db,
  });

  assert.deepEqual(result.learned, []);
  assert.equal(result.skippedOscillations.length, 1);
  assert.equal(db.setDictionaryCalls.length, 0);
});

test("a non-reverse correction proceeds normally even when unrelated learned rows exist", () => {
  const db = createFakeDatabaseManager([{ word: "Sinead", source: "learned", learned_from: "Shunade" }]);

  const result = processAutoLearnCorrections({
    originalText: "Jonathon signed up",
    newFieldValue: "Jonathan signed up",
    databaseManager: db,
  });

  assert.deepEqual(result.learned, ["Jonathan"]);
  assert.equal(result.skippedOscillations.length, 0);
  const savedRow = db.rows.find((r) => r.word === "Jonathan");
  assert.equal(savedRow.learned_from, "Jonathon");
});

test("propagates a save failure without reporting a learned correction", () => {
  const db = createFakeDatabaseManager([]);
  db.setDictionary = () => ({ success: false, error: "disk full" });

  const result = processAutoLearnCorrections({
    originalText: "Shunade came to visit",
    newFieldValue: "Sinead came to visit",
    databaseManager: db,
  });

  assert.deepEqual(result.learned, []);
  assert.equal(result.error, "disk full");
});
