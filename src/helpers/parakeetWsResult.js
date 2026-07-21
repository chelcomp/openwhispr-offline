function parseOfflineMessage(message) {
  const text = String(message || "").trim();
  try {
    const parsed = JSON.parse(text);
    return typeof parsed?.text === "string" ? parsed.text.trim() : text;
  } catch {
    return text;
  }
}

module.exports = { parseOfflineMessage };
