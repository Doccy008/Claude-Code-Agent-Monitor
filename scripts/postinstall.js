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

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

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

// npm passes its full merged config down to lifecycle children via
// `npm_config_*` env vars — including an `allow-scripts` list the user set in
// their own `.npmrc`. npm rejects that setting when it arrives through env or
// CLI rather than `.npmrc` in a project-scoped install (`EALLOWSCRIPTS`), so
// the nested install inherits a value it cannot use and fails, breaking `npm
// ci` / `npm run setup` for those users. Strip the allow-scripts keys from the
// child's environment; the child still reads the user's and project `.npmrc`
// files directly, so intended behavior (and its security posture) is unchanged.
const childEnv = { ...process.env };
for (const key of Object.keys(childEnv)) {
  if (key.startsWith("npm_config_allow_scripts")) {
    delete childEnv[key];
  }
}

// `shell: true` is required on Windows so npm's `.cmd` shim resolves (Node
// rejects spawning `.cmd`/`.bat` directly since 18.20 / CVE-2024-27980); the
// fixed arg list has no shell-significant characters, so this stays safe.
const result = spawnSync("npm", ["install"], {
  cwd: clientDir,
  stdio: "inherit",
  shell: true,
  env: childEnv,
});

if (result.error) {
  console.error("[postinstall] failed to launch npm for the client install:", result.error.message);
  process.exit(1);
}

process.exit(result.status === null ? 1 : result.status);
