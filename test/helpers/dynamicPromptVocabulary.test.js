const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const {
  extractVocabularyTokens,
  scoreVocabulary,
  buildDynamicVocabularyPrompt,
  recencyScore,
  finalScore,
  VOCAB_STATS_HALF_LIFE_DAYS,
} = require("../../src/helpers/dynamicPromptVocabulary");

// --- extractVocabularyTokens ---------------------------------------------

test("extractVocabularyTokens drops stopwords, fillers, and short tokens", () => {
  const tokens = extractVocabularyTokens("the uh quick brown fox um jumped");
  assert.ok(!tokens.includes("the"));
  assert.ok(!tokens.includes("uh"));
  assert.ok(!tokens.includes("um"));
  assert.ok(tokens.includes("quick"));
  assert.ok(tokens.includes("brown"));
  assert.ok(tokens.includes("jumped"));
});

test("extractVocabularyTokens drops numeric-only tokens", () => {
  const tokens = extractVocabularyTokens("meeting at 1234 today");
  assert.ok(!tokens.includes("1234"));
  assert.ok(tokens.includes("meeting"));
});

test("extractVocabularyTokens preserves proper-noun casing", () => {
  const tokens = extractVocabularyTokens("I work on Kubernetes clusters");
  assert.ok(tokens.includes("Kubernetes"));
});

// --- R3a acronym-exception regression tests ------------------------------

test("all-uppercase / uppercase+digit short acronyms survive the length floor", () => {
  const tokens = extractVocabularyTokens(
    "Please check the API and the SQL and AWS and ID and UI and GPT4 docs"
  );
  for (const acronym of ["API", "SQL", "AWS", "ID", "UI", "GPT4"]) {
    assert.ok(tokens.includes(acronym), `expected ${acronym} to survive`);
  }
});

test("K8s-style mixed-case acronym forms survive too", () => {
  const tokens = extractVocabularyTokens("We deployed it on K8s yesterday");
  assert.ok(tokens.includes("K8s"));
});

test("lowercase 2-letter fragments and stopword fillers are still dropped", () => {
  const tokens = extractVocabularyTokens("ai ui uh um are just fillers here");
  assert.ok(!tokens.includes("ai"));
  assert.ok(!tokens.includes("ui"));
  assert.ok(!tokens.includes("uh"));
  assert.ok(!tokens.includes("um"));
});

// --- scoreVocabulary ------------------------------------------------------

test("scoreVocabulary ranks by frequency across multiple rows", () => {
  const rows = [
    { text: "Zephyria is our new project", raw_text: "" },
    { text: "Zephyria launches next week", raw_text: "" },
    { text: "Something else entirely", raw_text: "" },
  ];
  const scored = scoreVocabulary(rows);
  assert.equal(scored[0].word, "Zephyria");
  assert.equal(scored[0].count, 2);
});

test("scoreVocabulary excludes words already in the existing dictionary (case-insensitive)", () => {
  const rows = [{ text: "Kubernetes and Zephyria are both mentioned", raw_text: "" }];
  const scored = scoreVocabulary(rows, { existingDictionary: ["kubernetes"] });
  assert.ok(!scored.some((s) => s.word.toLowerCase() === "kubernetes"));
  assert.ok(scored.some((s) => s.word === "Zephyria"));
});

test("scoreVocabulary folds case for counting but returns the most-frequent casing", () => {
  const rows = [
    { text: "kubernetes is great", raw_text: "" },
    { text: "Kubernetes is great", raw_text: "" },
    { text: "Kubernetes is great", raw_text: "" },
  ];
  const scored = scoreVocabulary(rows);
  const entry = scored.find((s) => s.word.toLowerCase() === "kubernetes");
  assert.equal(entry.word, "Kubernetes");
  assert.equal(entry.count, 3);
});

test("scoreVocabulary respects includeScreenContext flag", () => {
  const rows = [{ text: "hello", raw_text: "", screen_context_text: "Zephyria onscreen" }];
  const withoutScreen = scoreVocabulary(rows, { includeScreenContext: false });
  assert.ok(!withoutScreen.some((s) => s.word === "Zephyria"));

  const withScreen = scoreVocabulary(rows, { includeScreenContext: true });
  assert.ok(withScreen.some((s) => s.word === "Zephyria"));
});

// --- buildDynamicVocabularyPrompt -----------------------------------------

test("buildDynamicVocabularyPrompt caps output at maxWords and orders highest-first", async () => {
  const rows = [{ text: "alpha alpha alpha beta beta gamma", raw_text: "" }];
  const prompt = await buildDynamicVocabularyPrompt(rows, { maxWords: 2 });
  const words = prompt.split(", ");
  assert.equal(words.length, 2);
  assert.equal(words[0], "alpha");
  assert.equal(words[1], "beta");
});

test("buildDynamicVocabularyPrompt returns empty string for no-op input", async () => {
  const prompt = await buildDynamicVocabularyPrompt([], {});
  assert.equal(prompt, "");
});

// --- Recency-weighted scoring ---------------------------------------------

test("decay formula halves the raw count exactly at HALF_LIFE_DAYS", () => {
  const now = new Date("2024-01-15T00:00:00Z");
  const lastSeen = new Date(now.getTime() - VOCAB_STATS_HALF_LIFE_DAYS * 24 * 60 * 60 * 1000);
  const score = recencyScore(100, lastSeen, { now });
  assert.ok(Math.abs(score - 50) < 1e-6);
});

test("a recent session word outranks a stale long-term-frequent word", () => {
  const now = new Date("2024-01-15T00:00:00Z");
  const recentSessionScore = finalScore(5, { count: 5, last_seen_at: now }, { now });
  const staleLongTermScore = finalScore(
    0,
    { count: 500, last_seen_at: new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000) },
    { now }
  );
  assert.ok(recentSessionScore > staleLongTermScore);
});

test("a brand-new word with no vocabulary_stats row scores using the session term alone", () => {
  const score = finalScore(4, null);
  assert.equal(score, 4 * 1.0);
});

test("buildDynamicVocabularyPrompt surfaces a long-term-frequent word absent from the session window (R10b tier 2)", async () => {
  const rows = [{ text: "some unrelated recent chatter", raw_text: "" }];
  const vocabularyStats = [{ word: "Zephyria", count: 50, last_seen_at: new Date() }];
  const prompt = await buildDynamicVocabularyPrompt(rows, { vocabularyStats });
  assert.ok(prompt.includes("Zephyria"), "long-term-only word must still surface");
});

test("buildDynamicVocabularyPrompt excludes a long-term-only word that's since been added to the dictionary (R3d re-applied to the union)", async () => {
  const rows = [{ text: "some unrelated recent chatter", raw_text: "" }];
  const vocabularyStats = [{ word: "Zephyria", count: 50, last_seen_at: new Date() }];
  const prompt = await buildDynamicVocabularyPrompt(rows, {
    vocabularyStats,
    existingDictionary: ["zephyria"],
  });
  assert.ok(!prompt.includes("Zephyria"));
});

// --- vocabulary_stats persistence (DB-backed) ------------------------------

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ektoswhispr-vocab-stats-db-"));
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: {
        getPath: () => userDataDir,
        getAppPath: () => process.cwd(),
        isReady: () => false,
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
process.env.NODE_ENV = "test";

const DatabaseManager = require("../../src/helpers/database.js");

function isNativeBindingUnavailable(error) {
  const message = String(error?.message || error);
  return (
    message.includes("NODE_MODULE_VERSION") ||
    message.includes("Could not locate the bindings file")
  );
}

function freshDir() {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ektoswhispr-vocab-stats-db-"));
  return userDataDir;
}

function constructDbManager(t) {
  try {
    return new DatabaseManager();
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }
}

test("recordVocabularyOccurrences accumulates count and updates last_seen_at across simulated sessions", (t) => {
  freshDir();
  const dbManager = constructDbManager(t);
  if (!dbManager) return;

  dbManager.recordVocabularyOccurrences(["Zephyria"]);
  let stats = dbManager.getVocabularyStats();
  let entry = stats.find((s) => s.word === "Zephyria");
  assert.equal(entry.count, 1);
  const firstSeenAt = entry.last_seen_at;

  // Simulate a later session.
  dbManager.recordVocabularyOccurrences(["Zephyria"]);
  stats = dbManager.getVocabularyStats();
  entry = stats.find((s) => s.word === "Zephyria");
  assert.equal(entry.count, 2);
  assert.ok(entry.last_seen_at >= firstSeenAt);

  dbManager.db.close();
});

test("CREATE TABLE IF NOT EXISTS for vocabulary_stats leaves other existing tables/data untouched (migration safety)", (t) => {
  freshDir();
  const first = constructDbManager(t);
  if (!first) return;
  first.saveTranscription("Hello world", "hello world raw");
  first.setDictionary(["foo", "bar"]);
  first.db.close();

  const second = constructDbManager(t);
  if (!second) return;

  const transcriptions = second.getTranscriptions();
  assert.equal(transcriptions.length, 1);
  assert.equal(transcriptions[0].text, "Hello world");

  const dictionary = second.getDictionary();
  assert.deepEqual(dictionary.sort(), ["bar", "foo"]);

  const stats = second.getVocabularyStats();
  assert.deepEqual(stats, []);

  second.db.close();
});
