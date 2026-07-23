// Component test for docs/specs/active-window-screen-context.md's
// Requirement 14 UI half: History's expandable "Screen Context Used"
// section. Mirrors the existing "Raw Transcript" expand/collapse pattern in
// `TranscriptionItem.tsx` — hidden/collapsed by default, only shown (and only
// expandable) when `screen_context_text` is non-null.
//
// Run via: node --test --import ./test/setup/tsxRegister.js test/components/*.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const { render, screen, cleanup, fireEvent } = require("@testing-library/react");
const React = require("react");
// TranscriptionItem.tsx doesn't itself import settingsStore/i18n (unlike
// SettingsPage.tsx), so react-i18next's useTranslation() would otherwise see
// an uninitialized i18next instance in this standalone test file (node:test
// runs each file in its own process) and `t()` would just echo back raw keys.
// Import the app's real i18n setup explicitly so assertions can target actual
// (English) translated strings, mirroring how SettingsPage-based component
// tests get this for free via their transitive settingsStore import.
require("../../src/i18n.ts");
const TranscriptionItem = require("../../src/components/ui/TranscriptionItem.tsx").default;

function baseItem(overrides = {}) {
  return {
    id: 1,
    text: "hello world",
    raw_text: "hello world",
    screen_context_text: null,
    timestamp: new Date().toISOString(),
    created_at: new Date().toISOString(),
    has_audio: 0,
    audio_duration_ms: null,
    provider: null,
    model: null,
    status: "completed",
    error_message: null,
    error_code: null,
    client_transcription_id: "abc",
    cloud_id: null,
    sync_status: "synced",
    deleted_at: null,
    ...overrides,
  };
}

function renderItem(item) {
  return render(
    React.createElement(TranscriptionItem, {
      item,
      onCopy: () => {},
      onDelete: () => {},
    })
  );
}

test.afterEach(() => {
  cleanup();
});

test("does not render the screen-context toggle/section when screen_context_text is null", () => {
  renderItem(baseItem({ screen_context_text: null }));
  assert.equal(screen.queryByText("Screen Context Used"), null);
  assert.equal(screen.queryByRole("button", { name: /screen context/i }), null);
});

test("renders a collapsed screen-context toggle when screen_context_text is present, and it's expandable", () => {
  renderItem(baseItem({ screen_context_text: "Visible text from the active window" }));

  // Section content is present in the DOM (mirrors raw_text's pattern of
  // staying mounted, collapsed via max-h-0) but starts collapsed.
  const content = screen.getByText("Visible text from the active window");
  const collapsedWrapper = content.closest(".max-h-0, .max-h-96");
  assert.ok(collapsedWrapper, "expected a collapsible wrapper around the screen-context content");
  assert.ok(collapsedWrapper.classList.contains("max-h-0"), "must start collapsed");

  const toggleButton = screen.getByRole("button", { name: /screen context/i });
  fireEvent.click(toggleButton);

  const expandedWrapper = content.closest(".max-h-0, .max-h-96");
  assert.ok(
    expandedWrapper.classList.contains("max-h-96"),
    "must expand after clicking the toggle"
  );
});

test("renders the screen context text exactly as stored", () => {
  renderItem(baseItem({ screen_context_text: "Some OCR'd text\nwith a newline" }));
  assert.ok(screen.getByText((_, node) => node?.textContent === "Some OCR'd text\nwith a newline"));
});
