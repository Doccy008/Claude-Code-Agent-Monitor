#!/usr/bin/env node
/**
 * @file run-npm.js
 * @description Shared helper for the repo's nested installs. npm >= 11 rejects
 * an `allow-scripts` setting that reaches a project-scoped install through the
 * environment or CLI (`npm_config_allow_scripts`, which npm re-exports to every
 * lifecycle child, e.g. from the user's own `~/.npmrc`), failing the child with
 * `EALLOWSCRIPTS`. `sanitizeNpmEnv` drops only those inherited keys; because npm
 * always re-reads the user/project `.npmrc` directly, the child keeps the exact
 * same allow-scripts policy from the only source that accepts it, so this is
 * behavior-preserving for user configuration. When invoked directly as a CLI it
 * spawns npm with a sanitized environment, forwarding all args verbatim (e.g.
 * `node scripts/run-npm.js --prefix client ci`). Used by the lifecycle `setup`
 * / `mcp:install` scripts and by scripts/postinstall.js.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const { spawnSync } = require("child_process");

/**
 * Return a copy of `env` with every `npm_config_allow_scripts*` key removed
 * (case-insensitive, per npm's env-var parser). All other keys pass through.
 * @param {Record<string,string>} env
 * @returns {Record<string,string>}
 */
function sanitizeNpmEnv(env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase().startsWith("npm_config_allow_scripts")) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Spawn the npm CLI with `args` under a sanitized environment, inheriting stdio
 * and this process's cwd. `shell: true` is required on Windows so npm's `.cmd`
 * shim resolves (Node rejects spawning `.cmd`/`.bat` directly since 18.20 /
 * CVE-2024-27980); the caller supplies a fixed arg list with no shell-
 * significant characters, so this stays safe.
 * @param {string[]} args npm argv, e.g. ["--prefix","mcp","ci"]
 * @param {Record<string,string>} baseEnv env to sanitize (usually process.env)
 * @returns {ReturnType<typeof spawnSync>}
 */
function runNpm(args, baseEnv) {
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  return spawnSync(npmCmd, args, {
    stdio: "inherit",
    shell: true,
    env: sanitizeNpmEnv(baseEnv || process.env),
  });
}

// When run directly (`node scripts/run-npm.js <npm args…>`), forward the
// remaining argv to npm under a sanitized env and mirror its exit status.
if (require.main === module) {
  const result = runNpm(process.argv.slice(2), process.env);
  if (result.error) {
    console.error("[run-npm] failed to launch npm:", result.error.message);
    process.exit(1);
  }
  process.exit(result.status === null ? 1 : result.status);
}

module.exports = { sanitizeNpmEnv, runNpm };
