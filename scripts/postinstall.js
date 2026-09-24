#!/usr/bin/env node
/**
 * @file postinstall.js
 * @description Root `postinstall` hook: after a bare `npm install` at the repo
 * root, install the React client's dependencies too, so a single root install
 * yields a buildable/runnable tree (the client's fonts and build deps live in
 * `client/package.json`). The step is a safe no-op when the `client/` workspace
 * is absent — production/Docker stages that copy only the root manifest, the
 * MCP image's `file:..` link, and the published tarball all install without a
 * client checkout, and must not fail here. Skipped entirely under
 * `npm install --ignore-scripts` (run `cd client && npm install` manually then).
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const fs = require("fs");
const path = require("path");
const { runNpm } = require("./run-npm.js");

const clientDir = path.join(__dirname, "..", "client");
const clientManifest = path.join(clientDir, "package.json");

// No client checkout in this context (Docker server/MCP stages, packed tarball,
// server-only installs). Nothing to do — succeed quietly so the parent install
// is not broken.
if (!fs.existsSync(clientManifest)) {
  console.log("[postinstall] client/ not present — skipping client dependency install.");
  process.exit(0);
}

console.log("[postinstall] installing client dependencies (client/)...");

// The nested client install would otherwise inherit `npm_config_allow_scripts`
// from the parent lifecycle and fail with EALLOWSCRIPTS for users who have
// allow-scripts set in their global `.npmrc`. Sanitize the child environment
// with the shared helper (see scripts/run-npm.js) — the child still reads the
// user's and project `.npmrc` files directly, so intended behavior is unchanged.

const result = runNpm(["install"], process.env, {
  cwd: clientDir,
});

if (result.error) {
  console.error("[postinstall] failed to launch npm for the client install:", result.error.message);
  process.exit(1);
}

process.exit(result.status === null ? 1 : result.status);
