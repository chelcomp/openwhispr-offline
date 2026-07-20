// Thin loader that lets `node --test` execute a `.tsx` component test file.
//
// This repo intentionally has no Jest/Vitest and stays on Node's built-in
// `node --test` runner. There is no TSX transform wired into that runner by
// default, so this file:
//   1. Registers happy-dom's `window`/`document`/etc. as Node globals via
//      `@happy-dom/global-registrator`, *before* any React/ReactDOM import so
//      happy-dom owns the globals first.
//   2. Installs a CommonJS `.tsx` require hook that uses `esbuild.transformSync`
//      (loader: "tsx", jsx: "automatic") to compile TSX to CJS on the fly.
//   3. Unregisters the happy-dom globals in a `node:test` `after()` hook so
//      they never leak into other `node --test` files run in the same
//      process/suite.
//
// Only test files that explicitly `--import` this module (see package.json's
// "test" script) are affected — every other existing `test/helpers/*.test.js`
// file is untouched.

const Module = require("node:module");
const path = require("node:path");
const { after } = require("node:test");
const esbuild = require("esbuild");
const { GlobalRegistrator } = require("@happy-dom/global-registrator");

GlobalRegistrator.register();

function tsxLoader(module, filename) {
  const source = require("node:fs").readFileSync(filename, "utf8");
  const { code } = esbuild.transformSync(source, {
    loader: "tsx",
    jsx: "automatic",
    format: "cjs",
    target: "node26",
    sourcefile: path.basename(filename),
  });
  module._compile(code, filename);
}

Module._extensions[".tsx"] = tsxLoader;
// `.test.jsx` component test files also need this transform (JSX syntax,
// or in some cases plain JS using a .jsx extension for consistency).
Module._extensions[".jsx"] = tsxLoader;
// Plain `.ts` helper modules (no JSX) that a `.tsx` component under test may
// `require()` — e.g. `clipboardCopyFallback.ts` — also need a require hook,
// since Node's default resolution only tries `.js`/`.json`/`.node` plus
// whatever's registered here.
Module._extensions[".ts"] = tsxLoader;

after(async () => {
  await GlobalRegistrator.unregister();
});
