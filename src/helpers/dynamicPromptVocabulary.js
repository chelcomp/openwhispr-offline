const { tokenize } = require("../utils/correctionLearner");
const stopwordsData = require("../constants/dynamicVocabularyStopwords.json");

// See docs/specs/dynamic-prompt-vocabulary.md Design → "Persistent stats" for
// the rationale behind these starting constants.
const VOCAB_STATS_HALF_LIFE_DAYS = 14;
const SESSION_WEIGHT = 1.0;
const LONGTERM_WEIGHT = 0.3;
const DEFAULT_MAX_WORDS = 40;

const DEFAULT_STOPWORDS = new Set(
  [
    ...(stopwordsData.en || []),
    ...(stopwordsData.pt || []),
    ...(stopwordsData.universal || []),
  ].map((w) => w.toLowerCase())
);

/**
 * R3a acronym exception: a token whose original (pre-case-folding) casing is
 * fully uppercase, or uppercase+digits, or a leading uppercase/digit run
 * followed by a single trailing lowercase run (e.g. "K8s") is treated as an
 * intentional acronym/technical term and gets a 2-char length floor instead
 * of the ordinary 3-char floor. Must be tested against the token's original
 * casing, never the folded/lowercased form.
 */
function isAcronymLike(originalToken) {
  if (!originalToken) return false;
  // Fully uppercase, or uppercase + digits (API, SQL, AWS, ID, UI, GPT4).
  if (/^[A-Z0-9]+$/.test(originalToken) && /[A-Z]/.test(originalToken)) return true;
  // Mixed forms like "K8s": at least one uppercase letter, no lowercase
  // letters except a single trailing lowercase run that itself follows a
  // digit (e.g. "K8s" -> "K8" + "s").
  if (/^[A-Z0-9]+[a-z]{1,3}$/.test(originalToken)) {
    const upperDigitPrefix = originalToken.match(/^[A-Z0-9]+/)[0];
    if (/[A-Z]/.test(upperDigitPrefix) && /\d/.test(upperDigitPrefix)) return true;
  }
  return false;
}

function hasLetters(token) {
  return /\p{L}/u.test(token);
}

function isNumericOnly(token) {
  return /^[\p{N}]+$/u.test(token);
}

/**
 * Tokenizes `text` and applies R3a-R3c filters (length/acronym floor,
 * numeric-only rejection, stopword rejection). Returns the surviving tokens
 * in their *original* casing (case-folding for frequency counting/dictionary
 * exclusion happens in scoreVocabulary, per R3e).
 *
 * @param {string} text
 * @param {{stopwords?: Set<string>|string[]}} [options]
 * @returns {string[]}
 */
function extractVocabularyTokens(text, { stopwords } = {}) {
  if (!text || typeof text !== "string") return [];
  const stopwordSet =
    stopwords instanceof Set
      ? stopwords
      : Array.isArray(stopwords)
        ? new Set(stopwords.map((w) => w.toLowerCase()))
        : DEFAULT_STOPWORDS;

  const tokens = tokenize(text);
  const survivors = [];

  for (const token of tokens) {
    if (!hasLetters(token)) continue; // R3b: purely numeric / no letters
    if (isNumericOnly(token)) continue;

    const acronym = isAcronymLike(token);
    const minLength = acronym ? 2 : 3;
    if (token.length < minLength) continue; // R3a

    if (stopwordSet.has(token.toLowerCase())) continue; // R3c

    survivors.push(token);
  }

  return survivors;
}

/**
 * Given `rows` (the shape returned by DatabaseManager.getTranscriptions()),
 * tokenizes the configured fields per row, folds case for frequency
 * counting while preserving the most-frequent original-casing variant
 * (R3e), excludes words already in `existingDictionary` (case-insensitive,
 * R3d), and returns a frequency-sorted Array<{word, count}> descending.
 *
 * @param {Array<{text?: string, raw_text?: string, screen_context_text?: string}>} rows
 * @param {{existingDictionary?: string[], includeScreenContext?: boolean, stopwords?: Set<string>|string[]}} [options]
 * @returns {Array<{word: string, count: number}>}
 */
function scoreVocabulary(rows, options = {}) {
  const { existingDictionary = [], includeScreenContext = false, stopwords } = options;
  const dictSet = new Set(
    (Array.isArray(existingDictionary) ? existingDictionary : []).map((w) => w.toLowerCase())
  );

  const countsByLower = new Map(); // lower -> count
  const casingCountsByLower = new Map(); // lower -> Map<casing, count>

  const record = (token) => {
    const lower = token.toLowerCase();
    if (dictSet.has(lower)) return; // R3d
    countsByLower.set(lower, (countsByLower.get(lower) || 0) + 1);
    if (!casingCountsByLower.has(lower)) casingCountsByLower.set(lower, new Map());
    const casingMap = casingCountsByLower.get(lower);
    casingMap.set(token, (casingMap.get(token) || 0) + 1);
  };

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;
    const fields = [row.text, row.raw_text];
    if (includeScreenContext) fields.push(row.screen_context_text);
    for (const field of fields) {
      if (!field) continue;
      const tokens = extractVocabularyTokens(field, { stopwords });
      for (const token of tokens) record(token);
    }
  }

  const results = [];
  for (const [lower, count] of countsByLower.entries()) {
    const casingMap = casingCountsByLower.get(lower);
    let bestCasing = lower;
    let bestCasingCount = -1;
    for (const [casing, casingCount] of casingMap.entries()) {
      if (casingCount > bestCasingCount) {
        bestCasingCount = casingCount;
        bestCasing = casing;
      }
    }
    results.push({ word: bestCasing, count });
  }

  results.sort((a, b) => b.count - a.count);
  return results;
}

/**
 * Simple exponential decay: a word not seen in HALF_LIFE_DAYS days
 * contributes half its raw count; not seen in 2x HALF_LIFE_DAYS, a quarter.
 *
 * @param {number} count
 * @param {Date|string|number} lastSeenAt
 * @param {{now?: Date, halfLifeDays?: number}} [options]
 * @returns {number}
 */
function recencyScore(count, lastSeenAt, options = {}) {
  if (!count || !lastSeenAt) return 0;
  const now = options.now ? new Date(options.now) : new Date();
  const halfLifeDays = options.halfLifeDays ?? VOCAB_STATS_HALF_LIFE_DAYS;
  const lastSeen = new Date(lastSeenAt);
  const daysSince = (now.getTime() - lastSeen.getTime()) / (1000 * 60 * 60 * 24);
  if (!Number.isFinite(daysSince) || daysSince < 0) return count;
  return count * Math.pow(0.5, daysSince / halfLifeDays);
}

/**
 * Combines the session-window frequency count with the recency-decayed
 * long-term vocabulary_stats signal (R10b). Words present in only one source
 * simply have the other term as 0.
 *
 * @param {number} sessionCount
 * @param {{count: number, last_seen_at: Date|string|number}|null|undefined} longTermStat
 * @param {{now?: Date, halfLifeDays?: number, sessionWeight?: number, longtermWeight?: number}} [options]
 * @returns {number}
 */
function finalScore(sessionCount, longTermStat, options = {}) {
  const sessionWeight = options.sessionWeight ?? SESSION_WEIGHT;
  const longtermWeight = options.longtermWeight ?? LONGTERM_WEIGHT;
  const sessionTerm = (sessionCount || 0) * sessionWeight;
  const longtermTerm = longTermStat
    ? recencyScore(longTermStat.count, longTermStat.last_seen_at, options) * longtermWeight
    : 0;
  return sessionTerm + longtermTerm;
}

/**
 * Builds the final dynamic-vocabulary prompt string: scores `rows`, unions
 * the session-window survivors with any `vocabularyStats` words (so a
 * long-term-frequent word can surface even when absent from the last N
 * rows — R10b's "long-term-frequent-but-stale" tier), applies
 * recency-weighted long-term blending, caps at `maxWords` (R5, default 40),
 * and joins into a comma-separated string identical in shape to the
 * existing dictionary prompt.
 *
 * @param {Array<object>} rows
 * @param {{
 *   existingDictionary?: string[],
 *   includeScreenContext?: boolean,
 *   stopwords?: Set<string>|string[],
 *   maxWords?: number,
 *   vocabularyStats?: Array<{word: string, count: number, last_seen_at: Date|string|number}>,
 *   now?: Date,
 * }} [options]
 * @returns {Promise<string>}
 */
async function buildDynamicVocabularyPrompt(rows, options = {}) {
  const {
    existingDictionary,
    includeScreenContext,
    stopwords,
    maxWords = DEFAULT_MAX_WORDS,
    vocabularyStats,
    now,
  } = options;

  const scored = scoreVocabulary(rows, { existingDictionary, includeScreenContext, stopwords });

  const statsByLower = new Map();
  if (Array.isArray(vocabularyStats)) {
    for (const stat of vocabularyStats) {
      if (stat?.word) statsByLower.set(stat.word.toLowerCase(), stat);
    }
  }

  // R10b's "long-term-frequent but not seen this session" tier requires a
  // word to be able to surface even when it's absent from the session
  // window entirely — union the session-window words with vocabulary_stats
  // words (case-insensitive) rather than only re-weighting session
  // survivors. R3d (dictionary exclusion) is re-applied to the union, since
  // a long-term-stats-only word may have since been added to the dictionary.
  const dictSet = new Set(
    (Array.isArray(existingDictionary) ? existingDictionary : []).map((w) => w.toLowerCase())
  );
  const sessionCountByLower = new Map(scored.map(({ word, count }) => [word.toLowerCase(), count]));
  const candidateWordsByLower = new Map(scored.map(({ word }) => [word.toLowerCase(), word]));
  if (Array.isArray(vocabularyStats)) {
    for (const stat of vocabularyStats) {
      if (!stat?.word) continue;
      const lower = stat.word.toLowerCase();
      if (dictSet.has(lower)) continue; // R3d
      if (!candidateWordsByLower.has(lower)) {
        candidateWordsByLower.set(lower, stat.word);
      }
    }
  }

  if (candidateWordsByLower.size === 0) return "";

  const candidates = Array.from(candidateWordsByLower.entries()).map(([lower, word]) => ({
    word,
    score: finalScore(sessionCountByLower.get(lower) || 0, statsByLower.get(lower), { now }),
  }));

  candidates.sort((a, b) => b.score - a.score);
  const capped = candidates.slice(0, maxWords);
  return capped.map((c) => c.word).join(", ");
}

module.exports = {
  extractVocabularyTokens,
  scoreVocabulary,
  buildDynamicVocabularyPrompt,
  recencyScore,
  finalScore,
  isAcronymLike,
  VOCAB_STATS_HALF_LIFE_DAYS,
  SESSION_WEIGHT,
  LONGTERM_WEIGHT,
  DEFAULT_MAX_WORDS,
};
