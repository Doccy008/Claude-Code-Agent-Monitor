/**
 * @file Regression coverage for the EALLOWSCRIPTS fix (#343): the shared
 * sanitizer must drop only `npm_config_allow_scripts*` (any casing) from a
 * nested install's environment while preserving every other `npm_config_*`
 * value and forwarding argv verbatim, and the lifecycle install paths
 * (`setup`, `mcp:install`) plus the root `postinstall` must all route through
 * that single sanitized implementation. Pure Node — no bash or real network —
 * so it runs identically on Windows, macOS, and Linux CI.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const RUN_NPM = path.join(ROOT, "scripts", "run-npm.js");
const { sanitizeNpmEnv } = require(RUN_NPM);

describe("sanitizeNpmEnv", () => {
  it("drops only npm_config_allow_scripts* keys, any casing, preserving the rest", () => {
    const env = {
      npm_config_allow_scripts: "a,b",
      npm_config_allow_scripts_pending: "c",
      NPM_CONFIG_ALLOW_SCRIPTS: "d",
      npm_config_registry: "https://example.invalid",
      npm_config_userconfig: "/tmp/.npmrc",
      PATH: "/bin",
      HOME: "/home/u",
    };
    const out = sanitizeNpmEnv(env);
    for (const [k, v] of Object.entries(env)) {
      if (k.toLowerCase().startsWith("npm_config_allow_scripts")) {
        assert.ok(!(k in out), `expected ${k} to be stripped`);
      } else {
        assert.equal(out[k], v, `expected ${k} to be preserved unchanged`);
      }
    }
  });
});

describe("run-npm.js CLI wrapper", () => {
  // A stub npm writes what it saw (argv + the two npm_config_* sentinels) to a
  // file; the wrapper must spawn this stub (PATH-prepended) and strip only the
  // allow-scripts sentinel. Cross-platform: sh script on POSIX, .cmd batch on
  // Windows, matching the wrapper's own platform-specific command name.
  function runStubNpm() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ccam-run-npm-"));
    const out = path.join(tmp, "npm-seen.txt");
    const isWin = process.platform === "win32";
    if (isWin) {
      fs.writeFileSync(
        path.join(tmp, "npm.cmd"),
        [
          "@echo off",
          "(echo args=%*",
          "echo allow=[%npm_config_allow_scripts%]",
          'echo registry=[%npm_config_registry%]) > "%TEST_OUTPUT_FILE%"',
          "",
        ].join("\r\n")
      );
    } else {
      const stub = path.join(tmp, "npm");
      fs.writeFileSync(
        stub,
        [
          "#!/bin/sh",
          '{ printf "args=%s\\n" "$*";',
          ' printf "allow=[%s]\\n" "$npm_config_allow_scripts";',
          ' printf "registry=[%s]\\n" "$npm_config_registry"; } > "$TEST_OUTPUT_FILE"',
          "",
        ].join("\n")
      );
      fs.chmodSync(stub, 0o755);
    }
    const result = spawnSync(process.execPath, [RUN_NPM, "--prefix", "stubdir", "ci"], {
      env: {
        ...process.env,
        PATH: `${tmp}${path.delimiter}${process.env.PATH}`,
        npm_config_allow_scripts: "sentinel-must-not-leak",
        npm_config_registry: "sentinel-registry",
        TEST_OUTPUT_FILE: out,
      },
    });
    assert.equal(result.status, 0, `wrapper exited ${result.status}: ${result.stderr}`);
    return fs.readFileSync(out, "utf8");
  }

  it("does not leak npm_config_allow_scripts to the spawned npm", () => {
    const seen = runStubNpm();
    const allowLine = seen.split(/\r?\n/).find((l) => l.startsWith("allow=["));
    assert.ok(allowLine, `no allow line recorded in: ${seen}`);
    assert.ok(!allowLine.includes("sentinel-must-not-leak"), `sentinel leaked: ${allowLine}`);
  });

  it("preserves other npm_config_* values and forwards argv verbatim", () => {
    const seen = runStubNpm();
    assert.match(seen, /registry=\[sentinel-registry\]/);
    assert.match(seen, /args=--prefix stubdir ci/);
  });
});

describe("package.json install paths", () => {
  const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts;
  // A bare `npm ci`/`npm install` (optionally with --prefix) at the start of a
  // &&-chain is unsanitized and reintroduces the EALLOWSCRIPTS failure mode.
  const BARE_INSTALL = /(?:^|&&\s*)npm\s+(?:--prefix\s+\S+\s+)?(?:ci|install)\b/;

  it("setup routes every nested install through run-npm.js", () => {
    assert.ok(!BARE_INSTALL.test(scripts.setup), `unsanitized install in setup: ${scripts.setup}`);
    assert.match(scripts.setup, /node scripts\/run-npm\.js ci/);
    assert.match(scripts.setup, /node scripts\/run-npm\.js --prefix client ci/);
    assert.match(scripts.setup, /node scripts\/run-npm\.js --prefix vscode-extension ci/);
  });

  it("mcp:install routes through run-npm.js", () => {
    assert.ok(!BARE_INSTALL.test(scripts["mcp:install"]), "unsanitized install in mcp:install");
    assert.match(scripts["mcp:install"], /node scripts\/run-npm\.js --prefix mcp ci/);
  });

  it("postinstall uses the shared sanitizer instead of a duplicate", () => {
    const src = fs.readFileSync(path.join(ROOT, "scripts", "postinstall.js"), "utf8");
    assert.match(src, /require\("\.\/run-npm\.js"\)/);
    assert.match(src, /env: sanitizeNpmEnv\(process\.env\)/);
  });
});
