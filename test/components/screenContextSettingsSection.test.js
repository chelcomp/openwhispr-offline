// Component test for docs/specs/active-window-screen-context.md's Requirements
// 6/9: the `includeActiveWindowContext` master toggle defaults ON, the
// screen-context Settings section (and therefore its OCR-engine control) is
// hidden entirely on an unsupported platform, and its capture-related
// sub-controls (engine picker, persistence toggle) only render — and only
// let the user opt into further capture-related behavior — when the master
// toggle is on. Exercises the named-exported `ScreenContextSettingsSection`
// from `SettingsPage.tsx` directly, mirroring `dictationVadTabs.test.js`'s
// approach of testing a sub-component in isolation rather than mounting the
// entire settings page.
//
// Run via: node --test --import ./test/setup/tsxRegister.js test/components/*.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const { render, screen, cleanup, waitFor } = require("@testing-library/react");
const React = require("react");
const { ScreenContextSettingsSection } = require("../../src/components/SettingsPage.tsx");
const { useSettingsStore } = require("../../src/stores/settingsStore.ts");

function makeElectronApiStub({ supported = true } = {}) {
  return {
    getActiveWindowContextPlatformSupport: () => Promise.resolve({ supported }),
    getTesseractOcrStatus: () =>
      Promise.resolve({ supported: true, downloaded: true, downloading: false }),
    onTesseractOcrDownloadProgress: () => () => {},
    downloadTesseractOcrAssets: () => Promise.resolve(),
  };
}

function renderSection(props = {}, { supported = true } = {}) {
  global.window.electronAPI = makeElectronApiStub({ supported });
  return render(
    React.createElement(ScreenContextSettingsSection, {
      includeActiveWindowContext: true,
      setIncludeActiveWindowContext: () => {},
      screenContextOcrEngine: "auto",
      setScreenContextOcrEngine: () => {},
      persistActiveWindowScreenshots: false,
      setPersistActiveWindowScreenshots: () => {},
      ...props,
    })
  );
}

// Flushes any pending microtasks (e.g. the component's own
// getTesseractOcrStatus()/getActiveWindowContextPlatformSupport() effect
// promises) before `cleanup()` tears down the DOM — otherwise a `.then()`
// resolving after unmount can fire once `node:test`/happy-dom's globals are
// already torn down between tests, surfacing as a stray "ReferenceError:
// window is not defined" attributed to an unrelated, already-finished test.
async function flushPendingMicrotasks() {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

test.afterEach(async () => {
  await flushPendingMicrotasks();
  cleanup();
  delete global.window.electronAPI;
});

test("includeActiveWindowContext defaults to true in the settings store", () => {
  // Requirement 6: master toggle defaults ON — a store-level fact, not a
  // component prop, so assert it against the store's own default state
  // rather than a rendered checkbox.
  const state = useSettingsStore.getState();
  assert.equal(
    state.includeActiveWindowContext,
    true,
    "includeActiveWindowContext must default to true (Requirement 6)"
  );
});

test("renders the screen-context section (including the OCR-engine control) when the platform is supported", async () => {
  renderSection({}, { supported: true });

  await waitFor(() => {
    assert.ok(screen.queryByText("Screen Context"));
  });
  assert.ok(screen.getByText("OCR Engine"));
});

test("renders nothing (section hidden entirely) on an unsupported platform, per Requirement 9", async () => {
  const { container } = renderSection({}, { supported: false });

  await waitFor(() => {
    assert.equal(container.innerHTML, "");
  });
  assert.equal(screen.queryByText("Screen Context"), null);
  assert.equal(screen.queryByText("OCR Engine"), null);
});

test("hides capture-related sub-controls (OCR engine picker, persistence toggle) when the master toggle is off", async () => {
  renderSection({ includeActiveWindowContext: false }, { supported: true });

  await waitFor(() => {
    assert.ok(screen.queryByText("Screen Context"));
  });
  assert.equal(screen.queryByText("OCR Engine"), null);
  assert.equal(screen.queryByText("Save screenshots to disk"), null);
});

test("shows capture-related sub-controls when the master toggle is on", async () => {
  renderSection({ includeActiveWindowContext: true }, { supported: true });

  await waitFor(() => {
    assert.ok(screen.queryByText("OCR Engine"));
  });
  assert.ok(screen.getByText("Save screenshots to disk"));
});
