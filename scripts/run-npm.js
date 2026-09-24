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
 * behavior-preserving for user configuration. When invoked from an npm
 * lifecycle script it reuses npm's own `npm_execpath` with the current Node
 * executable, forwarding all args verbatim without a shell (e.g. `node
 * scripts/run-npm.js --prefix client ci`). Used by the lifecycle `setup` /
 * `mcp:install` scripts and by scripts/postinstall.js.
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
 * Spawn the same npm CLI that started the current lifecycle with `args` under a
 * sanitized environment. Invoking its JavaScript entry point through Node
 * avoids both Windows `.cmd` handling and shell argument re-parsing, while
 * remaining available during the initial install before dependencies exist.
 * @param {string[]} args npm argv, e.g. ["--prefix","mcp","ci"]
 * @param {Record<string,string>} baseEnv env to sanitize (usually process.env)
 * @param {import("node:child_process").SpawnSyncOptions} [options] spawn options
 * @returns {ReturnType<typeof spawnSync>}
 */
function runNpm(args, baseEnv, options = {}) {
  const env = baseEnv || process.env;
  const npmExecPath = env.npm_execpath;
  if (!npmExecPath) {
    throw new Error("npm_execpath is unavailable; run this command through an npm lifecycle");
  }
  return spawnSync(process.execPath, [npmExecPath, ...args], {
    ...options,
    stdio: "inherit",
    shell: false,
    env: sanitizeNpmEnv(env),
  });
}

// When run directly (`node scripts/run-npm.js <npm args…>`), forward the
// remaining argv to npm under a sanitized env and mirror its exit status.
if (require.main === module) {
  let result;
  try {
    result = runNpm(process.argv.slice(2), process.env);
  } catch (error) {
    console.error("[run-npm] failed to launch npm:", error.message);
    process.exit(1);
  }
  if (result.error) {
    console.error("[run-npm] failed to launch npm:", result.error.message);
    process.exit(1);
  }
  process.exit(result.status === null ? 1 : result.status);
}

module.exports = { sanitizeNpmEnv, runNpm };
