// Component test for the "Live"/"Voice Activity Detection" tab restructure
// (see docs/specs/vad-settings-tabs.md). Exercises the named-exported
// `DictationVadTabs` from `SettingsPage.tsx` directly, with minimal stub
// render props, rather than mounting the entire `SettingsPage` (which would
// need i18n provider, store, and `electronAPI` stubbing well beyond what
// this interaction test needs).
//
// Note on visibility assertions: `TabPanel` (this file's existing sub-tab
// primitive) keeps the inactive panel mounted in the DOM and toggles a
// Tailwind `hidden` class on its wrapper `<div>`, rather than unmounting it —
// so a plain `queryByText(...) === null` check is NOT a valid "hidden"
// assertion here (the text node is still present, just under a `hidden`
// ancestor). `isEffectivelyHidden()` below walks up to find that wrapper and
// checks its className directly, matching how this component actually hides
// content (see `TabPanel`/`useSubTab` in `src/components/SettingsPage.tsx`).
//
// Run via: node --test --import ./test/setup/tsxRegister.js test/components/*.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const { render, screen, cleanup, fireEvent } = require("@testing-library/react");
const React = require("react");
const { DictationVadTabs } = require("../../src/components/SettingsPage.tsx");

const LIVE_STUB_TEXT = "LIVE_STUB_CONTENT";
const SILERO_STUB_TEXT = "SILERO_STUB_CONTENT";

function renderLiveStub() {
  return React.createElement("div", null, LIVE_STUB_TEXT);
}
function renderSileroStub() {
  return React.createElement("div", null, SILERO_STUB_TEXT);
}

function isEffectivelyHidden(node) {
  let el = node;
  while (el) {
    if (el.classList && el.classList.contains("hidden")) return true;
    el = el.parentElement;
  }
  return false;
}

test.afterEach(() => {
  cleanup();
});

test("renders both tab buttons and defaults to the Live tab's stub content", () => {
  render(
    React.createElement(DictationVadTabs, {
      renderPreviewVadSettings: renderLiveStub,
      renderWhisperVadSettings: renderSileroStub,
    })
  );

  assert.ok(screen.getByText("Live"));
  assert.ok(screen.getByText("Voice Activity Detection"));
  assert.equal(isEffectivelyHidden(screen.getByText(LIVE_STUB_TEXT)), false);
  assert.equal(isEffectivelyHidden(screen.getByText(SILERO_STUB_TEXT)), true);
});

test("clicking the Voice Activity Detection tab shows Silero's stub content and hides Live's", () => {
  render(
    React.createElement(DictationVadTabs, {
      renderPreviewVadSettings: renderLiveStub,
      renderWhisperVadSettings: renderSileroStub,
    })
  );

  fireEvent.click(screen.getByText("Voice Activity Detection"));

  assert.equal(isEffectivelyHidden(screen.getByText(SILERO_STUB_TEXT)), false);
  assert.equal(isEffectivelyHidden(screen.getByText(LIVE_STUB_TEXT)), true);
});

test("when renderWhisperVadSettings is not passed (nvidia/Parakeet), no tab bar renders and only Live's stub content shows", () => {
  render(
    React.createElement(DictationVadTabs, {
      renderPreviewVadSettings: renderLiveStub,
    })
  );

  assert.equal(screen.queryByText("Live"), null);
  assert.equal(screen.queryByText("Voice Activity Detection"), null);
  assert.equal(isEffectivelyHidden(screen.getByText(LIVE_STUB_TEXT)), false);
  assert.equal(screen.queryByText(SILERO_STUB_TEXT), null);
});
