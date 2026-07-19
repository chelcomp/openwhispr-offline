// Lightweight filler-word filter for the live NVIDIA streaming preview.
// Only affects the cosmetic preview overlay text — never the final
// transcription result, which goes through the normal whisper/parakeet +
// cleanup pipeline untouched.
const FILLER_WORDS = {
  pt: ["ah", "eh", "hã", "é", "tipo", "né", "bom", "então", "assim", "sei lá", "quer dizer"],
  en: ["um", "uh", "er", "erm", "uhh", "umm", "like", "you know", "i mean"],
};

function escapeForRegex(word) {
  return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
}

function buildFillerRegex(language) {
  const words = FILLER_WORDS[language] || FILLER_WORDS.en;
  const alternation = words
    .slice()
    .sort((a, b) => b.length - a.length)
    .map(escapeForRegex)
    .join("|");
  return new RegExp(`(^|[\\s,.;:!?])(?:${alternation})(?=[\\s,.;:!?]|$)`, "giu");
}

function filterFillerWords(text, language) {
  if (!text) return text;
  const baseLanguage = String(language || "en")
    .split("-")[0]
    .toLowerCase();
  const regex = buildFillerRegex(baseLanguage);
  return text
    .replace(regex, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([,.;:!?])(?:\s*[,.;:!?])+/g, "$1")
    .replace(/^[,;:\s]+/, "")
    .trim();
}

module.exports = { filterFillerWords };
